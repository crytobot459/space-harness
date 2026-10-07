#!/usr/bin/env node
// baseline.mjs - measure a real OpenCode install so pruning thresholds are
// grounded in numbers instead of guesses.
//
//   node bin/baseline.mjs                       human-readable report
//   node bin/baseline.mjs --json > out.json     machine-readable
//   node bin/baseline.mjs --db /path/to.db      override the database
//
// Node 22 has no node:sqlite, so we shell out to the sqlite3 CLI in
// read-only mode. Everything is aggregated in SQL, nothing is buffered twice.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const wantJson = args.includes("--json")
const dbArg = args.indexOf("--db")
const DB = dbArg >= 0 ? args[dbArg + 1] : join(homedir(), ".local/share/opencode/opencode.db")

if (!existsSync(DB)) {
  console.error(`opencode database not found: ${DB}`)
  console.error("pass --db <path> or run opencode at least once first")
  process.exit(1)
}

function query(sql) {
  const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return out ? JSON.parse(out) : []
}

const ASSISTANT = `json_extract(data,'$.role')='assistant'`

// Approximate percentile via row_number: pick the value at rank p*total.
function percentile(expr, p) {
  const rows = query(
    `select v from (
       select ${expr} as v, row_number() over (order by ${expr}) as rn,
              count(*) over () as total
       from message where ${ASSISTANT} and ${expr} is not null
     ) where rn = cast(max(cast(total * ${p} as integer), 1) as integer)`,
  )
  return rows[0]?.v ?? null
}

// NOTE: SQLite's OR is strictly logical and yields 0/1, not the first truthy
// operand like MySQL. `sum(x or 0)` therefore sums booleans. Use coalesce.
const IN = "coalesce(json_extract(data,'$.tokens.input'), 0)"
const CREAD = "coalesce(json_extract(data,'$.tokens.cache.read'), 0)"
const CTX = `(${IN} + ${CREAD})`
const OUT = "coalesce(json_extract(data,'$.tokens.output'), 0)"
const REA = "coalesce(json_extract(data,'$.tokens.reasoning'), 0)"

const totals = query(
  `select
     (select count(*) from session)                                   as sessions,
     (select count(distinct date(time_created/1000,'unixepoch','localtime')) from session) as days,
     count(*)                                                        as messages,
     sum(${IN})   as input, sum(${OUT}) as output,
     sum(${REA})  as reasoning, sum(${CREAD}) as cache_read,
     (select count(*) from session where time_compacting is not null) as compacted,
     (select coalesce(sum(cost),0) from session)                      as cost
   from message where ${ASSISTANT}`,
)[0]

const ctx = {
  p50: percentile(CTX, 0.5),
  p90: percentile(CTX, 0.9),
  p99: percentile(CTX, 0.99),
  max: query(`select max(${CTX}) as v from message where ${ASSISTANT}`)[0]?.v ?? 0,
}

const freshInputP50 = percentile(IN, 0.5)

const finish = query(
  `select coalesce(json_extract(data,'$.finish'),'(none)') as finish, count(*) as n
   from message where ${ASSISTANT} group by 1 order by n desc`,
)

const byModel = query(
  `select json_extract(data,'$.providerID') || '/' || json_extract(data,'$.modelID') as model,
          coalesce(json_extract(data,'$.variant'),'(default)') as variant,
          count(*) as messages,
          sum(${OUT}) as output, sum(${REA}) as reasoning,
          sum(${CREAD}) as cache_read, sum(${IN}) as input
   from message where ${ASSISTANT}
   group by model, variant order by cache_read desc`,
)

// Median seconds per assistant request, per model+variant. Effort tiering only
// pays off if max is actually slower than the tiers below it.
const DURATION =
  "(json_extract(data,'$.time.completed') - json_extract(data,'$.time.created')) / 1000.0"
const MODEL_ID = "json_extract(data,'$.providerID') || '/' || json_extract(data,'$.modelID')"
const VARIANT = "coalesce(json_extract(data,'$.variant'),'(default)')"
const medianLatency = query(
  `select model, variant, printf('%.1f', ms) as median_ms from (
     select model, variant, ms, row_number() over (partition by model, variant order by ms) as rn,
            count(*) over (partition by model, variant) as total
     from (select ${MODEL_ID} as model, ${VARIANT} as variant, ${DURATION} as ms
           from message
           where ${ASSISTANT} and ${DURATION} is not null and ${DURATION} > 0)
   ) where rn = cast(max(cast(total / 2 as integer), 1) as integer)`,
)

// Share of stored message bytes by part type - the reason context bloats.
const partBytes = query(
  `select json_extract(data,'$.type') as type, count(*) as n, sum(length(data)) as bytes
   from part group by 1 order by bytes desc`,
)
const partTotal = partBytes.reduce((a, r) => a + (r.bytes ?? 0), 0) || 1

