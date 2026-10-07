# Walkthrough corpus

Interview problems, walkthroughs of how a candidate would explain solving
them, and gold annotations of what each utterance should do to the code.
The evaluation runner (`packages/eval`) plays every walkthrough through a
translator and scores each step against the gold. ROADMAP.md §6 lists the
metrics, and [ADR-011](../docs/adr/011-corpus-and-evaluation.md) says how
they're computed.

**Before writing anything, read [ANNOTATION.md](ANNOTATION.md).** It
decides what goes into gold, and above all what must stay a hole.

```sh
pnpm eval check                          # formats, gold compiles, counts
pnpm eval gold two-sum.terse             # what the gold says, step by step
pnpm eval run --translator oracle        # replays gold: every metric is 100%
pnpm eval run --out eval-report          # report.md, report.html, results.json
pnpm eval run --split test               # only the held-out problems
```

## Layout

```
problems/<problem>.md                  the statement, never a solution
walkthroughs/<problem>.<style>.txt     one utterance per line
gold/<problem>.<style>.gold            one step per utterance
agreement/<problem>.<style>.gold       second annotations, for agreement
```

A second walkthrough in the same style is `<problem>.<style>-2.txt`.
Every problem needs at least two walkthroughs, in different styles.

## Problems

```
---
title: Two Sum
inputs: nums, target
split: train
tags: array, hash-map
---
Given a list of integers `nums` and an integer `target`, …
```

- `inputs` are the names the problem gives. The analyzer treats them as
  defined, and gold refers to them by these names.
- `split` is `train` (the default) or `test`. Test problems are scored but
  **never** used to tune prompts or rules (ROADMAP.md §6.2). The split is
  per problem, so no walkthrough of a test problem leaks into tuning.
  About 20% of problems are `test`.
- The statement is written in our own words. No solutions, no hints about
  the approach.

## Walkthroughs

```
---
problem: two-sum
style: terse
---
Hash map from value to index, called seen.
Loop over the indices i of nums.
…
```

Styles are `terse`, `rambling`, `corrective` and `incomplete`
(ANNOTATION.md has what each means). Each non-empty line is one utterance.
Utterance IDs are `u1`, `u2`, … in order.

## Gold

```
# Left out: what to return when no pair is found.
step 1
add root: seen = {}

step 2
add root: for i~indexvar in range(len(nums)~range-bounds):
    ...
expect gaps GAP002

step 3
fill h1: need = target - nums[i]
or
fill h1:
    need = target - nums[i]
    ...
```

- `step <n>` starts the edits for utterance n. Steps must cover every
  utterance, in order. A step with no commands means "change nothing".
- The commands are the developer console's edit commands (`add`, `fill`,
  `set`, `replace`, `remove`, `move`, `wrap`, `rename`, `label`, `note`,
  `ask`, …) and `expect`. No `say`: the utterance comes from the
  walkthrough.
- `or` starts another acceptable answer. Each answer starts from the state
  the *first* answer of the previous step left, so node IDs in later steps
  refer to the canonical state.
- `expect gaps`, `expect code:` and `expect error` check the answer they
  follow. `check` fails if one isn't met.

## How a step is scored

The runner gives the translator the utterance and the gold state before
it, applies what it returns, and compares the result with every acceptable
answer, keeping the most favorable. Comparison is structural: node IDs,
provenance, hole reasons and note wording are ignored, and inferred names
(`~loopvar`) can differ. See ADR-011 for the details.
