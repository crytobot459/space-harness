# Measured results

Numbers the kit actually produced on a real install, and how far to trust them.
Regenerate with:

    npm run measure            # human-readable table
    npm run measure -- --json  # machine-readable
    npm run measure:check      # same, but exits 1 if the kit regresses
    npm run attribute          # where the context actually went

The source is the install database, opened read-only. Nothing here is estimated
and nothing is estimated from a synthetic transcript: `eval/run.mjs` covers the
pruner and the allowlist, and cannot say anything about how the agent reads.

Everything in this file comes from the commands above. The A/B section at the
bottom runs the same task with and without the kit; it is six agent runs, which
is enough to be worth reading and not enough to be worth trusting.

## Method

Three edges divide the database into two windows:

- **split** - when the kit was installed, taken from the mtime of
  `~/.config/opencode/agents`, which `oc-harness install` creates and nothing
  else does.
- **before** / **after** - the outer bounds of the two windows.

`npm run measure` defaults the before-edge to seven days before the split.
`--before` can push it back to the start of the database, which is how the
original baseline in `README.md` was reproduced.

A read counts as **narrow** when the caller bounded it with `offset` or
`limit`. `README.md` counted `offset` alone; that is the 423 figure below, and
this script's 501 is the same reads plus the ones bounded only by `limit`.

## Result 1 - the week before versus since the install

    npm run measure

| Metric | before (Oct 1 - Oct 8) | after (Oct 8 - Oct 10) | change |
| --- | --- | --- | --- |
| read calls | 767 | 280 | -63% |
| narrow reads | 229 (29.9%) | 184 (**65.7%**) | +35.8 pt |
| grep/glob calls | 61 | 66 | +8% |
| reads per search | 12.6 | **4.2** | -67% |
| assistant messages | 5,616 | 1,562 | |
| avg context per request | 158,917 | 67,642 | **-57.4%** |
| avg reasoning tokens | 151 | 63 | -58% |

Searching more and reading three times less per search is the intended shape of
the change. The instruction file is what moved it: it tells the agent to locate
before reading, and the narrow-read share is the direct trace of that.

## Result 2 - the full history, reproducing the published baseline

    npm run measure -- --before 2026-09-17T15:38:46.850Z

| Metric | before (Sep 17 - Oct 8) | after | change |
| --- | --- | --- | --- |
| read calls | 2,966 | 280 | |
| narrow reads | 501 (16.9%) | 184 (65.7%) | |
| grep/glob calls | 249 | 66 | |
| reads per search | 11.9 | 4.2 | -65% |
| avg context per request | 123,776 | 67,642 | **-45.4%** |

This reproduces the `2,966 reads / 249 searches / 11.9` baseline published in
`README.md` exactly, which is the check that the measurement is reading the same
things the earlier one did. The before-window here starts at the beginning of
the database, so it is wider than the default and the before-numbers differ.

## Result 3 - why the context fell, decomposed

    npm run attribute

Result 2 shows context per request down 45%. It does not say which part of the
context moved. There are two, and they behave independently:

- **fixed overhead** - the system prompt and tool definitions, resent on every
  request. Paid on turn one, before any work happens.
- **history** - what the conversation has accumulated since: tool output, files
  read, the agent's own earlier messages.

Per session:

| | before | after | delta |
| --- | --- | --- | --- |
| sessions | 154 | 48 | |
| turns per session | 79.1 | 35.2 | |
| fixed overhead | 8,236 | 8,705 | **+469** |
| context at end | 68,648 | 18,285 | |
| history | 60,412 | 9,580 | **-50,832** |
| history per turn | 763.4 | 272.4 | **-491** |

The kit's own cost is visible and it is positive: **+469 tokens on every single
request**, which is `GLOBAL.md` plus the agent definitions plus the plugin
prompts. Nothing about the kit made the system prompt shorter.

Everything it bought is in the other column. History per session fell by 84%, and
per turn by 64%. The per-turn column is the one that matters, because sessions
also got shorter - 79 turns to 35 - and shorter sessions accumulate less history
for free. Normalising for turns, the kit is still responsible for a 64% drop.

That is the mechanism the whole kit rests on, and it is the one thing the
correlation in Results 1 and 2 could not show. The kit does not shrink what it
costs; it shrinks what the agent drags along behind it.

