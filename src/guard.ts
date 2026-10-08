// Guard hook.
//
// The decision logic lives in rules.js so it can be tested without a
// TypeScript runtime. This file is only the wiring.
//
// Fail-closed: if the guard cannot decide, it blocks. A guard that quietly
// passes when broken is worse than none, because the user stops watching it.

import type { Plugin } from "@opencode-ai/plugin"
import { checkBash, checkWrite } from "./rules.js"

const MARKER = "[opencode-harness-kit] blocked"

function deny(why: string, detail: string): never {
  // Throwing is the only way to stop a tool call from a hook.
  throw new Error(
    `${MARKER}: ${why}\n  ${detail}\n` +
      `  This is enforced in code, not by a prompt. If the command is genuinely ` +
      `safe, run it yourself in a terminal.`,
  )
}

function truncate(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n)}...` : one
}

export const GuardPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool === "bash") {
          const hit = checkBash(String(output.args?.command ?? ""))
          if (hit) deny(hit.name, `${hit.why}\n  command: ${truncate(hit.segment)}`)
          return
        }

        if (input.tool === "write" || input.tool === "edit" || input.tool === "patch") {
          const target =
            String(output.args?.filePath ?? output.args?.path ?? "") ||
            String(output.args?.changes?.[0]?.filePath ?? "")
          const hit = checkWrite(target)
          if (hit) deny(hit.name, `${hit.why}\n  file: ${truncate(hit.segment)}`)
        }
      } catch (err) {
        // Our own denial must not be re-wrapped into a confusing failure.
        if (err instanceof Error && err.message.startsWith(MARKER)) throw err
        // Anything unexpected fails closed. An undecidable guard is not a pass.
        throw new Error(
          `${MARKER} (guard failed closed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  }
}

export default GuardPlugin
