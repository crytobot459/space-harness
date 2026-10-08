#!/usr/bin/env node
// oc-harness - pick a model profile and compile it into an opencode config.
//
//   oc-harness list                 profiles with retention and caveats
//   oc-harness use <id>            write ~/.config/opencode/opencode.jsonc
//   oc-harness use <id> --print    print the config instead of writing it
//   oc-harness show <id>           show the resolved effort plan
//   oc-harness doctor              re-check profiles against live metadata
//   oc-harness baseline            measure the current install
//
// The point of the kit: switching models is a data edit, not a code change.
// Everything model-specific lives in profiles/<id>.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"

import {
  loadProfile,
  loadRetention,
  listProfileIds,
  profilePath,
  pruneThreshold,
  reservedTokens,
  resolveDefaultVariant,
  resolveRoles,
  ProfileError,
} from "../src/profile.js"
import { generateConfig } from "../src/config.js"
import { planEffort } from "../src/effort.js"

const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config/opencode")
const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
const ROOT = import.meta.dirname ? join(import.meta.dirname, "..") : process.cwd()

const args = process.argv.slice(2)
const cmd = args[0] ?? "list"
const has = (f) => args.includes(f)
const opt = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const stamp = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

function index() {
  const f = join(import.meta.dirname, "..", "profiles", "index.json")
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { profiles: [], excluded: [] }
}

async function cmdList() {
  const idx = index()
  const retention = loadRetention()
  const only = opt("--retention")
  const freeOnly = has("--free")

  console.log(`\n${bold("opencode-harness-kit")} ${stamp("profiles")}\n`)
  const head = [
    "  " + "profile".padEnd(30),
    "ctx".padStart(9),
    "top".padStart(7),
    "retention".padEnd(15),
  ].join("  ")
  console.log(head)
  console.log("  " + "-".repeat(72))

  for (const entry of idx.profiles ?? []) {
    if (only && entry.retention !== only) continue
    if (freeOnly && entry.free === false) continue
    const r = retention[`opencode/${entry.id}`]
    const isDefault = entry.default
    const name = (isDefault ? green("▸ ") : "  ") + entry.id
    const top = entry.topEffort ?? stamp("—")
    const ret =
      entry.retention === "zero-retention"
        ? green(entry.retention)
        : yellow(entry.retention)
    const mismatch =
      r && r.retention && r.retention !== entry.retention
        ? ` ${red(`(retention.yml says ${r.retention})`)}`
        : ""
    console.log(
      [
        "  " + name.padEnd(32),
        (entry.context ?? 0).toLocaleString("en-US").padStart(9),
        String(top).padStart(7),
        ret.padEnd(15),
      ].join("  ") + mismatch,
    )
    if (entry.note) console.log(`      ${stamp(entry.note)}`)
  }

  const ex = idx.excluded ?? []
  if (ex.length && (!only || only === "may-train")) {
    console.log("\n  " + stamp("installable, not recommended"))
    for (const entry of ex) {
      console.log(`  ${yellow("✗")} ${entry.id}`)
      console.log(`      ${yellow(entry.reason)}`)
    }
  }
  console.log(
    `\n  ${stamp("install one:")} oc-harness use <profile>\n  ${stamp("inspect:")}   oc-harness show <profile>\n`,
  )
}

