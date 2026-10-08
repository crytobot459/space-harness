// Deterministic context pruning.
//
// Measured on one install: 77.9% of stored message bytes were tool output and
// 15.6% reasoning, against 2.1% of actual text. Cache reads ran 20.6x fresh
// input, and p50 context per request was ~99k tokens with only ~534 fresh
// tokens. The session was re-sending old command output on every turn.
//
// Why not let the model decide when to compact: the model-driven approach needs
// the model to remember to call a tool, and this kit targets models with weak
// instruction following. This hook runs unconditionally and keeps pointers
// instead of bodies, so nothing is lost, only re-read on demand.
//
// Invariants, because this rewrites history on every turn:
//   - never touch the last message
//   - never touch a tool call from the turn in flight
//   - never touch patch or file parts, which carry diffs the model needs
//   - never stub a user message unless asked to

import type { Plugin } from "@opencode-ai/plugin"
import { loadProfile, pruneThreshold, ROOT } from "./profile.js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Which profile is active. In order: an explicit environment variable, the
 * marker the plugin writes into the project, then a marker inside the package.
 * Returns null when nothing is set, and pruning then stays off rather than
 * guessing at thresholds.
 */
function activeProfileId(worktree: string): string | null {
  const candidates = [
    process.env.OPENCODE_HARNESS_PROFILE,
    join(worktree, ".space", "active"),
    join(ROOT, "profiles", ".active"),
  ]
  for (const f of candidates) {
    if (!f) continue
    try {
      if (existsSync(f)) {
        const v = readFileSync(f, "utf8").trim()
        if (v) return v
      }
    } catch {
      // Try the next location.
    }
  }
  return null
}

interface StubStats {
  stubbed: number
  kept: number
  bytesBefore: number
  bytesAfter: number
}

/** Rough size of a part, used only for the stats line. */
function sizeOf(part: any): number {
  if (typeof part?.text === "string") return part.text.length
  if (typeof part?.state?.output === "string") return part.state.output.length
  return 0
}

/**
 * One line standing in for a tool result. The agent keeps the shape of what
 * happened and a way to get the rest, which is what it actually needs to decide
 * what to do next.
 */
function stub(part: any): string {
  const tool = part?.tool ?? "tool"
  const state = part?.state ?? {}
  const input = state.input ?? {}

  if (tool === "bash") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").slice(0, 80)
    const status = state.status ?? "done"
    let tail = ""
    const out = String(state.output ?? "")
    const m = out.match(/(passed|failed|error|Error|ok|OK|\d+ (?:passed|failed))/g)
    if (m && m.length) tail = `, ${m[m.length - 1]}`
    return `[${tool}] ${cmd} -> ${status}${tail} | full output was pruned from context; re-run the command if you need it`
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list") {
    const target = String(input.filePath ?? input.path ?? input.pattern ?? "")
    return `[${tool}] ${target.slice(0, 100)} | result pruned from context; re-read it if you need it`
  }
  return `[${tool}] result pruned from context (${state.status ?? "done"}); re-run if you need it`
}

export const PrunePlugin: Plugin = async ({ worktree, $ }) => {
  let profile = null as ReturnType<typeof loadProfile> | null
  try {
    const id = activeProfileId(worktree)
    if (id) profile = loadProfile(id)
  } catch {
    profile = null
  }
  if (!profile?.prune?.enabled) {
    // Pruning is opt-in per profile. With no active profile we do nothing
    // rather than guess at thresholds.
    return {}
  }

  const keepCalls = profile.prune.keepRecentToolCalls ?? 6
  const keepTurns = profile.prune.keepRecentTurns ?? 3
  const keepUsers = profile.prune.keepUserMessages ?? true
  const threshold = pruneThreshold(profile)

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = output.messages
        if (!Array.isArray(messages) || messages.length === 0) return

        // The trailing keepTurns are off limits, and the last message always is.
        const floor = Math.max(0, messages.length - 1 - keepTurns)

        // Walk backwards collecting tool parts to preserve verbatim.
        // Walk backwards from the end until keepCalls tool parts are collected.
        // This is deliberately not bounded by `floor`: how many recent calls
        // stay verbatim and which turns are prunable are independent limits,
        // and a call can be both recent and inside the prunable span.
        const keepToolMessageIds = new Set<string>()
        let seen = 0
        for (let i = messages.length - 1; i >= 0 && seen < keepCalls; i--) {
          const msg = messages[i]
          if (!msg?.parts) continue
          for (const part of msg.parts) {
            if (part?.type !== "tool") continue
            if (seen >= keepCalls) break
            keepToolMessageIds.add(msg.info?.id ?? String(i))
            seen++
          }
        }

        const stats: StubStats = {
          stubbed: 0,
          kept: 0,
          bytesBefore: 0,
          bytesAfter: 0,
        }

        for (let i = 0; i < floor; i++) {
          const msg = messages[i]
          if (!msg?.parts) continue
          const isUser = msg.info?.role === "user"
          for (const part of msg.parts) {
            const size = sizeOf(part)
            stats.bytesBefore += size

            if (isUser && keepUsers) {
              stats.bytesAfter += size
              stats.kept++
              continue
            }
            if (keepToolMessageIds.has(msg.info?.id ?? String(i))) {
              stats.bytesAfter += size
              stats.kept++
              continue
            }
            switch (part?.type) {
              case "patch":
              case "file":
                // Diffs and file bodies are load-bearing; never stub them.
                stats.bytesAfter += size
                stats.kept++
                break
              case "reasoning":
                // Old reasoning is stale by definition and safe to drop.
                stats.bytesAfter += Math.min(size, 200)
                stats.stubbed++
                break
              case "tool": {
                // Only completed calls carry an output worth pruning. Pending
                // and running states are small, and error states are usually
                // the most useful thing in the transcript.
                const state = part.state
                if (state?.status !== "completed") {
                  stats.bytesAfter += size
                  stats.kept++
                  break
                }
                part.state = {
                  status: "completed",
                  input: state.input,
                  output: stub(part),
                  title: state.title,
                  time: state.time,
                  metadata: { ...(state.metadata ?? {}), pruned: true, prunedAt: new Date().toISOString() },
                }
                stats.bytesAfter += sizeOf(part)
                stats.stubbed++
                break
              }
              case "text":
                // Assistant prose carries the reasoning chain a human reads and
                // the model later relies on. Keep it.
                stats.bytesAfter += size
                stats.kept++
                break
              default:
                stats.bytesAfter += size
                stats.kept++
            }
          }
        }

        if (stats.stubbed > 0) {
          const saved = Math.max(0, stats.bytesBefore - stats.bytesAfter)
          void $
          void worktree
          await logPrune(profile.id, {
            ...stats,
            saved,
            threshold,
          })
        }
      } catch (err) {
        // A failed prune must never break the turn. Skipping is recoverable;
        // corrupting history is not.
        console.error(
          `[opencode-harness-kit] prune skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  }
}

async function logPrune(profileId: string, stats: StubStats & { saved: number; threshold: number }) {
  const dir = join(process.cwd(), ".space")
  try {
    const { mkdir, appendFile } = await import("node:fs/promises")
    await mkdir(dir, { recursive: true })
    await appendFile(
      join(dir, "prune.jsonl"),
      JSON.stringify({
        t: new Date().toISOString(),
        profile: profileId,
        stubbed: stats.stubbed,
        kept: stats.kept,
        savedBytes: stats.saved,
        threshold: stats.threshold,
      }) + "\n",
    )
  } catch {
    // Telemetry must never be load-bearing.
  }
}

export const pruneMeta = { note: "opt-in via profile prune.enabled" }

export default PrunePlugin
