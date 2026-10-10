// The arithmetic that turns a transcript into a verdict. If these drift, the
// gate in `npm run measure:check` silently starts passing or failing on noise,
// so the rounding and the empty-sample cases are pinned here rather than left
// to whatever the database happens to hold on the day.

import { test } from "node:test"
import assert from "node:assert/strict"

import { pct, readsPerSearch, ctxDropPct, historyPerTurn, payback, elapsedSeconds } from "../eval/metrics.js"

test("pct reports the share of narrow reads", () => {
  assert.equal(pct(181, 277), 65.3)
  assert.equal(pct(501, 2966), 16.9)
  assert.equal(pct(0, 100), 0)
  assert.equal(pct(100, 100), 100)
})

test("pct survives an empty window instead of printing NaN", () => {
  // A fresh install has no before-window. NaN there would compare false against
  // every threshold and quietly pass the gate.
  assert.equal(pct(0, 0), 0)
  assert.ok(Number.isFinite(pct(0, 0)))
})

test("readsPerSearch divides by search calls, not by reads", () => {
  assert.equal(readsPerSearch(277, 65), 4.3)
  assert.equal(readsPerSearch(2966, 249), 11.9)
})

test("readsPerSearch returns null when there is nothing to divide by", () => {
  assert.equal(readsPerSearch(0, 0), null)
  assert.equal(readsPerSearch(42, 0), null)
})

test("ctxDropPct measures the reduction, and is null without a baseline", () => {
  assert.equal(ctxDropPct(123771, 68836), 44.4)
  assert.equal(ctxDropPct(1000, 1000), 0)
  assert.equal(ctxDropPct(0, 500), null)
})

test("ctxDropPct goes negative when context grew", () => {
  // A regression must show as a number the gate can reject, not as silence.
  assert.equal(ctxDropPct(1000, 1500), -50)
})

test("historyPerTurn divides accumulated history by turns", () => {
  assert.equal(historyPerTurn(60412, 79.1), 763.7)
  assert.equal(historyPerTurn(9580, 35), 273.7)
})

test("historyPerTurn returns null when a session had no turns", () => {
  assert.equal(historyPerTurn(5000, 0), null)
})

test("payback is decided by the sign of the two deltas together", () => {
  // The measured case: +469 per request, -50832 per session.
  assert.equal(payback(469, -50832), true)
  // A kit that adds cost and takes nothing back does not pay.
  assert.equal(payback(469, -100), false)
  // A kit that adds nothing and removes history still pays.
  assert.equal(payback(0, -1), true)
})

test("elapsedSeconds converts opencode millisecond timestamps", () => {
  // Event timestamps are milliseconds. Dividing by 100 instead of 1000 reported
  // a 4.4 minute run as 44 minutes in RESULTS.md.
  assert.equal(elapsedSeconds(1791594309947, 1791594572628), 262.7)
  assert.equal(elapsedSeconds(0, 1000), 1)
  assert.equal(elapsedSeconds(500, 500), 0)
})

test("elapsedSeconds refuses to invent a duration from bad input", () => {
  assert.equal(elapsedSeconds(null, 1000), null)
  assert.equal(elapsedSeconds(0, undefined), null)
})