function cmdShow(id) {
  if (!id) fail("usage: oc-harness show <profile>")
  const p = loadProfile(id)
  const plan = planEffort(id)
  const retention = loadRetention()[`opencode/${p.provider}/${p.model}`]

  console.log(`\n${bold(p.id)}  ${stamp(p.title ?? "")}\n`)
  const row = (k, v) => console.log(`  ${k.padEnd(20)} ${v}`)
  row("provider/model", `${p.provider}/${p.model}`)
  row("context", p.limits.context.toLocaleString("en-US"))
  row("input cap", (p.limits.input ?? p.limits.context).toLocaleString("en-US"))
  row("output cap", p.limits.output.toLocaleString("en-US"))
  row("effort levels", p.effort?.levels?.length ? p.effort.levels.join(" < ") : "(not tunable)")
  row("default variant", resolveDefaultVariant(p) ?? "(none)")
  row("temperature", p.supports?.temperature ? "yes" : stamp("no - not emitted"))
  row("attachment", p.supports?.attachment ? "yes" : stamp("no"))
  row("reserved", reservedTokens(p).toLocaleString("en-US"))
  row("prune at", pruneThreshold(p).toLocaleString("en-US"))
  row("retention", p.retention === "zero-retention" ? green(p.retention) : yellow(p.retention))

  console.log(`\n  ${bold("role effort")}`)
  for (const [role, level] of Object.entries(plan.roles)) {
    const want = p.roles?.[role]
    const arrow = want && want !== level ? ` ${stamp(`(requested ${want})`)}` : ""
    console.log(`    ${role.padEnd(10)} ${String(level ?? "(unset)").padEnd(10)}${arrow}`)
  }

  if (p.fallback?.length) {
    console.log(`\n  ${bold("fallback")} ${p.fallback.join(" → ")}`)
    console.log(`  ${stamp("selected at session start; no hook can switch a live session")}`)
  }
  if (retention?.note) {
    console.log(`\n  ${bold("retention note")}`)
    console.log(`    ${retention.note}`)
  }
  if (plan.notes.length) {
    console.log(`\n  ${bold("adjustments")}`)
    for (const n of plan.notes) console.log(`    ${yellow("!")} ${n}`)
  }
  if (p.notes) {
    console.log(`\n  ${bold("notes")}`)
    console.log(`    ${p.notes}`)
  }
  console.log()
}

/**
 * Link the built plugin into ~/.config/opencode/plugins so opencode loads it
 * without an npm install. This is the path to use while developing, and it
 * means the kit is usable before anything is published.
 */
function cmdLink() {
  const dist = join(ROOT, "dist", "index.js")
  if (!existsSync(dist)) {
    fail("dist/index.js missing. Run: npm run build")
  }
  const dir = join(CONFIG_DIR, "plugins")
  mkdirSync(dir, { recursive: true })
  const target = join(dir, "opencode-harness-kit.js")
  try {
    rmSync(target, { force: true })
  } catch {
    // Fresh symlink.
  }
  // A relative link survives the package moving or being reinstalled.
  symlinkSync(join("..", "..", "..", "harness", "space-harness", "dist", "index.js"), target)
  console.log(`\n  ${green("✓")} linked ${target}`)
  console.log(
    `  ${stamp("opencode loads ~/.config/opencode/plugins automatically")}\n` +
      `  ${stamp("restart opencode, then: opencode debug config")}\n`,
  )
}

function cmdUse(id) {
  if (!id) fail("usage: oc-harness use <profile> [--print] [--yes]")
  const p = loadProfile(id)
  const retention = loadRetention()[`${p.provider}/${p.model}`]

  // A profile may not become the default until a human has stated its
  // retention terms. Capability metadata cannot answer this question.
  if (retention?.retention === "unknown" || (!retention && p.retention === "unknown")) {
    fail(
      `retention for ${p.provider}/${p.model} is not recorded in retention.yml.\n` +
        `Add an entry with retention: zero-retention | may-train before installing it.`,
    )
  }
  if (p.retention === "may-train" && !has("--yes")) {
    const msg =
      `${yellow("!")} ${p.provider}/${p.model} may train on your prompts and completions.\n` +
      `  ${retention?.note ?? ""}\n` +
      `  Re-run with --yes to accept.`
    if (process.stdin.isTTY && !has("--print")) {
      fail(msg + "\n")
    }
    console.error(msg)
  }

  let base = {}
  if (existsSync(CONFIG_FILE)) {
    base = stripComments(readFileSync(CONFIG_FILE, "utf8"))
  }

  const out = generateConfig(p, { base, comments: true })
  if (has("--print")) {
    process.stdout.write(out)
    return
  }

  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  if (existsSync(CONFIG_FILE) && !has("--yes")) {
    writeFileSync(`${CONFIG_FILE}.bak`, readFileSync(CONFIG_FILE))
    console.error(stamp(`  existing config backed up to ${CONFIG_FILE}.bak`))
  }
  writeFileSync(CONFIG_FILE, out)
  console.log(`\n  ${green("✓")} wrote ${CONFIG_FILE}`)
  console.log(`  ${stamp(`model      ${p.provider}/${p.model}`)}`)
  console.log(`  ${stamp(`effort     ${resolveDefaultVariant(p) ?? "(not tunable)"}`)}`)
  console.log(`  ${stamp(`roles      ${Object.entries(resolveRoles(p)).map(([k, v]) => `${k}=${v ?? "-"}`).join(" ")}`)}`)
  console.log(`  ${stamp(`reserved   ${reservedTokens(p).toLocaleString("en-US")} tokens`)}`)
  console.log(`\n  ${stamp("verify with: opencode debug config")}\n`)
}

