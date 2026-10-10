// The grader is the part of this repo that has produced wrong numbers three
// times, so its edges are pinned here rather than left to the shape of an
// agent's prose on the day. Every case below is one that actually happened, or
// would have caught one that did.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { extractRefs, resolveInTarget, gradeAnswer } from "../eval/verify.mjs"

// A three-file fixture shaped like the snapshots the suite runs against.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-test-"))
  mkdirSync(join(root, "agent"), { recursive: true })
  const score = [
    "def band(total):", // 1
    "    if total >= 90:", // 2
    '        return "A"', // 3
    "", // 4
    '    result = {"pass": total >= 55, "band": b}', // 5
    "    return result", // 6
  ]
  writeFileSync(join(root, "agent/score.py"), score.join("\n"))
  writeFileSync(join(root, "agent/other.py"), "total = 3\n")
  return { root, passLine: 5 }
}

test("extractRefs finds the citation shapes an agent actually writes", () => {
  const refs = extractRefs(
    'It is in agent/score.py:5. See also `agent/score.py` line 5 and agent/other.py (1).',
  )
  const found = refs.map((r) => `${r.file}:${r.line}`)
  assert.ok(found.includes("agent/score.py:5"), "path:line")
  assert.ok(found.some((f) => f.startsWith("agent/score.py:")), "bare path")
  assert.ok(found.includes("agent/other.py:1"), "path (line)")
})

test("extractRefs reads the markdown shape a model actually answers in", () => {
  // Verbatim from a run that was scored wrong: **File:** `agent/score.py`
  // **Line:** 214. Emphasis and a colon sit between the word and the number, and
  // the old pattern required the digits to follow "line" directly.
  const answer = "**File:** `agent/score.py` **Line:** 214\n**Quote:** `\"pass\": total >= 55`"
  const refs = extractRefs(answer)
  assert.ok(
    refs.some((r) => r.file === "agent/score.py" && r.line === 214),
    `expected agent/score.py:214, got ${JSON.stringify(refs)}`,
  )
})

test("gradeAnswer accepts the markdown citation form", () => {
  const { root, passLine } = fixture()
  const answer = `**File:** \`agent/score.py\` **Line:** ${passLine}\n\`"pass": total >= 55\``
  assert.equal(gradeAnswer(root, answer, "total >= 55").ok, true)
})

test("extractRefs reads a line-first citation", () => {
  const refs = extractRefs("Line 214 of agent/score.py sets it")
  assert.ok(refs.some((r) => r.file === "agent/score.py" && r.line === 214), JSON.stringify(refs))
})

test("extractRefs dedupes the same claim written several ways", () => {
  const refs = extractRefs("agent/score.py:5 and again agent/score.py:5")
  assert.equal(refs.length, 1)
})

test("extractRefs returns nothing for prose that names no path", () => {
  // This is the "the rubric file" answer that the old substring grader let
  // through, and it is the shape a task demanding a path should fail.
  const refs = extractRefs("The rubric is in the rubric file, in the scoring module.")
  assert.equal(refs.length, 0)
})

test("a hallucinated citation resolves to nothing", () => {
  const { root } = fixture()
  assert.equal(resolveInTarget(root, "agent/does-not-exist.py"), null)
  assert.equal(resolveInTarget(root, "/etc/passwd"), null)
  assert.equal(resolveInTarget(root, "../../../etc/passwd"), null)
})

test("gradeAnswer accepts a citation whose line holds the answer", () => {
  const { root, passLine } = fixture()
  const r = gradeAnswer(root, `The field is set at agent/score.py:${passLine}.`, "total >= 55")
  assert.equal(r.ok, true)
  assert.equal(r.refs[0].status, "match")
})

test("gradeAnswer tolerates an off-by-one citation", () => {
  // An agent that reports 4 for a line on 5 has still found it. Failing that
  // would measure citation precision, not whether the agent located the code.
  const { root, passLine } = fixture()
  const r = gradeAnswer(root, `agent/score.py:${passLine - 1}`, "total >= 55")
  assert.equal(r.ok, true)
})

test("gradeAnswer rejects a citation to the wrong line", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "agent/score.py:2", "total >= 55")
  assert.equal(r.ok, false)
  assert.equal(r.refs[0].status, "line-mismatch")
})

test("gradeAnswer rejects an answer that cites nothing", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "It is in the scoring module, the pass field.", "total >= 55")
  assert.equal(r.ok, false)
  assert.equal(r.refs.length, 0)
})

test("gradeAnswer accepts a bare path when the task only asked which file", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "See agent/other.py for the total.", "total = 3")
  assert.equal(r.ok, true)
  assert.equal(r.refs[0].status, "match-file")
})

test("gradeAnswer fails a file citation whose contents do not hold the answer", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "See agent/other.py", "total >= 55")
  assert.equal(r.ok, false)
  assert.equal(r.refs[0].status, "file-mismatch")
})

test("a bare digit no longer passes everything", () => {
  // The old grader reported 3/3 on `--expect "judge.py|7"` because "7" occurs in
  // every line number. A citation still has to land on a line containing it.
  const { root } = fixture()
  const hallucinated = gradeAnswer(root, "agent/score.py:5", "7")
  assert.equal(hallucinated.ok, false)
})

test("gradeAnswer reports every citation so a wrong answer can be read", () => {
  const { root, passLine } = fixture()
  const r = gradeAnswer(root, `agent/score.py:${passLine} and agent/other.py:1`, "total >= 55")
  // One citation holds and one does not. The point of returning every reference
  // is that a wrong answer can be read rather than guessed at.
  assert.equal(r.ok, true)
  assert.equal(r.cited, 2)
  assert.equal(r.refs.find((x) => x.file === "agent/score.py").status, "match")
  assert.equal(r.refs.find((x) => x.file === "agent/other.py").status, "line-mismatch")
})