// Permission pressure: how many historical bash commands would prompt.
const BASH = `json_extract(data,'$.type')='tool' and json_extract(data,'$.tool')='bash'`
const bashRows = query(
  `select json_extract(data,'$.state.input.command') as cmd from part where ${BASH}`,
)
const cmds = bashRows.map((r) => (r.cmd ?? "").trim()).filter(Boolean)

// Approximation of opencode's permission glob: `X *` means "X " followed by
// anything, so it does NOT match a bare `X`; the `X*` form covers both.
// [\s\S] rather than . because stored commands often embed newlines
// (heredocs, python3 -c "..."), and `.` does not cross a newline.
function glob(cmd, pat) {
  const re = new RegExp(
    "^" +
      pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") +
      "$",
  )
  return re.test(cmd)
}
const allowed = (c) => kitAllowlist.some((p) => glob(c, p))
const topAskers = () => {
  const heads = new Map()
  for (const c of cmds) {
    if (allowed(c)) continue
    const p = c.split(/\s+/)
    let h = p[0] ?? "?"
    if (["git", "npm", "bun", "uv", "ssh", "curl", "python3", "npx"].includes(h) && p[1]) {
      h += " " + p[1]
    }
    heads.set(h, (heads.get(h) ?? 0) + 1)
  }
  return [...heads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([head, count]) => ({ head, count }))
}

const kitAllowlist = [
  // read-only inspection - `X*` covers both `X` and `X <args>`
  "ls*", "cat*", "head*", "tail*", "wc*", "file*", "stat*", "pwd*", "env*", "printenv*",
  "date*", "whoami*", "which*", "find*", "tree*", "du*", "df*", "lsof*", "sed*", "awk*",
  "sort*", "uniq*", "diff*", "grep*", "rg*", "echo*", "printf*", "sleep*",
  "cd*", "realpath*", "basename*", "dirname*", "readlink*",
  // shell plumbing and comments
  "for*", "set*", "export*", "unset*", "bash*", "sh*", "true*", "false*", "test*",
  "read*", "#*", "xargs*", "seq*", "exit*", ":*",
  // version probes
  "node*", "python3*", "python*", "npm*", "bun*", "uv*", "go*", "cargo*", "rustc*",
  "opencode*", "sqlite3*", "jq*", "fd*",
  // git read-only
  "git status*", "git log*", "git diff*", "git show*", "git branch*",
  "git rev-parse*", "git config --get*", "git remote*", "git blame*",
  "git stash list*", "git ls-files*", "git describe*", "git shortlog*", "git --version*",
  // verification and builds
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1*", "PYTHONPATH=*", "PYTHONUNBUFFERED=1*",
  "python3 -m pytest*", "python3 -m venv*", "python3 -m compileall*",
  "python3 -c*", "python3 agent/*", "python3 src/*", "python3 -",
  ".venv/bin/python*", "pytest*", "ruff*", "mypy*", "black*",
  "npm test*", "npm run *", "npm ci*", "npm ls*", "npm view *",
  "npx*", "uv run *", "uv pip *", "bun run *", "bunx*", "node -e*",
  "opencode debug*", "opencode --version*", "opencode models*",
]
const currentAllow = [
  "git status *", "git log *", "git diff *", "grep *",
  "python3 src/main.py *", "python3 -m pytest *",
]
const wouldAskNow = cmds.filter((c) => !currentAllow.some((p) => glob(c, p))).length
const wouldAskKit = cmds.filter((c) => !allowed(c)).length

// Cost if the same work had run on a paid route (reference rates, per 1M).
const RATE = { input: 0.15, output: 0.6, cacheRead: 0.03 }
const paidEquivalent =
  ((totals.input ?? 0) / 1e6) * RATE.input +
  ((totals.output + (totals.reasoning ?? 0)) / 1e6) * RATE.output +
  ((totals.cache_read ?? 0) / 1e6) * RATE.cacheRead