/** opencode.jsonc is JSONC, so strip comments before parsing. */
function stripComments(text) {
  const without = text
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  try {
    return JSON.parse(without)
  } catch {
    return {}
  }
}

/** Re-fetch models.dev and report which profiles have drifted from it. */
async function fetchCatalog() {
  const url = "https://models.dev/api.json"
  try {
    return JSON.parse(
      execFileSync("curl", ["-sL", "--max-time", "40", url], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    )
  } catch (err) {
    fail(`could not reach ${url}: ${err.message}`)
  }
}

function diffProfile(p, live) {
  const issues = []
  const liveLimits = live.limit ?? {}
  if ((liveLimits.context ?? 0) !== p.limits.context) {
    issues.push(`context ${p.limits.context} -> ${liveLimits.context}`)
  }
  if ((liveLimits.output ?? 0) !== p.limits.output) {
    issues.push(`output ${p.limits.output} -> ${liveLimits.output}`)
  }
  if ((liveLimits.input ?? liveLimits.context) !== (p.limits.input ?? p.limits.context)) {
    issues.push(`input ${p.limits.input} -> ${liveLimits.input ?? liveLimits.context}`)
  }
  const liveLevels = live.reasoning_options?.find((r) => r.type === "effort")?.values ?? []
  if (JSON.stringify(liveLevels) !== JSON.stringify(p.effort?.levels ?? [])) {
    issues.push(`effort [${(p.effort?.levels ?? []).join(",")}] -> [${liveLevels.join(",")}]`)
  }
  if (Boolean(live.temperature) !== Boolean(p.supports?.temperature)) {
    issues.push(`temperature ${p.supports?.temperature} -> ${Boolean(live.temperature)}`)
  }
  if (Boolean(live.attachment) !== Boolean(p.supports?.attachment)) {
    issues.push(`attachment ${p.supports?.attachment} -> ${Boolean(live.attachment)}`)
  }
  return issues
}

/**
 * Refresh capability fields from live metadata.
 *
 * Only machine-derived fields are rewritten. `retention`, `notes`, `roles` and
 * the fallback queue are human judgements and are never touched by a script:
 * losing a privacy verdict to an automated rewrite would be worse than drift.
 */
async function cmdRefresh(id) {
  const path = profilePath(id)
  if (!path) fail(`no profile named "${id}"`)
  const catalog = await fetchCatalog()
  const p = JSON.parse(readFileSync(path, "utf8"))
  const live = catalog?.[p.provider]?.models?.[p.model]

  if (!live) {
    fail(
      `${p.provider}/${p.model} is no longer in models.dev.\n` +
        `  It may have been withdrawn from the provider. Remove the profile, or\n` +
        `  keep it and set retention to reflect the current terms.`,
    )
  }

  const before = diffProfile(p, live)
  if (before.length === 0) {
    console.log(`\n  ${green("✓")} ${id} already matches live metadata\n`)
    return
  }

  p.limits = {
    ...p.limits,
    context: live.limit?.context ?? p.limits.context,
    output: live.limit?.output ?? p.limits.output,
  }
  // Many providers publish no separate input ceiling; drop ours so the loader
  // derives it from context rather than pinning a stale number.
  if (live.limit?.input) p.limits.input = live.limit.input
  else delete p.limits.input

  const levels = live.reasoning_options?.find((r) => r.type === "effort")?.values ?? []
  p.effort = {
    ...p.effort,
    levels,
    default: levels.includes(p.effort?.default) ? p.effort.default : levels[levels.length - 1] ?? null,
  }
  p.supports = {
    ...p.supports,
    reasoning: Boolean(live.reasoning),
    temperature: Boolean(live.temperature),
    toolCall: Boolean(live.tool_call),
    structuredOutput: Boolean(live.structured_output),
    attachment: Boolean(live.attachment),
  }
  p.verified = new Date().toISOString().slice(0, 10)

  writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`)
  console.log(`\n  ${green("✓")} refreshed ${path}`)
  for (const line of before) console.log(`      ${line}`)
  console.log(
    `\n  ${stamp("kept as-is: retention, roles, notes, fallback (human judgement)")}\n`,
  )
}

/** Re-check every profile against the live provider catalog. */
async function cmdDoctor() {
  const catalog = await fetchCatalog()
  const retention = loadRetention()
  const ids = listProfileIds()
  let problems = 0

  console.log(`\n${bold("doctor")}  ${stamp(`catalog ${Object.keys(catalog).length} providers`)}\n`)

  for (const id of ids) {
    let p
    try {
      p = loadProfile(id)
    } catch (err) {
      console.log(`  ${red("✗")} ${id.padEnd(32)} ${err.message}`)
      problems++
      continue
    }
    const live = catalog?.[p.provider]?.models?.[p.model]
    if (!live) {
      console.log(`  ${red("✗")} ${id.padEnd(32)} ${red("not in models.dev - may be withdrawn")}`)
      problems++
      continue
    }

    const issues = diffProfile(p, live)
    const ret = retention[`${p.provider}/${p.model}`]
    if (p.retention === "zero-retention" && ret?.retention === "may-train") {
      issues.push(red("retention.yml now says may-train"))
    }

    if (issues.length === 0) {
      console.log(`  ${green("✓")} ${id.padEnd(32)} ${stamp("matches catalog")}`)
    } else {
      problems++
      console.log(`  ${yellow("!")} ${id.padEnd(32)} ${yellow("drift")}`)
      for (const i of issues) console.log(`      ${i}`)
      console.log(`      ${stamp(`fix: oc-harness use ${id} --refresh`)}`)
    }
  }
  console.log(
    problems
      ? `\n  ${yellow(`${problems} profile(s) drifted`)}\n`
      : `\n  ${green("all profiles match live metadata")}\n`,
  )
}

function fail(msg) {
  console.error(`\n  ${red("error")} ${msg}\n`)
  process.exit(1)
}

try {
  switch (cmd) {
    case "list":
      await cmdList()
      break
    case "use":
      cmdUse(args[1])
      break
    case "show":
      cmdShow(args[1])
      break
    case "refresh":
      await cmdRefresh(args[1])
      break
    case "link":
      cmdLink()
      break
    case "doctor":
      await cmdDoctor()
      break
    case "baseline":
      await import("./baseline.mjs")
      break
    case "help":
    default:
      console.log(`
  oc-harness <command>

    list      show profiles with retention and caveats
    use <id>  compile a profile into ${CONFIG_FILE}
    show <id> print the resolved effort plan and derived numbers
    refresh <id>  update capability fields from models.dev
    link          symlink the built plugin into ~/.config/opencode/plugins
    doctor    re-check profiles against models.dev
    baseline  measure the current opencode install

  options
    --print        write the config to stdout instead of disk
    --yes          accept a retention warning, back up the old config
    --retention    filter list by retention class
    --free         list free profiles only
`)
  }
} catch (err) {
  if (err instanceof ProfileError) fail(err.message)
  fail(err.message)
}
