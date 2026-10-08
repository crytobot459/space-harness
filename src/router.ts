// Model fallback across a profile's queue.
//
// The honest version of this feature: opencode has no hook that can change a
// live session's model. `chat.params` only sees temperature and sampling, the
// model on `chat.message` is read-only, and `config` runs once at startup. So
// failover here means two things, and only two:
//
//   1. At startup, if a health file marks the preferred model unhealthy, pick
//      the next healthy profile before the session begins.
//   2. When a request fails, tell the agent plainly that the route is spent and
//      a new session is needed, instead of letting it retry into a wall.
//
// Retry-on-429 is deliberately not attempted. Provider issue #42977 documents
// free models returning FreeUsageLimitError for ten days with no recovery, and
// the maintainers' own guidance is to mark the route unhealthy rather than
// retry it. The daily window resets at 00:00 UTC, so waiting inside a session
// is the wrong shape anyway.

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  loadProfile,
  pruneThreshold,
  profileIdFromConfig,
  reservedTokens,
  resolveEffort,
} from "./profile.js"

interface Health {
  unhealthy: Record<string, { at: string; reason: string }>
  active?: string
}

function healthPath(worktree: string): string {
  return join(worktree, ".space", "health.json")
}

function readHealth(worktree: string): Health {
  try {
    return JSON.parse(readFileSync(healthPath(worktree), "utf8"))
  } catch {
    return { unhealthy: {} }
  }
}

function writeHealth(worktree: string, h: Health) {
  try {
    mkdirSync(join(worktree, ".space"), { recursive: true })
    writeFileSync(healthPath(worktree), JSON.stringify(h, null, 2))
  } catch {
    // Best effort.
  }
}

/** Patterns that mean "this route is spent", not "this request was bad". */
const SPENT = [
  /FreeUsageLimitError/i,
  /rate[_ -]?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /overloaded_error/i,
  /model .*not found/i,
  /no available provider/i,
]

function classify(text: string): string | null {
  for (const p of SPENT) if (p.test(text)) return p.source
  return null
}

const WARN_TEXT =
  "[opencode-harness-kit] This session's model route is rate limited or withdrawn. " +
  "No plugin can swap a live session's model, so stop retrying and ask the human to start a " +
  "new session. Run `oc-harness list` to see the fallback queue, or `oc-harness doctor` to " +
  "check whether the profile still matches live metadata."

export const RouterPlugin: Plugin = async ({ worktree }) => {
  let failedSessions = 0
  let warned = false

  return {
    // Runs once, before the session does any work.
    config: async (config) => {
      try {
        const cfg = config as Record<string, any>
        const health = readHealth(worktree)

        // config.harness is stripped by schema validation, so the active
        // profile comes from the config file on disk.
        const activeId = cfg.harness?.profile ?? profileIdFromConfig()
        if (activeId) {
          const id: string = activeId
          const mark = health.unhealthy[`opencode/${id}`]
          if (mark) {
            // Walk the queue for the first profile that is not marked down.
            let chosen: string | null = id
            try {
              const queue = [id, ...(loadProfile(id).fallback ?? [])]
              for (const candidate of queue) {
                if (!health.unhealthy[`opencode/${candidate}`]) {
                  chosen = candidate
                  break
                }
              }
            } catch {
              // A broken profile must not stop opencode from starting.
            }
            if (chosen !== id) {
              applyProfileToConfig(cfg, chosen)
              health.active = chosen
              writeHealth(worktree, health)
            }
          }
        }
      } catch {
        // Startup must not fail because of the router.
      }
    },

    event: async ({ event }) => {
      const e = event as any
      const type = e?.type
      if (!type) return

      const text = JSON.stringify(e)
      const reason = classify(text)
      if (!reason) return

      // Only mark the model this session is actually using.
      const modelID = e.properties?.modelID ?? e.properties?.model ?? e.properties?.modelID
      const key = modelID ? `opencode/${modelID}` : undefined
      if (!key) return

      const health = readHealth(worktree)
      if (health.unhealthy[key]) return // already recorded, do not spam
      health.unhealthy[key] = { at: new Date().toISOString(), reason }
      writeHealth(worktree, health)
      failedSessions++
    },

    "chat.message": async (input, output) => {
      // If this session has already hit a spent route, say so once, early,
      // instead of letting the agent burn turns discovering it.
      if (failedSessions === 0) return
      if (warned) return
      warned = true

      // Appending to an existing text part avoids fabricating a Part, which
      // needs id/sessionID/messageID this hook has no good source for.
      const parts = output.parts ?? []
      const last = parts[parts.length - 1]
      if (last?.type === "text") {
        last.text = `${last.text}\n\n${WARN_TEXT}`
        return
      }
      // Nothing to attach to: the health file and telemetry still record it.
      writeHealth(worktree, readHealth(worktree))
    },
  }
}

/** Point the config at another profile, including its derived numbers. */
function applyProfileToConfig(cfg: Record<string, any>, profileId: string) {
  try {
    const p = loadProfile(profileId)
    const model = `${p.provider}/${p.model}`
    cfg.model = model
    cfg.small_model = model
    const variant = p.effort?.default
    if (p.effort?.levels?.length && variant) cfg.variant = variant
    else delete cfg.variant

    for (const [role, want] of Object.entries(p.roles ?? {})) {
      const agent = cfg.agent ?? (cfg.agent = {})
      const existing = agent[role] ?? (agent[role] = {})
      existing.model = model
      const level = resolveEffort(p.effort?.levels ?? [], want)
      if (level) existing.variant = level
      else delete existing.variant
    }
    if (cfg.compaction) {
      cfg.compaction.prune = true
      cfg.compaction.reserved = reservedTokens(p)
    }
    cfg.harness = { ...(cfg.harness ?? {}), profile: profileId, threshold: pruneThreshold(p) }
  } catch {
    // Leave the config alone if the fallback profile cannot be read.
  }
}

export default RouterPlugin
