// Profile loading, effort resolution, and retention lookup.
//
// The rule this file exists to enforce: no plugin in src/ names a model. Every
// model-specific decision comes from a profile JSON, so switching models means
// editing data, not code.
//
// Plain JS with JSDoc types on purpose: the opencode plugin loads .ts, but the
// CLI has to run under plain node, so the shared core stays dependency-free.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, "..")

/**
 * @typedef {"zero-retention" | "may-train" | "unknown"} Retention
 * @typedef {string | null} EffortRequest
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} [title]
 * @property {string} provider
 * @property {string} model
 * @property {string | null} [family]
 * @property {string} [verified]
 * @property {Retention} retention
 * @property {string} [notes]
 * @property {{ context: number, input?: number, output: number }} limits
 * @property {{ reasoning?: boolean, temperature?: boolean, toolCall?: boolean,
 *             structuredOutput?: boolean, attachment?: boolean }} [supports]
 * @property {{ levels?: string[], default?: string | null, reserveShare?: number }} [effort]
 * @property {Record<string, EffortRequest>} [roles]
 * @property {{ enabled?: boolean, keepRecentToolCalls?: number,
 *             keepRecentTurns?: number, keepUserMessages?: boolean }} [prune]
 * @property {string[]} [fallback]
 * @typedef {{ retention: Retention, note?: string, verified?: string, source?: string }} RetentionRecord
 */

export class ProfileError extends Error {}

/**
 * Profiles live in profiles/ (verified) and examples/ (contrarian, still
 * installable). schema.json and index.json are not profiles.
 */
export function profileDirs() {
  return [join(ROOT, "profiles"), join(ROOT, "examples")]
}

export function profilePath(id) {
  for (const dir of profileDirs()) {
    const full = join(dir, `${id}.json`)
    if (existsSync(full)) return full
  }
  return null
}

/** @returns {string[]} */
export function listProfileIds() {
  const out = []
  for (const dir of profileDirs()) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      if (f === "schema.json" || f === "index.json") continue
      out.push(f.replace(/\.json$/, ""))
    }
  }
  return out.sort()
}

/** @param {string} id @returns {Profile} */
export function loadProfile(id) {
  const path = profilePath(id)
  if (!path) {
    throw new ProfileError(`no profile named "${id}". Run: oc-harness list`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new ProfileError(`cannot read ${path}: ${err.message}`)
  }
  validate(raw, path)
  return normalize(raw)
}

/**
 * Fill in derived fields so nothing downstream has to guess.
 * @param {Profile} p @returns {Profile}
 */
export function normalize(p) {
  return {
    ...p,
    limits: { ...p.limits, input: p.limits.input ?? p.limits.context },
    effort: {
      levels: p.effort?.levels ?? [],
      default: p.effort?.default ?? null,
      reserveShare: p.effort?.reserveShare ?? 0.12,
    },
    prune: {
      enabled: p.prune?.enabled ?? false,
      keepRecentToolCalls: p.prune?.keepRecentToolCalls ?? 6,
      keepRecentTurns: p.prune?.keepRecentTurns ?? 3,
      keepUserMessages: p.prune?.keepUserMessages ?? true,
    },
    fallback: p.fallback ?? [],
  }
}

const VALID_RETENTION = ["zero-retention", "may-train", "unknown"]

/** @param {Profile} p @param {string} [path] */
export function validate(p, path = "<memory>") {
  const where = p?.id ?? path
  if (!p?.id) throw new ProfileError(`${path}: missing "id"`)
  if (!p.provider) throw new ProfileError(`${where}: missing "provider"`)
  if (!p.model) throw new ProfileError(`${where}: missing "model"`)
  if (!VALID_RETENTION.includes(p.retention)) {
    throw new ProfileError(
      `${where}: retention must be one of ${VALID_RETENTION.join(", ")}`,
    )
  }
  if (!p.limits?.context || p.limits.context <= 0) {
    throw new ProfileError(`${where}: limits.context must be a positive integer`)
  }
  if (!p.limits?.output || p.limits.output <= 0) {
    throw new ProfileError(`${where}: limits.output must be a positive integer`)
  }
  const share = p.effort?.reserveShare
  if (share !== undefined && (share < 0 || share > 0.5)) {
    throw new ProfileError(
      `${where}: effort.reserveShare must be between 0 and 0.5`,
    )
  }
}

// Canonical ordering for reasoning effort, used to snap a requested level onto
// whatever the target model actually offers.
const CANON = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Pick the available level closest to what a role asked for.
 *
 * A role asking for `max` on a model topping out at `xhigh` gets `xhigh`. A
 * model with no tunable effort resolves to null, meaning "emit no variant"
 * rather than "emit a level the model does not have".
 *
 * @param {string[]} levels
 * @param {EffortRequest} requested
 * @returns {string | null}
 */
export function resolveEffort(levels, requested) {
  if (!requested) return null
  if (!levels || levels.length === 0) return null
  if (levels.includes(requested)) return requested

  const want = CANON.indexOf(requested)
  if (want < 0) {
    // Unknown label. Snap to the top level, which is the safe reading of a
    // role that asked for something strong.
    return levels[levels.length - 1] ?? null
  }
  let best = null
  let bestDist = Infinity
  for (const level of levels) {
    const have = CANON.indexOf(level)
    if (have < 0) continue
    const d = Math.abs(have - want)
    if (d < bestDist) {
      bestDist = d
      best = level
    }
  }
  return best ?? levels[levels.length - 1] ?? null
}

/**
 * @param {Profile} p
 * @returns {Record<string, string | null>}
 */
export function resolveRoles(p) {
  const levels = p.effort?.levels ?? []
  const out = {}
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    out[role] = resolveEffort(levels, want)
  }
  return out
}

