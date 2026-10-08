// Compile a profile into an opencode.jsonc.
//
// Config that does not depend on the model - permission allowlist, pruning
// defaults, experimental flags - is fixed here. Everything model-specific is
// derived from the profile, so switching models changes only the profile file.

import { pruneThreshold, reservedTokens, resolveRoles, resolveDefaultVariant } from "./profile.js"

/** @typedef {import("./profile.js").Profile} Profile */

/**
 * Read-only and verification commands.
 *
 * Measured against 5,239 real bash calls from one install: 95.3% would prompt
 * under a narrow allowlist, 23% under this one. The gated remainder is
 * deliberate - ssh, curl, rm, pkill, osascript, git add, cp, mv, kill, chmod,
 * docker.
 *
 * `X*` with no space is used on purpose: opencode's `X *` pattern requires a
 * trailing space and therefore does not match a bare `X`.
 */
export const BASH_ALLOWLIST = [
  "ls*", "cat*", "head*", "tail*", "wc*", "file*", "stat*", "pwd*", "env*", "printenv*",
  "date*", "whoami*", "which*", "find*", "tree*", "du*", "df*", "lsof*", "sed*", "awk*",
  "sort*", "uniq*", "diff*", "grep*", "rg*", "echo*", "printf*", "sleep*",
  "cd*", "realpath*", "basename*", "dirname*", "readlink*",
  "for*", "set*", "export*", "unset*", "bash*", "sh*", "true*", "false*", "test*",
  "read*", "#*", "xargs*", "seq*", "exit*", ":*",
  "node*", "python3*", "python*", "npm*", "bun*", "uv*", "go*", "cargo*", "rustc*",
  "opencode*", "sqlite3*", "jq*", "fd*",
  "git status*", "git log*", "git diff*", "git show*", "git branch*",
  "git rev-parse*", "git config --get*", "git remote*", "git blame*",
  "git stash list*", "git ls-files*", "git describe*", "git shortlog*", "git --version*",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1*", "PYTHONPATH=*", "PYTHONUNBUFFERED=1*",
  "python3 -m pytest*", "python3 -m venv*", "python3 -m compileall*",
  "python3 -c*", "python3 agent/*", "python3 src/*", "python3 -",
  ".venv/bin/python*", "pytest*", "ruff*", "mypy*", "black*",
  "npm test*", "npm run *", "npm ci*", "npm ls*", "npm view *",
  "npx*", "uv run *", "uv pip *", "bun run *", "bunx*", "node -e*",
  "opencode debug*", "opencode --version*", "opencode models*",
]

/** Hard blocks. The guard plugin enforces the same set in code. */
export const BASH_DENYLIST = [
  "git push *",
  "rm -rf *",
  "curl * | sh",
  "curl * | bash",
  "chmod 777 *",
]

/** Roles the kit writes, with the permissions that keep them honest. */
const AGENT_PERMISSIONS = /** @type {Record<string, Record<string, string>>} */ ({
  plan: { edit: "deny" },
  reviewer: { edit: "deny" },
  scout: { edit: "deny", bash: "deny" },
  verify: { edit: "deny" },
})

/**
 * @param {Profile} p
 * @param {{ base?: Record<string, any>, comments?: boolean }} [opts]
 * @returns {string}
 */
