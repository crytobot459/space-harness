# opencode-harness-kit

A harness kit for [OpenCode](https://opencode.ai) that is **model-agnostic by
construction**. Switching models is a data edit, not a code change.

```bash
npx oc-harness list
npx oc-harness use space-bunny-free
```

## The problem it solves

Tuning a coding harness for a model means answering model-specific questions:
how much context to reserve, which reasoning levels exist, whether temperature
is even accepted, how much privacy the provider gives you. Answer them in a
prompt and you get a paragraph the model reads once. Answer them in code and
you get two projects that share a name and nothing else.

This kit puts the answers in a profile:

```
profiles/space-bunny-free.json     ← the model
src/                               ← no model name anywhere in here
```

Same plugin source, four shipped profiles, four different behaviours. The test
suite asserts that rather than taking it on faith.

## What the compiler derives

Given a profile, `oc-harness use` writes an `opencode.jsonc` with every
model-dependent number already worked out and commented:

```
$ oc-harness use deepseek-v4-flash-free --print

// profile      deepseek-v4-flash-free
// context      200,000 tokens
// input cap    200,000 tokens
// reasoning    low < high < max
// retention    zero-retention
//
// Derived numbers, do not hand-edit:
//   compaction.reserved  24,000   (12% of the input cap)
//   prune threshold      176,000  (input cap minus reserve)
//   role effort          plan=max  build=high  reviewer=max  scout=low  verify=low
```

Against a 1M-context model, the same source produces `reserved 62,915` and
`prune threshold 461,373`. Nobody edits those by hand, and nobody copies a
200k-tuned config onto a 1M model and wonders why it overflows.

### Levels are resolved, never emitted raw

A role asking for `max` on a model whose top level is `xhigh` gets `xhigh`, and
the substitution is reported:

```
$ oc-harness show muse-spark-1.3-contributor-free
  effort levels        minimal < low < medium < high < xhigh
  role effort
    plan       xhigh      (requested max)
  adjustments
    ! role plan asked for max; muse-spark-1.3-contributor-free tops out at xhigh.
```

A model with no tunable effort at all gets **no** `variant` written, rather than
a level it does not have.

## Privacy is a first-class field

`models.dev` describes capability and price. It does not describe what a
provider does with your prompts. `retention.yml` is hand-curated for that
reason, and a profile cannot be installed until a human has stated its terms.

```
$ oc-harness list
  ▸ space-bunny-free       1,048,576      max  zero-retention
  ✗ muse-spark-1.3-contributor-free
      Provider may train on your prompts and completions (Meta contributor
      tier). Top effort is xhigh, not max.
```

The excluded model is still installable with `--yes`, and the warning repeats
on install. It is not hidden, it is labelled.

## Shipped profiles

| profile | context | top effort | retention |
|---|---|---|---|
| `space-bunny-free` (default) | 1,048,576 | `max` | zero-retention |
| `x-preview-f-free` | 1,000,000 | `max` | zero-retention |
| `longcat-2.5-preview-free` | 1,000,000 | — | zero-retention |
| `deepseek-v4-flash-free` | 200,000 | `max` | zero-retention |
| `muse-spark-1.3-contributor-free` | 1,048,576 | `xhigh` | **may train** |

## Commands

```
oc-harness list       profiles with retention and caveats
oc-harness use <id>   compile a profile into ~/.config/opencode/opencode.jsonc
oc-harness show <id>  resolved effort, derived numbers, fallback queue
oc-harness doctor     re-check every profile against models.dev
oc-harness baseline   measure the current install
```

`doctor` exists because free models get withdrawn within days. It diffs each
profile against live metadata and reports drift:

```
✓ space-bunny-free    matches catalog
! muse-spark-1.3-contributor-free  drift
    input 524288 -> 1048576
```

That drift was real; `doctor` found it during development.

## Measuring before tuning

`oc-harness baseline` reads the OpenCode SQLite database and reports what is
actually happening, so thresholds come from measurements rather than intuition.
From one real install:

```
CONTEXT PER REQUEST
  p50   99,648    p90  246,536    p99  482,779    max  547,986
  fresh input p50  534
STORED MESSAGE BYTES
  tool        114.78 MB   77.9%
  reasoning    22.94 MB   15.6%
  text          3.04 MB    2.1%
compaction events  0  (never fired)
```

Tool output was 78% of stored context and the session re-read ~99k tokens per
request to add ~534 new ones. That measurement is why pruning here is
deterministic, and why `tool_output` stays tight instead of being raised.

Your numbers stay on your machine; only the script is in the repo.

## The plugins

| module | hook | job |
|---|---|---|
| `guard.ts` | `tool.execute.before` | Blocks destructive commands in code. Fail-closed. |
| `prune.ts` | `experimental.chat.messages.transform` | Replaces old tool output with a one-line stub. |
| `router.ts` | `config`, `event`, `chat.message` | Moves to the next profile when a route is spent. |
| `telemetry.ts` | `event`, `tool.execute.after` | Local JSONL, gitignored, never a network call. |

`guard.ts` splits the command on shell separators before matching, so
`cd repo && git push` is caught rather than only a command that starts with the
forbidden word.

Pruning keeps user messages, assistant prose, diffs, and the last few turns
verbatim, and never touches the in-flight turn. Old reasoning is dropped, since
stale reasoning is worse than none.

## Install

```bash
npx oc-harness use space-bunny-free
```

Then add the plugin to `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["opencode-harness-kit"] }
```

`oc-harness use` writes the active profile id into the generated config, and
the plugin records it in the project's `.space/active` at startup so pruning
picks up the right thresholds. To pin a profile explicitly instead:

```bash
export OPENCODE_HARNESS_PROFILE=space-bunny-free
```

To install the agent and skill files as well, copy them into your config
directory:

```bash
cp -r agents skills GLOBAL.md ~/.config/opencode/
```

## Known limits

Read [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) before relying on failover.
The short version: no OpenCode plugin hook can change a live session's model,
so switching happens at the next session, not mid-flight.

## Development

```bash
npm install
npm test          # 16 tests, including the model-agnostic assertions
npm run typecheck
npm run baseline  # your own install
```

`docs/RESEARCH.md` records where the numbers came from and what was tried and
rejected.

## License

MIT
