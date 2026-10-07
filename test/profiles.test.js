// The central claim of this kit: switching models is a data edit, not a code
// change. These tests are the proof, so they assert behaviour differences
// between profiles rather than just that the code runs.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  loadProfile,
  resolveEffort,
  resolveRoles,
  reservedTokens,
  pruneThreshold,
  normalize,
  listProfileIds,
  loadRetention,
  ProfileError,
  validate,
} from "../src/profile.js"
import { generateConfig, BASH_ALLOWLIST, BASH_DENYLIST } from "../src/config.js"
import { planEffort } from "../src/effort.js"

const cfg = (id) => parseGenerated(generateConfig(loadProfile(id)))

/** The generator emits a comment header, then the JSON body. */
function parseGenerated(text) {
  const i = text.indexOf("{")
  return JSON.parse(text.slice(i))
}

test("every shipped profile loads and validates", () => {
  const ids = listProfileIds()
  assert.ok(ids.length >= 5, `expected several profiles, found ${ids.length}`)
  for (const id of ids) {
    const p = loadProfile(id)
    assert.equal(p.id, id)
    assert.ok(p.limits.context > 0)
    assert.ok(p.limits.output > 0)
  }
})

test("effort resolution snaps a missing level onto one the model has", () => {
  const bunny = ["low", "medium", "high", "xhigh", "max"]
  assert.equal(resolveEffort(bunny, "max"), "max")
  assert.equal(resolveEffort(bunny, "high"), "high")

  // A model topping out at xhigh must not be handed a `max`.
  const muse = ["minimal", "low", "medium", "high", "xhigh"]
  assert.equal(resolveEffort(muse, "max"), "xhigh")

  // Only three levels, no medium or xhigh.
  const three = ["low", "high", "max"]
  assert.equal(resolveEffort(three, "medium"), "low")
  assert.equal(resolveEffort(three, "xhigh"), "high")

  // No tunable effort at all: emit nothing rather than invent a level.
  assert.equal(resolveEffort([], "max"), null)
  assert.equal(resolveEffort(["low"], null), null)
})

test("generated config never contains an effort level the model lacks", () => {
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const levels = p.effort?.levels ?? []
    const c = cfg(id)
    for (const [role, agent] of Object.entries(c.agent ?? {})) {
      const v = agent.variant
      if (v === undefined) continue
      assert.ok(
        levels.includes(v),
        `${id}: role ${role} got variant "${v}" which is not in [${levels.join(",")}]`,
      )
    }
    if (c.variant) {
      assert.ok(levels.includes(c.variant), `${id}: top-level variant not available`)
    }
  }
})

test("reserved tokens and prune threshold scale with the model", () => {
  const bunny = normalize(loadProfile("space-bunny-free"))
  const small = normalize(loadProfile("deepseek-v4-flash-free"))

  // 12% of each input cap, floored at 8k.
  assert.equal(reservedTokens(bunny), Math.round(bunny.limits.input * 0.12))
  assert.equal(reservedTokens(small), Math.round(small.limits.input * 0.12))
  assert.ok(reservedTokens(bunny) > reservedTokens(small))
  assert.equal(pruneThreshold(small), small.limits.input - reservedTokens(small))

  // A 1M-tuned profile must not be silently reused on a 200k model. The
  // threshold is a real fraction of each model's own input cap, not a fixed
  // number, so the small model's budget is dramatically tighter.
  assert.ok(pruneThreshold(small) < pruneThreshold(bunny) / 2)
  assert.ok(
    Math.abs(reservedTokens(small) / small.limits.input - 0.12) < 1e-9,
    "the reserve stays a proportional share of each model",
  )
})

test("the same plugin source produces different behaviour per profile", () => {
  const bunny = cfg("space-bunny-free")
  const muse = cfg("muse-spark-1.3-contributor-free")
  const longcat = cfg("longcat-2.5-preview-free")
  const small = cfg("deepseek-v4-flash-free")

  // 1. The model itself.
  assert.equal(bunny.model, "opencode/space-bunny-free")
  assert.equal(muse.model, "opencode/muse-spark-1.3-contributor-free")

  // 2. small_model never points at a different model, on any profile.
  for (const [name, c] of Object.entries({ bunny, muse, longcat, small })) {
    assert.equal(c.small_model, c.model, `${name}: small_model diverged`)
  }

  // 3. Effort differs because the models differ.
  assert.equal(bunny.variant, "max")
  assert.equal(muse.variant, "xhigh")
  assert.equal(longcat.variant, undefined, "a model without tunable effort gets no variant")
  assert.equal(longcat.agent.plan.variant, undefined)
  assert.equal(longcat.agent.build.variant, undefined)

  // 4. Reserved budget differs because the input caps differ.
  assert.ok(bunny.compaction.reserved > small.compaction.reserved)
})

test("temperature is only emitted for models that support it", () => {
  const bunny = cfg("space-bunny-free")
  assert.equal(bunny.temperature, undefined)
  assert.equal(cfg("muse-spark-1.3-contributor-free").temperature, undefined)
  // Both are left unset; the distinction lives in the profile, not the config.
  assert.equal(loadProfile("space-bunny-free").supports.temperature, false)
  assert.equal(loadProfile("muse-spark-1.3-contributor-free").supports.temperature, true)
})

