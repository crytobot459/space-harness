---
name: space-build
description: Implement one planned task and verify it with a real command. Use when the plan is settled and files need to change.
---

# Build one task, then prove it

## Steps

1. **Locate before you read.** `grep`/`glob` for the candidate files, then
   `read` with an `offset`/`limit` for the range you need. Reading whole files to
   find out where something lives was the most expensive habit measured on this
   setup: 2,966 full-file reads against 249 searches, about twelve per search.
2. **Read the whole file before editing it** - not a grep hit, the file. Partial
   reads produce edits that contradict code you did not see.
3. **Make the smallest change** that satisfies the task. If the task is bigger
   than it looks, stop and say so rather than quietly expanding it.
4. **Run the verify command the plan named.** That command, not a different one,
   not a subset.
5. **On failure, read the actual message.** Not the last ten lines, the error.
   Fix the cause, then run it again. The third identical attempt is a signal to
   stop and report.
6. **Report the command and its verbatim output.**

## Test-first when the plan called for it

If the plan said test first, write the failing test and watch it fail. A test
that has never failed has not been shown to test anything.

## Never

- Leave a `TODO`, a stub, or a commented-out block for later. Partial work
  reported as complete is the failure mode this exists to prevent.
- Widen the task. A drive-by refactor belongs in its own plan.
- Skip a failing test to get to green. Report it.
- Claim a result you did not run.

## Handing back

Which task, which command, which result. If anything is unfinished, list it
explicitly rather than letting the review step find it.

**If you were handed back here by `space-review`**, you have a blocker with a
`file:line` and a failing command, not a fresh task. Fix that specific thing.
Do not re-read the plan, do not look for other improvements, and do not treat
the review as a suggestion. A blocker that gets fixed together with a refactor
cannot be verified on its own.
