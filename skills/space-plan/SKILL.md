---
name: space-plan
description: Turn a vague request into an executable plan before any code is written. Use when a task is ambiguous, touches several files, or two people could disagree about done.
---

# Plan before building

Most wasted agent time is not bad code, it is solving the wrong problem well.

## When this applies

Use it when any of these is true:

- The request has no single obvious file to change.
- Nobody could tell from the diff whether the task was finished.
- More than one design would satisfy the wording.
- The task is a feature rather than a fix.

Skip it for a single obvious edit. Writing a plan for `fix the typo` is waste.

## Steps

1. **Read first.** Grep the file names that must be involved and read them. A
   plan built on assumed paths is worse than no plan: it reads as confident and
   sends the build step to the wrong place.
2. **State the goal in one sentence, in the caller's words.** If you cannot,
   you do not understand the request yet. Ask one specific question. Do not ask
   five.
3. **List the constraints.** What must not change. What is out of scope. What
   already exists that must keep working.
4. **Break it into tasks that fit in a few minutes each.** For every task:
   - exact file paths
   - the concrete change, not "handle errors"
   - the verify command, and what passing looks like
5. **Order so the repository stays working.** Every step should leave the tests
   green. A plan whose middle step is red is a plan that gets abandoned.
6. **Name the risks** and the cheapest way to find out early.

## What to hand off

A markdown plan. Then dispatch each task to `build` one at a time, and
`reviewer` after the set. Use `scout` to close gaps in your evidence first.

## Failure modes

- Planning from the request alone, without reading code. This is the main one.
- Tasks sized "and then the rest". They cannot be verified, so they are not tasks.
- A plan that requires a decision you cannot make. That is a question, and it
  belongs at the top, not buried in task 6.