test("context settings that matter are switched on", () => {
  const c = cfg("space-bunny-free")
  assert.equal(c.subagent_depth, 2, "depth 1 blocks nested subagents")
  assert.equal(c.lsp, true, "omitting lsp disables it entirely")
  assert.equal(c.compaction.prune, true)
  assert.equal(c.compaction.tail_turns, undefined, "inert compaction key must be dropped")
  assert.deepEqual(c.tool_output, { max_lines: 200, max_bytes: 8192 })
  assert.equal(c.experimental.batch_tool, true)
  assert.equal(c.experimental.continue_loop_on_deny, true)
})

test("bash allowlist keeps read-only work silent and gates the dangerous rest", () => {
  const c = cfg("space-bunny-free")
  const rules = c.permission.bash

  assert.equal(rules["*"], "ask", "unknown commands must still ask")
  for (const safe of ["ls*", "cat*", "git status*", "git diff*", "python3 -m pytest*", "cd*"]) {
    assert.equal(rules[safe], "allow", `${safe} should be allowed`)
  }
  for (const hard of BASH_DENYLIST) {
    assert.equal(rules[hard], "deny", `${hard} should be denied`)
  }
  for (const gated of ["ssh*", "curl*", "rm*", "pkill*", "osascript*", "git add*", "cp*", "mv*"]) {
    assert.equal(rules[gated], undefined, `${gated} must fall through to ask`)
  }
  assert.ok(BASH_ALLOWLIST.length > 60)
})

test("roles that must not edit are locked in the generated config", () => {
  const c = cfg("space-bunny-free")
  assert.equal(c.agent.plan.permission.edit, "deny")
  assert.equal(c.agent.reviewer.permission.edit, "deny")
  assert.equal(c.agent.scout.permission.edit, "deny")
  assert.equal(c.agent.scout.permission.bash, "deny")
  assert.equal(c.agent.verify.permission.edit, "deny")
})

test("every agent declares its own model, because variant needs it", () => {
  const c = cfg("space-bunny-free")
  for (const agent of Object.values(c.agent)) {
    assert.equal(agent.model, c.model)
  }
})

test("retention.yml is parsed and separates safe from training routes", () => {
  const r = loadRetention()
  assert.equal(r["opencode/space-bunny-free"].retention, "zero-retention")
  assert.equal(r["opencode/muse-spark-1.3-contributor-free"].retention, "may-train")
  // Folded block scalars must collapse to a single readable line.
  const note = r["opencode/muse-spark-1.3-contributor-free"].note
  assert.ok(note.includes("train future Meta models"))
  assert.ok(!note.includes("\n"))
  assert.ok(r["opencode/space-bunny-free"].note.includes("zero-retention"))
})

test("every profile has a retention.yml entry, and the two agree", () => {
  const r = loadRetention()
  let checked = 0
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const declared = r[`${p.provider}/${p.model}`]
    assert.ok(
      declared,
      `${id} has no retention.yml entry, so \`oc-harness use\` would refuse it`,
    )
    assert.equal(
      p.retention,
      declared.retention,
      `${id} says ${p.retention} but retention.yml says ${declared.retention}`,
    )
    checked++
  }
  assert.ok(checked >= 5, "the loop must actually run, not skip everything")
})

test("the plan explains every downgrade instead of hiding it", () => {
  const muse = planEffort("muse-spark-1.3-contributor-free")
  assert.equal(muse.roles.plan, "xhigh")
  assert.ok(
    muse.notes.some((n) => n.includes("tops out at xhigh")),
    "an adjusted role must be reported",
  )

  const longcat = planEffort("longcat-2.5-preview-free")
  assert.ok(longcat.notes.some((n) => n.includes("no tunable reasoning effort")))
})

test("validation rejects a profile that is missing something essential", () => {
  const base = loadProfile("space-bunny-free")

  const cases = [
    ["missing context", (p) => delete p.limits.context, /limits\.context/],
    ["bad retention value", (p) => (p.retention = "safe"), /retention must be one of/],
    ["zero output cap", (p) => (p.limits.output = 0), /limits\.output/],
    ["absurd reserveShare", (p) => (p.effort.reserveShare = 5), /reserveShare/],
    ["missing model", (p) => delete p.model, /missing "model"/],
    ["missing provider", (p) => delete p.provider, /missing "provider"/],
    ["missing id", (p) => delete p.id, /missing "id"/],
  ]

  for (const [name, mutate, expected] of cases) {
    const clone = JSON.parse(JSON.stringify(base))
    mutate(clone)
    assert.throws(() => validate(clone), expected, `${name} should be rejected`)
  }

  assert.throws(() => loadProfile("does-not-exist"), ProfileError)
})

test("an inherited config is merged, not replaced wholesale", () => {
  const base = { skills: { paths: ["/custom/skills"] }, permission: { edit: "deny" } }
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), { base }),
  )
  assert.deepEqual(out.skills.paths, ["/custom/skills"])
  assert.equal(out.permission.edit, "deny", "inherited permissions survive")
  assert.equal(out.permission.bash["*"], "ask", "the allowlist is still generated")
})

test("an inherited small_model pointing elsewhere is replaced", () => {
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), {
      base: { small_model: "opencode/some-other-model-free" },
    }),
  )
  assert.equal(out.small_model, "opencode/space-bunny-free")
})