## What these numbers do not prove

**The two windows are not the same work.** The before-window is dominated by
building this kit - reading source is what that job was. The after-window is
ordinary use. Part of the drop is the kit working; an unknown part is simply a
different mix of tasks. Nothing here separates the two.

**The after-window is thin.** 280 reads over roughly two days, and the script
flags this itself as `thin_sample`. One quiet day moves these numbers more than
the kit does. Treat the direction as a hint, not a result.

**Narrow reads are a proxy.** A bounded read that then has to be re-read with a
second bounded read is not cheaper than one whole-file read. This counts the
first read and ignores the follow-up.

**Nothing above is an A/B.** The windows in Results 1 and 2 are the same install
observed over time, and they compare different work. The section below runs one
fixed task twice - kit on, kit off - which is the only comparison here that can
say anything about cause.

## The A/B

    node eval/ab.mjs --target <dir> --suite eval/tasks.json --reps 2 --sanitize

**This section has replaced itself twice, and both times it was wrong.** The
first version ran one task three times per arm and read 2/3 against 1/3 in
favour of the kit. The second ran four tasks, sixteen runs, and read the kit as
1.8x faster. The third run, twenty runs and five tasks including a multi-step
lookup and an edit, reverses that: the kit is **slower**, 25.4s against 17.4s.

The speed number is not real at either sample size. Between the two suite runs
it changed sign. Treat every wall-clock figure in this file as noise until
someone runs enough reps to pin it, and treat the correctness column as the only
one that survived every version.

Ten reps per arm across five tasks, alternating so drift in the model route
lands on both sides. Kit-off is a throwaway `HOME` with no `~/.config/opencode`,
so the instruction file, the agent definitions and the plugins are all absent;
`OPENCODE_CONFIG` and `--pure` do **not** achieve this, both still load
`GLOBAL.md`. The subject is a `git archive` snapshot of `lablab-harness` at
`8a674f5`, so both arms read identical bytes.

The four read tasks differ in shape: one control lookup in a single file, and
three that cannot be answered without enumerating candidates first, because the
repository defines `OUT` in six modules and `BASE` in nineteen. The fifth task
asks for an edit and is graded by reading the file afterwards.

| Metric (median of 10) | kit on | kit off |
| --- | --- | --- |
| wall seconds | 25.4 | **17.4** |
| tool calls | 5.5 | 3 |
| narrow reads | 100% | 66.7% |
| final context | 15,246 | 14,301 |
| correct (read tasks) | **8 / 8** | **8 / 8** |
| correct (edit task) | 2 / 2 | 2 / 2 |
| not scored (edit, run copies discarded) | 2 | 2 |

**The kit is not faster and not more accurate.** Both arms answered every read
task correctly and made every edit. The one apparent kit-off miss in the raw run
was an ambiguity in the task, not an error: `agent/judge.py` has two real submit
guards, line 345 rejecting `total < 5` and line 348 rejecting `total < 7`, and
the run cited line 345, which is a correct answer to a question that did not say
which one it wanted. The task now names the threshold. After that fix both arms
are 8/8.

The context figures moved by less than 7% and in the direction opposite to
Result 2 and 3, which is another reason not to read much into them.

### What this does not establish

- **n=10 per arm, five tasks, one repository, one language.** Twenty agent runs.
  Correctness is a tie; a tie on twenty runs is not proof of equivalence.
- **The speed difference changed sign between two suite runs.** 18.4 against
  32.7, then 25.4 against 17.4. Nothing in this file can support a speed claim.
- **The subject is a Python repo, not TypeScript.** The kit's own code is
  TypeScript and is untested here.
- **Four of five tasks are still lookups.** The edit task is one line in one
  file. Nothing here measures a long multi-step refactor, where a stricter
  reading habit might cost more than it saves.
- **Wall clock is not controlled for load.** Arms alternate, which helps, but
  twenty runs share one model route.

### What went wrong getting here

Six measurement bugs survived long enough to be written down here as results.
The pattern is the same in every case: a tool I wrote reported a number, and the
number looked plausible. Four were in the grader, one was a sample too small to
mean anything, and one was my own task wording. Not one was a wrong answer from
the agent.

