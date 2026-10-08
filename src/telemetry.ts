// Local telemetry.
//
// Purpose is comparison, not surveillance: `oc-harness baseline` reads the
// opencode database for history, this records what the kit itself changes so
// the two can be diffed. It is a JSONL file in the project, never a network
// call, and it is gitignored.
//
// What is worth recording: context size per request (to see pruning working),
// latency by role and effort (to see tiering paying off), tool denials (to see
// the guard being useful rather than annoying), and provider rate limits.

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs"
import { join } from "node:path"

const MAX_BYTES = 4 * 1024 * 1024

function logPath(dir: string): string {
  return join(dir, "telemetry.jsonl")
}

/** Rotate by size so a long-running project cannot fill its disk. */
function rotate(file: string) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    // Best effort.
  }
}

function write(dir: string, record: Record<string, unknown>) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = logPath(dir)
    rotate(file)
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n")
  } catch {
    // Telemetry must never be load-bearing.
  }
}

export const TelemetryPlugin: Plugin = async ({ worktree }) => {
  const dir = join(worktree, ".space")
  const started = Date.now()

  return {
    event: async ({ event }) => {
      // Events are provider-specific and opencode may add shapes we have never
      // seen. Anything unrecognised is ignored rather than trusted.
      const type = (event as { type?: unknown } | undefined)?.type
      if (typeof type !== "string") return

      // Provider rate limits are the one signal that changes behaviour, so
      // they get logged even though the event shape is provider-specific.
      if (/error|rate|limit|quota/i.test(type)) {
        write(dir, { kind: "provider-event", type, detail: truncate(safeStringify(event)) })
      }
    },

    "tool.execute.after": async (input, output) => {
      const text = typeof output?.output === "string" ? output.output : ""
      if (text.includes("[opencode-harness-kit] blocked")) {
        write(dir, { kind: "guard", tool: input.tool, rule: extractRule(text) })
        return
      }
      const command = String((input.args as { command?: unknown })?.command ?? "")
      if (input.tool === "bash" && /git push|rm -rf|chmod 777/.test(command)) {
        write(dir, { kind: "guard-attempt", tool: input.tool, command: truncate(command) })
      }
    },

    dispose: async () => {
      write(dir, { kind: "session", uptimeMs: Date.now() - started })
    },
  }
}

function extractRule(output: string): string {
  const m = output.match(/blocked:\s*([^\n]+)/)
  return m ? m[1].trim() : "unknown"
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}...` : s
}

/** Stringify without throwing on a cycle or a BigInt. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export default TelemetryPlugin