const report = {
  database: DB,
  generated: new Date().toISOString(),
  volume: {
    sessions: totals.sessions,
    days: totals.days,
    assistantMessages: totals.messages,
    compactionEvents: totals.compacted,
  },
  tokens: {
    input: totals.input ?? 0,
    output: totals.output ?? 0,
    reasoning: totals.reasoning ?? 0,
    cacheRead: totals.cache_read ?? 0,
    cacheToInputRatio: totals.input ? +((totals.cache_read ?? 0) / totals.input).toFixed(1) : null,
  },
  contextPerRequest: { ...ctx, freshInputP50: freshInputP50 },
  contextBuckets: [
    [0, 10_000], [10_000, 50_000], [50_000, 100_000],
    [100_000, 200_000], [200_000, 400_000], [400_000, Number.MAX_SAFE_INTEGER],
  ].map(([lo, hi]) => ({
    range: hi >= Number.MAX_SAFE_INTEGER ? `${lo}+` : `${lo}-${hi}`,
    count: query(
      `select count(*) as n from message where ${ASSISTANT} and ${CTX} >= ${lo} and ${CTX} < ${hi}`,
    )[0].n,
  })),
  storedBytesByType: partBytes.map((r) => ({
    type: r.type,
    count: r.n,
    megabytes: +((r.bytes ?? 0) / 1e6).toFixed(2),
    share: +(((r.bytes ?? 0) / partTotal) * 100).toFixed(1),
  })),
  finishReasons: finish,
  byModel: byModel.map((r) => {
    const lat = medianLatency.find((l) => l.model === r.model && l.variant === r.variant)
    return {
      model: r.model,
      variant: r.variant,
      messages: r.messages,
      reasoningShare:
        r.output + r.reasoning > 0
          ? +((r.reasoning / (r.output + r.reasoning)) * 100).toFixed(1)
          : 0,
      cacheRead: r.cache_read,
      medianSeconds: lat ? Number(lat.median_ms) : null,
    }
  }),
  permissionPressure: {
    bashCommands: cmds.length,
    wouldAskWithCurrentAllowlist: wouldAskNow,
    wouldAskWithKitAllowlist: wouldAskKit,
    currentPromptShare: cmds.length ? +((wouldAskNow / cmds.length) * 100).toFixed(1) : 0,
    kitPromptShare: cmds.length ? +((wouldAskKit / cmds.length) * 100).toFixed(1) : 0,
    topRemainingAskers: topAskers(),
  },
  cost: {
    recorded: +(totals.cost ?? 0).toFixed(2),
    paidRouteEquivalent: +paidEquivalent.toFixed(2),
    ratePerMillion: RATE,
  },
}

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const n = (x) => (x ?? 0).toLocaleString("en-US")
const m = (x) => `${((x ?? 0) / 1e6).toFixed(2)}M`
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-")

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`)

console.log(`\nopencode baseline  ·  ${DB}`)
console.log(`generated ${report.generated}\n`)

console.log("VOLUME")
line("sessions", n(report.volume.sessions))
line("days", n(report.volume.days))
line("assistant messages", n(report.volume.assistantMessages))
line("compaction events", `${n(report.volume.compactionEvents)}  ${report.volume.compactionEvents === 0 ? "(never fired)" : ""}`)

console.log("\nTOKENS")
line("input", m(report.tokens.input))
line("output", m(report.tokens.output))
line("reasoning", m(report.tokens.reasoning))
line("cache read", `${m(report.tokens.cacheRead)}  (${report.tokens.cacheToInputRatio}x input)`)

console.log("\nCONTEXT PER REQUEST")
line("p50", n(report.contextPerRequest.p50))
line("p90", n(report.contextPerRequest.p90))
line("p99", n(report.contextPerRequest.p99))
line("max", n(report.contextPerRequest.max))
line("fresh input p50", n(report.contextPerRequest.freshInputP50))
for (const b of report.contextBuckets) line(`  ${b.range}`, n(b.count))

console.log("\nSTORED MESSAGE BYTES")
for (const b of report.storedBytesByType) {
  line(b.type, `${String(b.megabytes).padStart(7)} MB  ${String(b.share).padStart(5)}%  (${n(b.count)} parts)`)
}

console.log("\nBY MODEL")
for (const r of report.byModel) {
  const lat = r.medianSeconds != null ? ` · ${r.medianSeconds}s median` : ""
  line(`${r.model} ${r.variant}`,
    `${n(r.messages)} msgs · reasoning ${r.reasoningShare}% · cache ${m(r.cacheRead)}${lat}`)
}

console.log("\nPERMISSION PRESSURE (historical bash commands)")
line("bash commands", n(report.permissionPressure.bashCommands))
line("prompt with current list", `${n(report.permissionPressure.wouldAskWithCurrentAllowlist)} (${report.permissionPressure.currentPromptShare}%)`)
line("prompt with kit allowlist", `${n(report.permissionPressure.wouldAskWithKitAllowlist)} (${report.permissionPressure.kitPromptShare}%)`)
console.log("\n  still prompts with kit allowlist (tune from here):")
for (const t of report.permissionPressure.topRemainingAskers) {
  line(`    ${t.head}`, n(t.count))
}

console.log("\nCOST")
line("recorded", `$${report.cost.recorded}`)
line("same work, paid route", `$${report.cost.paidRouteEquivalent}  @ $${RATE.input}/$${RATE.output}/$${RATE.cacheRead} per 1M`)
console.log()