export function generateConfig(p, opts = {}) {
  const base = opts.base ?? {}
  const model = `${p.provider}/${p.model}`
  const roles = resolveRoles(p)
  const variant = resolveDefaultVariant(p)

  const agent = { ...(base.agent ?? {}) }
  for (const [role, level] of Object.entries(roles)) {
    if (level === undefined) continue
    const existing = { ...(agent[role] ?? {}) }
    if (!existing.model) existing.model = model
    if (level === null) delete existing.variant
    else existing.variant = level
    if (AGENT_PERMISSIONS[role]) {
      existing.permission = {
        ...(existing.permission ?? {}),
        ...AGENT_PERMISSIONS[role],
      }
    }
    agent[role] = existing
  }

  const bashRules = {
    "*": "ask",
    ...Object.fromEntries(BASH_ALLOWLIST.map((rule) => [rule, "allow"])),
    ...Object.fromEntries(BASH_DENYLIST.map((rule) => [rule, "deny"])),
  }

  const compaction = { ...(base.compaction ?? {}) }
  // `tail_turns` is dropped even if the inherited config had one. It only
  // applies during compaction, and compaction is keyed off the full context
  // ceiling, which a normal session never reaches. On the measured install it
  // had never fired once, so it was inert config.
  delete compaction.tail_turns
  compaction.auto = true
  compaction.prune = true
  compaction.reserved = reservedTokens(p)

  const out = {
    $schema: "https://opencode.ai/config.json",
    ...base,

    model,
  // Same model, not a cheaper one: swapping models mid-session changes the
  // voice and the tool habits. Lower the effort instead. An inherited
  // small_model pointing at a different model is replaced, not preserved.
  small_model: model,
    ...(variant ? { variant } : {}),
    default_agent: base.default_agent ?? "build",

    // The default is 1, which blocks subagents from spawning subagents and so
    // removes every nested review loop.
    subagent_depth: base.subagent_depth ?? 2,
    // Omitting `lsp` disables it entirely, so this must be set explicitly.
    lsp: base.lsp ?? true,
    instructions: base.instructions ?? ["~/.config/opencode/GLOBAL.md"],

    compaction,
    // Left alone deliberately: 200 lines / 8 KB is about 6x tighter than the
    // 2000 / 51200 default and measurably keeps context small. Raising it
    // trades context for fewer round trips.
    tool_output: base.tool_output ?? { max_lines: 200, max_bytes: 8192 },

    skills: base.skills ?? {},

    experimental: {
      batch_tool: true,
      continue_loop_on_deny: true,
      ...(base.experimental ?? {}),
    },

    permission: {
      ...(base.permission ?? {}),
      read: base.permission?.read ?? "allow",
      doom_loop: base.permission?.doom_loop ?? "ask",
      bash: bashRules,
    },

    agent,

    // The router plugin reads this at startup to know which fallback queue to
    // walk, and it is also how a profile stays identifiable after the config
    // has been hand-edited.
    harness: {
      profile: p.id,
      ...(p.fallback?.length ? { fallback: p.fallback[0] } : {}),
      threshold: pruneThreshold(p),
    },
  }

  return render(out, p, { comments: opts.comments ?? true })
}

/**
 * @param {Record<string, any>} cfg
 * @param {Profile} p
 * @param {{ comments: boolean }} opts
 * @returns {string}
 */
function render(cfg, p, opts) {
  const c = opts.comments ? "// " : ""
  const input = p.limits.input ?? p.limits.context
  const levels = p.effort?.levels ?? []
  const roles = resolveRoles(p)

  const head = [
    `${c}Generated by opencode-harness-kit. Edit profiles/${p.id}.json instead`,
    `${c}of this file, then re-run: oc-harness use ${p.id}`,
    `${c}`,
    `${c}profile      ${p.id}`,
    `${c}model        ${p.provider}/${p.model}`,
    `${c}context      ${p.limits.context.toLocaleString("en-US")} tokens`,
    `${c}input cap    ${input.toLocaleString("en-US")} tokens`,
    `${c}output cap   ${p.limits.output.toLocaleString("en-US")} tokens`,
    `${c}reasoning    ${levels.length ? levels.join(" < ") : "(not tunable)"}`,
    `${c}retention    ${p.retention}${p.retention === "may-train" ? "  <-- prompts may train a model" : ""}`,
    `${c}`,
    `${c}Derived numbers, do not hand-edit:`,
    `${c}  compaction.reserved  ${reservedTokens(p).toLocaleString("en-US")}  (${Math.round((p.effort?.reserveShare ?? 0.12) * 100)}% of the input cap, held back for reasoning growth)`,
    `${c}  prune threshold      ${pruneThreshold(p).toLocaleString("en-US")}  (input cap minus reserve)`,
    `${c}  role effort          ${Object.entries(roles).map(([k, v]) => `${k}=${v ?? "unset"}`).join("  ")}`,
  ]

  if (!levels.length) {
    head.push(`${c}`, `${c}This model publishes no tunable reasoning effort, so no variant is written.`)
  }
  if (p.supports?.temperature === false) {
    head.push(`${c}This model does not support temperature, so none is set.`)
  }
  if (p.prune?.enabled) {
    head.push(
      `${c}  prune keeps         ${p.prune.keepRecentToolCalls ?? 6} tool calls, ${p.prune.keepRecentTurns ?? 3} turns verbatim`,
    )
  }

  return `${head.join("\n")}\n${JSON.stringify(cfg, null, 2)}\n`
}
