// Pure guard logic, separate from the hook so it can be tested without a
// TypeScript runtime and reused by other tools.
//
// Two ideas here:
//
// 1. Commands are split on shell separators before matching. Matching a raw
//    string is what lets `cd repo && git push` through, which is the obvious
//    hole in every regex guardrail. This is the "syntax-aware command
//    permissioning" pattern.
//
// 2. Rules are scoped. A rule that spans two commands (a pipe into a shell, a
//    fetch assigned to a credential name) has to see the whole string; a rule
//    about one command must only see one command, or `git log --grep push`
//    trips a push rule.

/** @typedef {{ name: string, test: RegExp, why: string, scope?: "segment" | "command", unless?: RegExp }} Rule */
/** @typedef {{ name: string, why: string, segment: string }} Hit */

/**
 * Split a shell command into the individual commands it runs.
 * @param {string} command
 * @returns {string[]}
 */
export function segments(command) {
  return command
    .split(/(?:&&|\|\||[;\n|])\s*/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** @type {Rule[]} */
export const BASH_RULES = [
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
    name: "git push with force",
    scope: "segment",
    // A dry run publishes nothing, so it is not the thing being gated.
    test: /^git\s+push\b(?!.*--(dry-run|-n)\b).*(--force|-f)\b/i,
    why: "overwrites published history",
  },
  {
    name: "git push",
    scope: "segment",
    test: /^git\s+push\b(?!.*--dry-run\b)(?!.*(^|\s)-n(\s|$))/i,
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

/** @type {Rule[]} */
export const WRITE_RULES = [
  {
    // `unless` exists because the safe variants are the same shape as the
    // dangerous ones: `.env.example` is a template meant to be committed, and
    // protecting it would block ordinary work.
    name: "write to a dotenv file",
    test: /(^|[\\/])\.env(\.|$)/i,
    unless: /(^|[\\/])\.env\.(example|sample|template|defaults?)\b/i,
    why: "dotenv files hold live credentials",
  },
  {
    name: "write to a credentials file",
    test: /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)(\.|$)/i,
    unless: /(^|[\\/])\.(npmrc|pypirc)\.example$/i,
    why: "registry and git credentials",
  },
  {
    name: "write to a private key",
    test: /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)\b/i,
    why: "private key material",
  },
]

/**
 * @param {string} command
 * @param {Rule[]} [rules]
 * @returns {Hit | null}
 */
export function checkBash(command, rules = BASH_RULES) {
  if (!command || !command.trim()) return null
  const parts = segments(command)
  for (const rule of rules) {
    if (rule.scope === "command") {
      if (rule.test.test(command)) return { name: rule.name, why: rule.why, segment: command }
      continue
    }
    for (const seg of parts) {
      if (rule.test.test(seg)) return { name: rule.name, why: rule.why, segment: seg }
    }
  }
  return null
}

/**
 * @param {string} target
 * @param {Rule[]} [rules]
 * @returns {Hit | null}
 */
export function checkWrite(target, rules = WRITE_RULES) {
  if (!target) return null
  for (const rule of rules) {
    if (!rule.test.test(target)) continue
    if (rule.unless?.test(target)) continue
    return { name: rule.name, why: rule.why, segment: target }
  }
  return null
}

/** Names of every rule, for `oc-harness show` and documentation. */
export function ruleNames() {
  return [...BASH_RULES, ...WRITE_RULES].map((r) => r.name)
}
