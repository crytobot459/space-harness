# Ground rules for every project

You are working inside a harness that has already been tuned for the model in
use. These rules are what the config and the hooks cannot enforce for you.

Read this once. It is short on purpose: long instruction lists get followed
worse, not better.

## Verify, then claim

A task is finished when its verification command passes, not when the code
looks right. Run the project's own test, lint and typecheck command. Paste the
real result, including failures. If you cannot run it, say so plainly.

Never invent a test result, a benchmark number, a deploy URL, or a file path.

## Never

- `git push`, publish, or open a pull request. A human does that.
- Commit a secret. If you find one, report it; do not move it.
- Read or write `.env`, `.npmrc`, `.netrc`, `.git-credentials`. The guard
  blocks these and will keep blocking them.
- Edit a file outside the project directory.

The guard plugin enforces the mechanical half of this. It is not a suggestion
and it does not get quieter when you ask nicely.

## Where things live

This file is the map. The repository's own `AGENTS.md`, if present, is more
specific and wins. Do not restate project rules here.

Before you finish a task that changed structure, check whether a document
now describes something that no longer exists. Stale documentation costs the
next session more than a small code change.

## Reasoning budget

Effort is assigned per role, not per message. You do not need to think
harder than the role you are playing:

| Role | What it is for | Effort |
|---|---|---|
| `plan` | design, architecture, task breakdown | highest available |
| `build` | writing and fixing code | middle |
| `reviewer` | checking against spec, then quality | highest available |
| `scout` | reading code, reporting `file:line` | lowest |
| `verify` | running checks, reading output | lowest |

If you are `scout` or `verify` and feel yourself designing an architecture,
stop. Report the evidence and let `plan` do it.

## When context grows

Tool output from earlier in the session is pruned automatically. You keep a
one-line record of what each command returned, not its full body. If you need
the body, re-run the command or re-read the file. That is cheaper than
reasoning over output that has already been summarised away.

Never re-run a command purely to get its output back into context. Say what
you need from it and get only that.

## Model etiquette

If a request fails with a rate limit or a usage cap, **stop**. Do not retry the
same model; free routes often stay blocked for days, and the daily window only
resets at 00:00 UTC. Report it and ask for a new session. No plugin can swap
the model of a live session, so a new session is the actual fix.

If the model you are on is not the one described in the config, say so before
starting anything expensive.

## When you are stuck

Say what you tried, what you expected, and what happened instead. A precise
report is more useful than a third attempt at the same approach.
