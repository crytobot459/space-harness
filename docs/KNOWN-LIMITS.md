# Known limits

Written down so nobody spends a day rediscovering them.

## Model failover happens at the next session, never mid-flight

No OpenCode plugin hook can change the model of a running session. Verified by
reading `Hooks` in `@opencode-ai/plugin@1.18.31`:

| hook | can it change the model? |
|---|---|
| `chat.params` | No. Output is `temperature`, `topP`, `topK`, `maxOutputTokens`, `options`. |
| `chat.message` | No. `model` and `variant` on the input are read-only. |
| `experimental.provider.small_model` | Only the small model. |
| `config` | Yes, but it runs once at startup. |
| `provider` | Can add or override models in the catalog, not the active session. |

So `router.ts` does two things instead of the obvious third: at startup it
moves to the next healthy profile, and when a request fails it tells the agent
plainly that a new session is the fix. It does not pretend to retry.

The gap is real and tracked upstream. Provider issue #42977 asks Zen for a
`scope` field and a remaining-quota figure on 429 responses, precisely because
a client cannot currently tell a short quota window from a permanent block.

## Retry on 429 is deliberately not attempted

Zen free routes return `429 FreeUsageLimitError`, and #42977 documents models
staying blocked for **10+ days** without recovery. The `Retry-After` header
measured by the reporter points at 00:00 UTC, so the window is daily. The
maintainers' own guidance is to mark the route unhealthy rather than retry.

Retrying inside a session would burn turns against a wall. Marking it
unhealthy and failing over at the next start is the honest behaviour.

## Free models get withdrawn quickly

From one install's 20-day history, free model slots turned over in days:

| model | observed lifetime |
|---|---|
| `mimo-v2.5-free` | 1 day |
| `big-pickle` | 1 day |
| `nemotron-3-ultra-free` | 3 days |
| `muse-spark-1.3-contributor-free` | still running at 20 days |

Zen states free models are available "for a limited time" with no date. Treat
profiles as perishable: run `oc-harness doctor`, which re-checks each profile
against live metadata and reports drift.

## A model-driven compressor is not assumed to work

`@tarquinen/opencode-dcp` (4.3k stars) exposes a `compress` tool so the model
chooses when to compact. That is a better design in principle, and it is
AGPL-3.0, and it depends on a model remembering to call a tool.

This kit targets models with weak instruction following, so `prune.ts` is
deterministic and unconditional. If you want both, install DCP for its
deduplication and purge-errors passes and let this handle the floor. Check
whether its `compress` tool actually fires on your model before assuming it
does; if it does not, `prune.ts` is doing the work anyway.

## Pruning is an approximation

`prune.ts` keeps pointers rather than bodies. Full tool output is not deleted
from the session record, and OpenCode already writes over-cap output to its own
truncation directory, so re-reading is possible. But "re-run the command to see
it again" is more expensive than "scroll up". The stub is one line precisely so
an agent can decide whether it is worth it, and the stub says so.

`baseline.mjs` measures permission pressure with its own glob approximation of
OpenCode's matcher, not OpenCode's matcher. It handles the cases that matter
(bare commands, embedded newlines) but a discrepancy in the last few percent is
possible. Treat the ratio as a guide, not an exact count.

## What this kit does not do

It does not implement memory persistence, worktree orchestration, a context
compressor, or a session UI. Those exist and are good:

| need | use |
|---|---|
| model-driven compression | `@tarquinen/opencode-dcp` |
| cross-harness context proxy | `sleev.ai` |
| persistent memory | `opencode-supermemory` |
| git worktrees | `kdcokenny/opencode-worktree` |
| memory in git markdown | `code-yeongyu/oh-my-opencode` (now `omo`) |
| agent DAGs | `spoons-and-mirrors/subtask2` |

The gap this kit fills is the one between a provider catalog and a config file:
capability and privacy metadata in, a working harness out, with a command to
re-check that the metadata has not rotted.

## Verification methodology

Read
[Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents](https://arxiv.org/abs/2609.00006)
(arXiv:2609.00006) before extending this. It dissects eleven production
harnesses along seven subsystems and catalogues 29 recurring patterns. Two of
its findings shaped the design here:

- No harness in the corpus uses embedding-based retrieval over code. Everything
  runs on ripgrep, tree-sitter, glob, and auto-discovered markdown. An earlier
  draft of this project proposed GraphRAG; that was wrong.
- `syntax-aware command permissioning` is a named pattern, which is why
  `guard.ts` splits on shell separators instead of matching a raw string.

The paper's own advice applies: build these components knowing that some will
stop being necessary as models improve.
