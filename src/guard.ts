// Mechanical guardrails.
//
// Config permission rules ask a human. This hook decides in code, which is both
// faster and harder to click past by accident. It runs before every tool call.
//
// Fail-closed: if this module cannot decide, it blocks. A guard that silently
// passes when broken is worse than no guard, because the user stops noticing it.
//
// No model names here. The denylist is shared with the config compiler so the
// two cannot drift apart.

import type { Plugin } from "@opencode-ai/plugin"
import { BASH_DENYLIST } from "./config.js"

type Rule = { name: string; test: RegExp; why: string; scope?: "segment" | "command" }

/**
 * Split a shell command into the individual commands it runs, so a rule can
 * judge `cd x && git push` rather than only a command that happens to start
 * with the forbidden word. This is syntax-aware permissioning: matching the
 * raw string is what makes naive guardrails miss chained commands.
 */
function segments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;\n|]|\$\()\s*/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Ordered most-specific first. Measured against one real install where the
 * gated commands were ssh (133), curl (93), rm (66), pkill (43),
 * osascript (47) and git add (59).
 *
 * `scope: "command"` rules look at the whole string because they span
 * segments - a pipe into a shell, or a fetch assigned to a credential name.
 * Everything else is judged per segment.
 */
const BASH_RULES: Rule[] = [
  {
    name: "secret exfiltration via shell",
    scope: "command",
    test: /\b(TOKEN|SECRET|KEY|PASSWORD|API_KEY)\s*=\s*\$\(\s*(curl|wget)\b/i,
    why: "assigns a fetched value into a credential-named variable",
  },
  {
    name: "remote delete over ssh",
    scope: "command",
    test: /\bssh\b[^|;&]*\brm\s+-[a-zA-Z]*[rf]/i,
    why: "destructive command executed on another host",
  },
  {
    name: "pipe remote script into a shell",
    scope: "command",
    test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i,
    why: "downloads and executes a script in one step",
  },
  {
    name: "git push",
    scope: "segment",
    test: /^git\s+push\b/i,
    why: "publishing is a human decision",
  },
  {
    name: "recursive delete",
    scope: "segment",
    test: /^rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*)\s+/i,
    why: "rm with a recursive or force flag",
  },
  {
    name: "chmod 777",
    scope: "segment",
    test: /^chmod\s+(-[a-zA-Z]+\s+)*777\b/,
    why: "opens permissions on everything",
  },
  {
    name: "history rewrite",
    scope: "segment",
    test: /^git\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|rebase\s+.*--force)/i,
    why: "destroys work that only exists locally",
  },
]

/** Writes that must never touch a secret file. */
const WRITE_RULES: Rule[] = [
  {
    name: "write to a dotenv file",
    test: /(^|[\\/])\.env(\.|$)/,
    why: "dotenv files hold live credentials",
  },
  {
    name: "write to a credentials file",
    test: /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)(\.|$)/,
    why: "registry and git credentials",
  },
]

function firstMatch(command: string, rules: Rule[]): (Rule & { segment: string }) | null {
  const parts = segments(command)
  for (const rule of rules) {
    if (rule.scope === "command") {
      if (rule.test.test(command)) return { ...rule, segment: command }
      continue
    }
    for (const seg of parts) {
      if (rule.test.test(seg)) return { ...rule, segment: seg }
    }
  }
  return null
}

function deny(why: string, detail: string) {
  // Throwing is the only way to stop a tool call from a hook.
  throw new Error(
    `[opencode-harness-kit] blocked: ${why}\n  ${detail}\n` +
      `  This is enforced in code, not by a prompt. If the command is genuinely ` +
      `safe, run it yourself in a terminal.`,
  )
}

export const GuardPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool === "bash") {
          const command = String(output.args?.command ?? "")
          if (!command.trim()) return
          const hit = firstMatch(command, BASH_RULES)
          if (hit) {
            deny(hit.name, `${hit.why}\n  command: ${truncate(command)}`)
          }
          return
        }

        if (input.tool === "write" || input.tool === "edit" || input.tool === "patch") {
          const target =
            String(output.args?.filePath ?? output.args?.path ?? "") ||
            String(output.args?.changes?.[0]?.filePath ?? "")
          if (!target) return
          const hit = firstMatch(target, WRITE_RULES)
          if (hit) deny(hit.name, `${hit.why}\n  file: ${truncate(target)}`)
        }
      } catch (err) {
        // Deny surfaces as a thrown error and must not be swallowed here.
        if (err instanceof Error && err.message.startsWith("[opencode-harness-kit] blocked")) {
          throw err
        }
        // Anything unexpected fails closed: an undecidable guard is not a pass.
        throw new Error(
          `[opencode-harness-kit] guard failed closed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  }
}

function truncate(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n)}...` : one
}

export const guardMeta = {
  bashDenyPatterns: BASH_DENYLIST,
  bashRules: BASH_RULES.map((r) => r.name),
  writeRules: WRITE_RULES.map((r) => r.name),
}

export default GuardPlugin
