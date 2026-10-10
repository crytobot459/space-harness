#!/usr/bin/env node
// ab.mjs - the honest version of the effectiveness question.
//
// eval/run.mjs proves the pruner and the allowlist work. measure-install.mjs
// shows the kit is followed by better numbers. Neither says the kit *caused*
// them, because the before-window is a different mix of work. This runs the
// same task twice - kit on, kit off - and compares.
//
//   node eval/ab.mjs --target <dir> --task "<prompt>" --reps 3
//
// The kit-off arm is a throwaway HOME with no ~/.config/opencode. It is not
// OPENCODE_CONFIG and not --pure: both of those still load GLOBAL.md, which an
// earlier smoke test showed (system prompt 8,745 vs 8,758 tokens - no change).
// Swapping HOME removes the instruction file, the agent definitions and the
// plugins at once, and ~/.local/share/opencode is symlinked back to the real
// one so auth still works.
//
// The live ~/.config/opencode is never touched.
//
// Arms alternate so any drift in the model route lands on both sides equally.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { elapsedSeconds } from "./metrics.js"

const args = process.argv.slice(2)
const flag = (...n) => {
  const i = args.findIndex((a) => n.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}
// Collect the values after a repeatable flag. Not `args.filter`: that returns
// the flag names, which made every run score MISS on a correct answer.
const all = (...n) =>
  args.reduce((acc, a, i) => {
    if (n.includes(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) acc.push(args[i + 1])
    return acc
  }, [])

const target = flag("--target")
const task = flag("--task")
const reps = Number(flag("--reps") ?? 3)
const expect = all("--expect")

if (!target || !task) {
  console.error("usage: node eval/ab.mjs --target <dir> --task \"<prompt>\" [--reps 3] [--expect token]...")
  process.exit(1)
}
if (!existsSync(target)) {
  console.error(`target not found: ${target}`)
  process.exit(1)
}
// A short alternative matches almost any answer. `--expect "judge.py|7"` scored
// 3/3 against 1/3 on runs that had not found judge.py at all, because "7" is
// in every line number. This has already produced one wrong result in this
// repo's own notes; the check is cheap enough to be worth a warning.
const weak = expect
  .flatMap((e) => e.split("|").map((s) => s.trim()))
  .filter((s) => s.length > 0 && s.length < 4)
if (weak.length) {
  console.error(`warning: expectation alternatives too short to be meaningful: ${weak.map((w) => JSON.stringify(w)).join(", ")}`)
  console.error("         a bare digit or short token will match almost any answer.")
}
const REAL_HOME = homedir()
const TARGET_REAL = realpathSync(target)

/**
 * True when `p` is the target or something under it. Symlinks are resolved on
 * both sides so `/tmp` -> `/private/tmp` does not read as an escape.
 *
 * Relative paths count as inside: the agent resolves them against its working
 * directory, which is the target. A path is only "escaped" when it names a
 * location outside, which is the case worth stopping for.
 */
function isInsideTarget(p) {
  if (!p || typeof p !== "string") return true
  const abs = p.startsWith("/") ? realpathSafe(p) : join(TARGET_REAL, p)
  return abs === TARGET_REAL || abs.startsWith(TARGET_REAL + "/")
}

function realpathSafe(p) {
  try {
    return realpathSync(p)
  } catch {
    // A path that does not exist yet cannot be resolved; judge it lexically so
    // a write the agent only planned still counts.
    return p
  }
}

// A kit-free home. Config and instructions come from nowhere; auth and the
// session store are symlinked back so the run is a normal opencode run.
function makeNokitHome() {
  const home = mkdtempSync(join(tmpdir(), "opencode-ab-"))
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  mkdirSync(join(home, ".local/share"), { recursive: true })
  writeFileSync(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
  )
  const link = join(home, ".local/share/opencode")
  try {
    symlinkSync(join(REAL_HOME, ".local/share/opencode"), link, "dir")
  } catch {}
  return home
}

// A cheap fingerprint of the target tree. Proves the task did not mutate the
// subject under test, which would invalidate the second rep.
//
// `.space` and `.opencode` are excluded: the kit's own pruner writes telemetry
// into the working directory, so the kit-on arm always creates them. Counting
// those would report a dirty tree on every single run.
function fingerprint(dir) {
  const SKIP = new Set([".git", ".space", ".opencode"])
  const h = createHash("sha256")
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (SKIP.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else h.update(e.name).update(String(statSync(p).size))
    }
  }
  walk(dir)
  return h.digest("hex").slice(0, 16)
}

function parseStream(file) {
  const reads = [], searches = [], others = [], escaped = new Set()
  let steps = 0, inputTokens = 0, reasoning = 0, finalCtx = 0, text = "", first = null, last = null
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const s = line.trim()
    if (!s) continue
    let d
    try { d = JSON.parse(s) } catch { continue }
    const ts = d.timestamp
    if (ts) { if (first === null) first = ts; last = ts }
    if (d.type === "tool_use") {
      const p = d.part ?? {}
      const input = p.state?.input ?? {}
      // Every path the agent names is recorded, and anything outside the target
      // is kept verbatim. The first pilot ran in the *parent* session's project
      // and wrote to the real repository; --dir should stop that, and this is
      // the check that proves it did rather than assuming it.
      for (const k of ["filePath", "path"]) {
        if (typeof input[k] === "string" && !isInsideTarget(input[k])) escaped.add(input[k])
      }
      if (p.tool === "read") {
        reads.push(input.offset !== undefined || input.limit !== undefined)
      } else if (p.tool === "grep" || p.tool === "glob") searches.push(p.tool)
      else others.push(p.tool ?? "?")
    } else if (d.type === "step_finish") {
      const t = d.part?.tokens ?? {}
      steps++
      inputTokens += t.input ?? 0
      reasoning += t.reasoning ?? 0
      finalCtx = (t.input ?? 0) + (t.cache?.read ?? 0)
    } else if (d.type === "text") {
      text += d.part?.text ?? ""
    }
  }
  const narrow = reads.filter(Boolean).length
  return {
    steps,
    tools: reads.length + searches.length + others.length,
    reads: reads.length,
    narrow,
    narrow_pct: reads.length ? Math.round((narrow / reads.length) * 1000) / 10 : 0,
    searches: searches.length,
    other: others.reduce((a, t) => (a[t] = (a[t] ?? 0) + 1, a), {}),
    inputTokens,
    reasoning,
    finalCtx,
    seconds: first !== null && last !== null ? elapsedSeconds(first, last) : null,
    text,
    escaped: [...escaped],
  }
}

