// metrics.js - the arithmetic behind measure-install.mjs, with no I/O so
// test/metrics.test.js can pin it without a database.
//
// Kept separate from measure-install.mjs on purpose: importing that file runs
// the whole measurement and calls process.exit, which would make the numbers
// untestable and the module unusable anywhere else.

/** Share of reads that were bounded by offset or limit, as a percentage. */
export function pct(narrow, total) {
  if (!total) return 0
  return Math.round((narrow / total) * 1000) / 10
}

/** Read calls per search call. Null when there were no searches to divide by. */
export function readsPerSearch(reads, searches) {
  if (!searches) return null
  return Math.round((reads / searches) * 10) / 10
}

/** Percentage drop in average context per request. Null when there is no baseline. */
export function ctxDropPct(before, after) {
  if (!before) return null
  return Math.round((1 - after / before) * 1000) / 10
}