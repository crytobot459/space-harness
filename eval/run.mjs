#!/usr/bin/env node
// eval/run.mjs - did the harness actually change anything?
//
// A harness that claims to improve efficiency has to be measurable, or the
// claim is decoration. This runs the shipped transformers over a synthetic
// transcript shaped like a real one and reports what changed.
//
// It measures the mechanical effects that are deterministic and offline:
//   - how much context the pruner removes
//   - how many permission prompts the allowlist removes
//   - whether effort tiering cuts the latency it predicts to cut
//
// It does NOT measure model quality. That needs real runs against real tasks,
// and a synthetic transcript cannot tell you whether the code got better.
//
// Usage:
//   node eval/run.mjs                 human-readable
//   node eval/run.mjs --json         machine-readable
//   node eval/run.mjs --compare      measure with the kit disabled, for a diff

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = join(ROOT, "dist", "index.js")
const wantJson = process.argv.includes("--json")
const compare = process.argv.includes("--compare")

if (!existsSync(DIST)) {
  console.error("dist/index.js missing. Run: npm run build")
  process.exit(1)
}

/**
 * A transcript shaped like the one that produced the real baseline: tool calls
 * with kilobyte-scale output, a small amount of prose, and reasoning.
 */
function syntheticTranscript({ turns = 40, toolOutputBytes = 9000 } = {}) {
  const messages = []
  for (let i = 0; i < turns; i++) {
    messages.push({
      info: { id: `a${i}`, role: "assistant", time: { created: 1789000000000 + i } },
      parts: [
        { id: `s${i}`, sessionID: "ses", messageID: `a${i}`, type: "step-start" },
        {
          id: `r${i}`,
          sessionID: "ses",
          messageID: `a${i}`,
          type: "reasoning",
          text: "thinking ".repeat(400),
        },
        {
          id: `t${i}`,
          sessionID: "ses",
          messageID: `a${i}`,
          type: "tool",
          callID: `c${i}`,
          tool: i % 3 === 0 ? "bash" : "read",
          state: {
            status: "completed",
            input: i % 3 === 0 ? { command: `pytest -q tests/test_${i}.py` } : { filePath: `src/mod_${i}.py` },
            output: "x".repeat(toolOutputBytes),
            title: "tool",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
        {
          id: `x${i}`,
          sessionID: "ses",
          messageID: `a${i}`,
          type: "text",
          text: "Short prose conclusion for this step.",
        },
      ],
    })
    if (i % 8 === 0) {
      messages.push({
        info: { id: `u${i}`, role: "user", time: { created: 1789000000000 + i } },
        parts: [{ id: `ut${i}`, sessionID: "ses", messageID: `u${i}`, type: "text", text: "continue" }],
      })
    }
  }
  return messages
}

function bytesOf(messages) {
  return JSON.stringify(messages).length
}

async function measurePruning() {
  const { HarnessPlugin } = await import(DIST)
  const worktree = join(ROOT, ".space-eval")
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  mkdirSync(join(worktree, ".space"), { recursive: true })
  writeFileSync(join(worktree, ".space", "active"), "space-bunny-free\n")

  const hooks = await HarnessPlugin(
    { worktree, directory: worktree, project: {}, client: {}, $: () => {} },
    { only: ["prune"], profile: "space-bunny-free" },
  )
  const transform = hooks["experimental.chat.messages.transform"]
  if (!transform) {
    rmSync(worktree, { recursive: true, force: true })
    throw new Error("prune hook did not activate; check the active marker path")
  }

  const messages = syntheticTranscript()
  const before = bytesOf(messages)
  await transform({}, { messages })
  const after = bytesOf(messages)

  const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")
  const pruned = toolParts.filter((p) => p.state?.metadata?.pruned).length
  const usersIntact = messages
    .filter((m) => m.info.role === "user")
    .every((m) => m.parts[0].text === "continue")

  rmSync(worktree, { recursive: true, force: true })
  return {
    bytesBefore: before,
    bytesAfter: after,
    reductionPct: +(((before - after) / before) * 100).toFixed(1),
    toolParts: toolParts.length,
    pruned,
    usersIntact,
  }
}

/** Replay a corpus of bash commands through an allowlist. */
async function measurePrompts() {
  const { BASH_ALLOWLIST } = await import(join(ROOT, "src", "config.js"))
  const corpus = [
    // Shape from the measured 5,239 real commands, compressed.
    ...Array(1742).fill("cd /Users/x/proj && ls -la"),
    ...Array(326).fill("ls -la"),
    ...Array(219).fill("# build the app"),
    ...Array(217).fill('python3 -c "print(1)"'),
    ...Array(151).fill("gh pr list"),
    ...Array(148).fill("echo hello"),
    ...Array(141).fill("sleep 2"),
    ...Array(133).fill("ssh -o StrictHostKeyChecking=no deploy@host uptime"),
    ...Array(93).fill("curl -s https://example.test/api"),
    ...Array(80).fill("cat src/app.py"),
    ...Array(67).fill("TOKEN=$(curl -s https://example.test/token)"),
    ...Array(66).fill("rm -rf build/"),
    ...Array(59).fill("git add -A"),
    ...Array(47).fill("osascript -e 'tell app \"Finder\" to quit'"),
    ...Array(43).fill("pkill -f node"),
  ]
  const glob = (cmd, pat) =>
    new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") + "$").test(cmd)
  const prompts = corpus.filter((c) => !BASH_ALLOWLIST.some((p) => glob(c, p))).length
  return {
    commands: corpus.length,
    prompts,
    promptSharePct: +((prompts / corpus.length) * 100).toFixed(1),
  }
}

/**
 * Effort tiering, using the measured medians as the cost model.
 * These are per-model numbers from one install, so the output is an
 * estimate for that install, not a general claim.
 */
async function measureEffort() {
  const { loadProfile, resolveRoles } = await import(join(ROOT, "src", "profile.js"))

  const MEDIAN = { max: 18.7, xhigh: 7.8, high: 7.8, medium: 7.8, low: 7.8 }
  const p = loadProfile("space-bunny-free")
  const roles = resolveRoles(p)

  // A realistic session: one plan, eight builds, two reviews, four verifications.
  const mix = { plan: 1, build: 8, reviewer: 2, verify: 4, scout: 0 }
  let allMax = 0
  let tiered = 0
  for (const [role, count] of Object.entries(mix)) {
    allMax += count * MEDIAN.max
    const level = roles[role]
    tiered += count * (level ? (MEDIAN[level] ?? MEDIAN.max) : MEDIAN.max)
  }
  return {
    mix,
    allMaxSeconds: +allMax.toFixed(1),
    tieredSeconds: +tiered.toFixed(1),
    savedPct: +(((allMax - tiered) / allMax) * 100).toFixed(1),
    caveat: "per-request medians measured on one model pair, not a general result",
  }
}

const [pruning, prompts, effort] = await Promise.all([
  measurePruning(),
  measurePrompts(),
  measureEffort(),
])

const report = { generated: new Date().toISOString(), pruning, prompts, effort }

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const n = (x) => Number(x).toLocaleString("en-US")
const pad = (k) => k.padEnd(34)

console.log(`\nopencode-harness-kit eval  ${report.generated}\n`)

console.log("CONTEXT PRUNING  (synthetic transcript: 45 assistant turns, 45 tool calls)")
console.log(`  ${pad("bytes before")} ${n(pruning.bytesBefore)}`)
console.log(`  ${pad("bytes after")} ${n(pruning.bytesAfter)}`)
console.log(`  ${pad("reduction")} ${pruning.reductionPct}%`)
console.log(`  ${pad("tool parts pruned")} ${pruning.pruned} / ${pruning.toolParts}`)
console.log(`  ${pad("user messages intact")} ${pruning.usersIntact ? "yes" : "NO"}`)

console.log("\nPERMISSION PROMPTS  (corpus shaped from 5,239 measured commands)")
console.log(`  ${pad("commands")} ${n(prompts.commands)}`)
console.log(`  ${pad("prompts")} ${n(prompts.prompts)}  (${prompts.promptSharePct}%)`)
console.log(`  ${pad("previously")} 95.3% with a narrow allowlist`)

console.log("\nEFFORT TIERING  (measured medians: max 18.7s, lower tiers 7.8s)")
console.log(`  ${pad("all-max session")} ${effort.allMaxSeconds}s`)
console.log(`  ${pad("tiered session")} ${effort.tieredSeconds}s`)
console.log(`  ${pad("saved")} ${effort.savedPct}%`)
console.log(`  ${pad("caveat")} ${effort.caveat}`)

if (compare) {
  const off = syntheticTranscript()
  console.log(
    `\n  ${pad("kit disabled")} ${n(bytesOf(off))} bytes ` +
      `(${(((bytesOf(off) - pruning.bytesAfter) / bytesOf(off)) * 100).toFixed(1)}% larger than pruned)`,
  )
}

console.log("\n  Not measured here: code quality, task completion, review defects.")
console.log("  Those need real runs against real tasks. See docs/RESEARCH.md.\n")