function runArmCapture(arm, home, idx, outDir) {
  const out = join(outDir, `${arm}-${idx}.json`)
  const env = { ...process.env }
  if (arm === "off") env.HOME = home
  const t0 = Date.now()
  // --dir is not optional. Nested inside an opencode session, `opencode run`
  // otherwise inherits the *parent* session's project directory and reads the
  // wrong repository entirely - which it did on the first pilot.
  const { stdout } = spawnSync("opencode", ["run", "--dir", target, "--format", "json", task], {
    cwd: target, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  })
  writeFileSync(out, stdout ?? "")
  return { out, code: stdout === null ? 1 : 0, wall: Math.round((Date.now() - t0) / 100) / 10 }
}

const nokit = makeNokitHome()
const outDir = mkdtempSync(join(tmpdir(), "opencode-ab-out-"))
const before = fingerprint(target)

console.log(`A/B: ${reps} rep(s) per arm, alternating`)
console.log(`  target  ${target}`)
console.log(`  task    ${task.slice(0, 90)}${task.length > 90 ? "..." : ""}`)
console.log(`  kit-off home ${nokit}`)
console.log("")

const runs = []
for (let i = 1; i <= reps; i++) {
  for (const arm of ["on", "off"]) {
    process.stdout.write(`  running ${arm}-${i} ... `)
    const r = runArmCapture(arm, nokit, i, outDir)
    const m = parseStream(r.out)
    // Each --expect is a group; alternatives inside it are separated by "|".
    // A task can have more than one defensible answer, and both arms finding
    // `judge.py:348` instead of the `score.py` I first assumed is exactly the
    // case where a strict check reports a quality difference that is not there.
    const hit = (e) =>
      e.split("|").some((alt) => m.text.toLowerCase().includes(alt.trim().toLowerCase()))
    const ok = expect.length === 0 || expect.every(hit)
    runs.push({ arm, i, ...m, wall: r.wall, code: r.code, correct: ok })
    // Stop the moment an arm reaches outside the target. The first pilot wrote
    // to the real repository while the task said not to modify anything, so a
    // second arm is not worth the risk once this has happened.
    if (m.escaped.length) {
      console.log(`ESCAPED`)
      console.error("")
      console.error(`FAIL: ${arm}-${i} touched ${m.escaped.length} path(s) outside ${TARGET_REAL}`)
      for (const p of m.escaped.slice(0, 10)) console.error(`  ${p}`)
      console.error("")
      console.error("Stopping. Do not run further arms against a target the agent escapes.")
      console.error(`raw stream kept for inspection: ${r.out}`)
      process.exit(1)
    }
    console.log(
      `${m.tools} tools, ${m.narrow_pct}% narrow, ${m.finalCtx} ctx, ${r.wall}s` +
        (expect.length ? `, answer ${ok ? "ok" : "MISS"}` : ""),
    )
  }
}

