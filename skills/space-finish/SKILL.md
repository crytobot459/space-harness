---
name: space-finish
description: Close out a task: confirm checks, summarise the change, and hand the publish decision to a human. Use when work is implemented and reviewed.
---

# Finish

## Steps

1. **Run the checks one final time, on the final state of the tree.** A green
   suite from before the last edit is not a green suite. Use `verify`.
2. **Read the diff once more as a whole.** Reviewers read task by task; you
   read the change as someone who has never seen it will.
3. **Check the documentation.** Did this change make a document describe
   something that no longer exists? Fix the document, do not note it for later.
4. **Write the summary** a person needs in order to trust the change without
   reading the whole diff.

## Summary shape

- What changed, in one sentence.
- Which checks ran and their results, verbatim.
- What was deliberately not done, and why.
- Anything risky or irreversible.

## The publish boundary

Publishing is a human action. Do not `git push`, do not open a pull request, do
not publish a package, do not change repository visibility, even if the task
seems to imply it. The guard will block `git push` in code, but the boundary
is yours to hold, not only the hook's.

Leave the tree in a state a human can review: on a branch, with the change
visible in `git diff`.

## Do not

- Do not declare success over a failing check.
- Do not squash, rebase, or force-push to tidy history.
- Do not delete a failing test to make the suite green. A reported failure is
  information; a deleted test is lost information.
