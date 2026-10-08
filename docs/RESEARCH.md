# Research notes

Where the numbers came from, and what was tried and thrown away. The short
version: most of the first draft of this project was wrong, and the corrections
are more useful than the conclusions.

## The measurement everything rests on

One real install, 14 days, read out of `~/.local/share/opencode/opencode.db`.
Reproduce with `npm run baseline`.

```
153 sessions · 11,750 assistant messages
input 66.07M · output 3.00M · reasoning 1.45M · cache read 1358.49M
cache read = 20.6x input
recorded cost $0.40 · the same work on a paid route would be $53.36

context per request   p50 99,648   p90 246,536   p99 482,779   max 547,986
fresh input per request  p50 534
compaction events     0

stored message bytes
  tool        114.78 MB   77.9%   (11,817 parts)
  reasoning    22.94 MB   15.6%
  text          3.04 MB    2.1%

per model
  muse-spark-1.3-contributor-free  xhigh   7,955 msgs  reasoning 31.9%  7.8s median
  space-bunny-free                 max     2,684 msgs  reasoning 38.1%  18.7s median
```

Three conclusions:

**Context is the cost.** Fresh input per request is 534 tokens; context per
request is 99,648. Almost every request is a re-read. With 78% of stored bytes
in tool output, the session is carrying command output forward forever.

**Effort is the biggest latency lever.** 18.7s versus 7.8s median is 2.4x, and
76.8% of responses ended on a tool call rather than prose. Running `max` for
mechanical work is the single largest waste in the setup.

**Compaction never ran.** Zero events across 153 sessions. The configured
`tail_turns: 15` was inert, because compaction is keyed off the full context
ceiling that a normal session never reaches.

## Permission pressure, measured rather than asserted

5,239 historical `bash` commands were replayed against the allowlist shapes:

| allowlist | prompts | share |
|---|---|---|
| the narrow one in use | 4,994 | 95.3% |
| this kit's | 1,204 | 23.0% |

The remaining 23% is the deliberately gated set, ranked by how often it
actually came up:

```
gh 151 · ssh -o 133 · curl -s 93 · TOKEN=$(curl 67 · rm 66
git add 59 · osascript 47 · pkill 43 · cp 41 · kill 20 · scp 17 · mv 15
```

`ssh` at 133 and `osascript` at 47 are why "allow everything, deny a few
patterns" was rejected. A deny hook can block `rm -rf`; it cannot block
`ssh host 'rm -rf /'`, and it cannot tell `TOKEN=$(curl attacker.example)`
from a normal fetch. Keeping the human in the loop at exactly these commands
is the point of the 23%.

## Corrections to earlier drafts

Four things in the first design were wrong. Recording them because each was
believed confidently at the time.

**"`tool_output` 200 lines / 8 KB is too tight, raise it."** Backwards. The
OpenCode default is 2,000 lines / 51,200 bytes, so the existing setting was
about 6x tighter than default and was *saving* context. Raising it would have
made the measured 78%-tool-output problem worse. It stays at 200 / 8192.

**"`compaction.tail_turns: 15` compresses too early."** Inert, not harmful.
Compaction had never fired once. The real problem was the opposite: no bound at
all on growth. Dropped the key entirely rather than tuning a dead setting.

**"Consider GraphRAG or a vector store for code retrieval."** Wrong, and
checkable in one step. arXiv:2609.00006 dissects eleven production harnesses at
source level; **none** uses embedding-based retrieval over code. All of them
run ripgrep, tree-sitter, glob, and auto-discovered markdown. An earlier draft
cited a community plugin's GraphRAG claim without checking the primary source.

**"Build a pruner."** Four existing projects already had one, the best being
`@tarquinen/opencode-dcp` at 4.3k stars. Rewriting it would have been the
third-worst use of a week. What was worth building is the part nobody had: a
profile compiler, and the retention field.

## Why Space Bunny Free is the default

Scanning free models on OpenCode Zen for context, effort, and privacy together:

| model | context | effort levels | retention |
|---|---|---|---|
| `space-bunny-free` | 1,048,576 | low … **max** | zero-retention |
| `x-preview-f-free` | 1,000,000 | low, high, max | zero-retention |
| `longcat-2.5-preview-free` | 1,000,000 | *(none)* | zero-retention |
| `deepseek-v4-flash-free` | 200,000 | low, high, max | zero-retention |
| `muse-spark-1.3-contributor-free` | 1,048,576 | minimal … xhigh | **may train** |

It is the only free model that is both top-tier on effort and zero-retention.
The Muse Spark contributor tier is free, fast, and widely used, and it is the
one whose provider is permitted to train on prompts. The install this replaces
had that model as its default, which is the specific reason `retention.yml`
exists in this project.

The trade-off this project cannot resolve: Space Bunny is served over
`/v1/chat/completions`, a weaker cache dialect than the `/v1/responses` route
Muse Spark uses, and it is an anonymous preview model with thin benchmark
coverage and no public identity. Zero-retention and a `max` effort tier were
judged worth those risks; that judgement is a default, not a fact, and
`oc-harness use` makes reversing it one flag.

## How the privacy list was assembled

From the Privacy section of the OpenCode Zen docs, which states a general
zero-retention policy and then names exceptions. Ten models are named as
retaining data. Two more, `x-preview-f-free` and `deepseek-v4-flash-free`, are
not named in the exception list and so fall under the general policy. Those two
are marked in `retention.yml` as inferred rather than quoted, because the
distinction matters if you are handling someone else's code.

## What the ecosystem already covers

Checked before writing any of the above, so the kit composes instead of
duplicating:

| need | existing project |
|---|---|
| model-driven context compression | `Tarquinen/opencode-dynamic-context-pruning` (4.3k★, AGPL-3.0, development moved to `sleev.ai`) |
| secret redaction before the LLM | `inkdust2021/opencode-vibeguard` |
| git worktrees | `kdcokenny/opencode-worktree` |
| persistent memory | `supermemoryai/opencode-supermemory` |
| memory in git markdown, model routing | `code-yeongyu/oh-my-opencode` (now `omo`) |
| bundled multi-agent harness | `kdcokenny/opencode-workspace` (16 components) |
| distributing skills and agents from git | `jgordijn/opencode-remote-config` |
| orchestration from slash commands | `spoons-and-mirrors/subtask2` |

The gap is the seam between a provider catalog and a config file. That is what
this kit is for.

## Sources

- arXiv:2609.00006 — Harness Engineering, eleven-harness source study
- `https://opencode.ai/docs/zen/` — pricing, retention, free-tier terms
- `https://opencode.ai/config.json` — the resolved config schema for 1.18.35
- `@opencode-ai/plugin@1.18.31` `dist/index.d.ts` — the hook surface
- `https://models.dev/api.json` — provider and model metadata
- `anomalyco/opencode` issue #42977 — free-route 429 behaviour