/** @param {Profile} p @returns {string | null} */
export function resolveDefaultVariant(p) {
  return resolveEffort(p.effort?.levels ?? [], p.effort?.default ?? null)
}

/**
 * Tokens held back from the input ceiling for reasoning growth and in-flight
 * tool output. Scaled from the model, never hardcoded.
 * @param {Profile} p @returns {number}
 */
export function reservedTokens(p) {
  const input = p.limits.input ?? p.limits.context
  const share = p.effort?.reserveShare ?? 0.12
  return Math.max(8000, Math.round(input * share))
}

/** Context budget above which pruning should already be working. */
export function pruneThreshold(p) {
  return (p.limits.input ?? p.limits.context) - reservedTokens(p)
}

/**
 * Minimal YAML reader for retention.yml: a two-level map of small records,
 * including folded block scalars (`note: >-`). Handling indentation, folded
 * blocks and plain scalars costs about forty lines, which is less than a
 * dependency for a file this shape.
 *
 * @returns {Record<string, RetentionRecord>}
 */
export function loadRetention() {
  const file = join(ROOT, "retention.yml")
  if (!existsSync(file)) return {}
  const out = /** @type {Record<string, any>} */ ({})
  const lines = readFileSync(file, "utf8").split("\n")

  let current = null
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trim()
    const indent = raw.length - raw.trimStart().length

    if (!line || line.startsWith("#")) {
      i++
      continue
    }
    // A model key sits at two-space indent under `models:`.
    if (indent === 2 && line.endsWith(":")) {
      const key = line.slice(0, -1).trim()
      current = `opencode/${key}`
      out[current] = { retention: "unknown" }
      i++
      continue
    }
    if (!current) {
      i++
      continue
    }

    const field = line.match(/^(retention|verified|source|note):\s*(.*)$/)
    if (field) {
      const name = field[1]
      const rest = field[2].trim()
      if (/^[>|][-+]?$/.test(rest)) {
        // Folded or literal block: gather every following line indented deeper
        // than its key, then collapse whitespace into a one-line note.
        const parts = []
        let j = i + 1
        for (; j < lines.length; j++) {
          const l = lines[j]
          if (!l.trim()) {
            parts.push("")
            continue
          }
          if (l.length - l.trimStart().length <= indent) break
          parts.push(l.trim())
        }
        out[current][name] = parts.join(" ").replace(/\s+/g, " ").trim()
        i = j
        continue
      }
      out[current][name] = rest.replace(/^["']|["']$/g, "")
      i++
      continue
    }
    i++
  }
  return out
}

/**
 * Retention as declared in retention.yml, which wins over the profile copy.
 * @param {string} id @returns {RetentionRecord | undefined}
 */
export function retentionFor(id) {
  return loadRetention()[`opencode/${id}`]
}