const after = fingerprint(target)
const stat = (arm, key) => {
  const v = runs.filter((r) => r.arm === arm).map((r) => r[key]).filter((x) => x !== null)
  if (!v.length) return null
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
}

const rows = [
  ["tool calls", stat("on", "tools"), stat("off", "tools")],
  ["read calls", stat("on", "reads"), stat("off", "reads")],
  ["narrow reads", stat("on", "narrow"), stat("off", "narrow")],
  ["narrow %", stat("on", "narrow_pct"), stat("off", "narrow_pct")],
  ["grep/glob", stat("on", "searches"), stat("off", "searches")],
  ["steps", stat("on", "steps"), stat("off", "steps")],
  ["input tokens", stat("on", "inputTokens"), stat("off", "inputTokens")],
  ["final ctx", stat("on", "finalCtx"), stat("off", "finalCtx")],
  ["wall seconds", stat("on", "wall"), stat("off", "wall")],
  ["correct", runs.filter((r) => r.arm === "on" && r.correct).length, runs.filter((r) => r.arm === "off" && r.correct).length],
  ["escaped paths", runs.filter((r) => r.arm === "on").reduce((a, r) => a + r.escaped.length, 0), runs.filter((r) => r.arm === "off").reduce((a, r) => a + r.escaped.length, 0)],
]

console.log("")
console.log(`  ${"metric".padEnd(16)} ${"kit on".padStart(10)} ${"kit off".padStart(10)}`)
console.log(`  ${"-".repeat(16)} ${"-".repeat(10)} ${"-".repeat(10)}`)
for (const [label, a, b] of rows) {
  console.log(`  ${label.padEnd(16)} ${String(a).padStart(10)} ${String(b).padStart(10)}`)
}
console.log("")
console.log(`  every path stayed under the target: ${runs.every((r) => r.escaped.length === 0) ? "yes" : "NO"}`)
console.log(`  target unchanged: ${before === after ? "yes" : `NO (${before} -> ${after})`}`)
console.log(`  raw streams: ${outDir}`)
console.log(`  kit-off home: ${nokit}`)

if (before !== after) {
  console.error("")
  console.error("FAIL: the task modified the target, so the arms saw different trees.")
  process.exit(1)
}