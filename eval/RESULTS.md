# Measured results

Numbers the kit actually produced on a real install, and how far to trust them.
Regenerate with:

    npm run measure            # human-readable table
    npm run measure -- --json  # machine-readable
    npm run measure:check      # same, but exits 1 if the kit regresses

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

    node eval/ab.mjs --target <dir> --task "<prompt>" --reps 3 --expect judge.py

**Six agent runs, one task, one repository. Read the table, not the headline.**
Neither column is a verdict. The wall-clock gap is carried by a single kit-off
run, and the correctness gap is two runs out of six. Anyone quoting a ratio out
of this section is quoting a sample of six.

Three reps per arm, alternating so drift in the model route lands on both sides.
Kit-off is a throwaway `HOME` with no `~/.config/opencode`, so the instruction
file, the agent definitions and the plugins are all absent; `OPENCODE_CONFIG`
and `--pure` do **not** achieve this, both still load `GLOBAL.md`. The subject
is a `git archive` snapshot of another repository, so both arms read identical
bytes.

Task: find the file, line and threshold that decide whether a submission passes.
The answer is `agent/judge.py:348`, `total >= 7`.

| Metric (median of 3) | kit on | kit off |
| --- | --- | --- |
| wall seconds | 146.8 | 423.7 |
| tool calls | 7 | 3 |
| grep/glob | 3 | 1 |
| read calls | 2 | 1 |
| final context | 15,943 | 13,169 |
| answers naming `judge.py` | 2 / 3 | 1 / 3 |
| paths outside target | 0 | 0 |

Per run, kit off took 2,626.8s, 423.7s and 73.3s; kit on took 154.7s, 146.8s and
84.7s. Medians, not means - one 44-minute outlier would dominate a mean of three
and make the kit look three times slower than it is.

Most of both columns is carried by that single kit-off outlier, which made zero
Most of both columns is carried by that single kit-off outlier, which made three
bash calls, zero searches, zero reads in 44 minutes and returned the wrong file.
Strip it out and the remaining two kit-off runs bracket the kit-on runs. Treat
the table as one good result and one bad one, not as a ratio.

### What this does not establish

- **n=3, one task, one repository.** The whole finding rests on six agent runs.
  A different task could invert it, and nothing here says it will not.
- **The subject is a Python repo, not TypeScript.** The kit's own tests and
  effects are elsewhere.
- **Correctness is scored by substring match, and the first matcher was too
  loose.** Both arms independently found `judge.py:348`, so `--expect` learned to
  accept alternatives separated by `|`. Written as `--expect "judge.py|7"` it
  then accepted any answer containing the digit 7, which is any line number, and
  reported 3/3 against 1/3. That 3/3 was the matcher failing, not the kit. The
  table above scores strictly on `judge.py` and reads 2/3 against 1/3. Keep `|`
  for genuinely equivalent answers and never for a bare digit.
- **Wall clock is not controlled for load.** Arms alternate, which helps, but
  six runs share one model route.

### What went wrong getting here

The first pilot produced no usable number, for a reason worth recording.
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
count. The three reps above all report 0.

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
- Whether the numbers in Results 1 and 2 were caused by the kit. The A/B points
  the same way, on a different task; the windows still do not.
- Pruner bytes saved. `eval/run.mjs` reports it; `.space/prune.jsonl` records it.
- Whether the free model route is healthy. `oc-harness doctor` answers that and
  needs the network, so it is deliberately outside this script.