**The grader could not read the shape models actually answer in.** A run wrote
`**File:** \`agent/score.py\` **Line:** 214` and quoted the line perfectly. The
citation pattern required digits to follow the word "line" directly, so the
markdown emphasis and the colon broke it and a correct answer scored zero. It
cost 9/10 against 9/10 on both arms, and `--rescore` was added so that fixing a
grader no longer costs twenty agent runs.

**A run that never started was scored as a wrong answer.** One kit-off run
emitted zero bytes and was killed at the timeout. Counting its zero tools, zero
tokens and zero answer made the agent look like it did nothing. Runs that emit
nothing are now excluded from every figure and reported separately as not scored.

**The subject leaked its way out of the sandbox.** The snapshot contained 14
absolute paths that resolve on this machine, including one to a checkout
unrelated to this work. A kit-on agent read a README, followed one, and opened
files in the real `lablab-harness` tree - read-only, and only by luck of what it
did next. `ab.mjs` now scans the subject for such paths and refuses to run
unless they are scrubbed or explicitly allowed.

**A sample of six runs was written up as a finding.** This section originally
claimed the kit answered better, 2/3 against 1/3. Widening the sample removed
it, and the next suite reversed the speed claim too. Neither would have been
caught by any arithmetic.

**The task was ambiguous, twice.** First it asked for "the threshold the total
score must reach for pass to be true", which has two answers in the repository:
`agent/score.py:214` assigns `"pass": total >= 55` and `agent/judge.py:348` is a
submit gate on a different scale. Then it asked for "the comparison that rejects
a too-low total" and `judge.py` turned out to have two real guards, line 345
rejecting `total < 5` and line 348 rejecting `total < 7`; a kit-off run cited
line 345, which is a correct answer to the question as posed, and was scored
wrong. Both tasks now name the thing they want.

**Durations were ten times too large.** OpenCode event timestamps are in
milliseconds; `ab.mjs` divided by 100. A 4.4 minute run was reported as 44
minutes and every duration in the first version of this table was scaled by 10.
The ratios were unaffected, which is exactly why it went unnoticed - only
checking an absolute number against a wall clock catches a constant factor.
`elapsedSeconds()` now lives in `metrics.js` with a test that pins the unit.

**The correctness matcher was too loose, in the other direction.** Both arms
independently found `judge.py:348`, so `--expect` learned to accept
alternatives separated by `|`. Written as `--expect "judge.py|7"` it accepted any
answer containing the digit 7, which is any line number, and reported 3/3
against 1/3 on answers that had not found the file at all.

The first pilot produced no usable number either, for a reason worth recording.
Nested inside a running opencode session, `opencode run` inherits the *parent*
session's project directory. Both arms ignored the target entirely and read
`/Users/admin/harness/space-harness`; the kit-off arm ran 15 file paths and 9
shell commands there. The prompt said not to modify anything. It modified
something anyway - it reverted a change to `package.json`, which had to be
reapplied.

Two fixes came out of that. `ab.mjs` now passes `--dir` explicitly, and it stops
the whole experiment the moment any arm names a path outside the target. That
detector is not theoretical: replaying the original streams through it reports
3 escaped paths for the kit-on arm and 15 for the kit-off arm, matching a manual
count. All sixteen runs above report 0.

Per-run timeout is in as well, since one kit-off run once took 4.4 minutes with
nothing to show for it and nothing was stopping it.

## The gate

`npm run measure:check` fails when either the narrow-read share drops below 50%
or average context per request stops falling by at least 20%. Both hold today
with room to spare (65.7% and 45.4%). The thresholds are set well below the
current values on purpose: the point is to catch a regression, not to re-litigate
whether the last change helped.

It reports but never gates on `thin_sample`, so it cannot fail a run for being
small - only the floor is enforced.

## Not measured here

- Whether the agent's *answers* got better in general. One task, six runs.
- Whether the numbers in Results 1 and 2 were caused by the kit. Result 3 shows
  a mechanism that would produce them; the A/B points the same way on a
  different task. Neither window separates the kit from the work.
- Which part of the kit does the work. Result 3 localises the effect to history
  accumulation, not to any individual rule or plugin.
- Pruner bytes saved. `eval/run.mjs` reports it; `.space/prune.jsonl` records it.
- Whether the free model route is healthy. `oc-harness doctor` answers that and
  needs the network, so it is deliberately outside these scripts.