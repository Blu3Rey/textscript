# 010: Developer console and scenario scripts

- **Status:** Accepted
- **Date:** 2026-10-07
- **Roadmap segment:** S5

## Context

M1 is done when the engine (IR, renderer, edit operations, sessions and the
analyzer) can be driven by hand, with no AI. That needs a console a person
can type into and a script format CI can run. The roadmap sketched commands
like `add root ForEach num nums`, but writing a node's fields one by one is
slow, and it gets worse for nested code. The scripts also have to stay
readable, because they double as examples of how the engine behaves.

## Decision

### Snippets, not node syntax

Commands take code in a small Python subset (`packages/cli/src/snippet/`),
which is parsed straight into IR nodes. It covers every statement and
expression the renderer emits, plus marks for what plain Python can't say:

- `?` is a hole whose kind comes from where it stands (a condition, a value,
  a name). `?cond`, `?value`, `?name` and `?ref(n1,n2)` pick one explicitly,
  and a string after it gives the reason: `?value"the start of each interval"`.
- `...` alone is an empty block, and `intent <words>` is a step said only in
  words.
- `~loopvar`, `~indexvar`, `~range-bounds`, `~synonym`, `~plural` and
  `~block-end` mark a node as an inference (§3.5). `@3:6` says which words
  of the utterance a node came from. Statements take these marks in a
  trailing comment: `seen.add(num)  # ~synonym`.

The parser is checked by a property: render any generated program, parse it
back, render again, and get the same code.

The snippet language is a console convenience. It is not how users write
walkthroughs, and it never becomes an input to the translator.

### The console is a thin layer over the session

- `say <text>` starts an utterance. Edits after it are collected into one
  batch, and the batch is applied to the committed document after every
  command as a preview, so a mistake is reported at the command that made
  it. A failing command leaves the batch as it was. The batch is committed
  as one `edit` event when the next utterance starts, or on `:commit`,
  `:undo`, `:redo`, `:revert`, `:save` or `:quit`.
- An edit typed without `say` gets an utterance made from the command text.
- An utterance that makes no edits before `:undo`, `:redo` or `:revert` is
  attached to that event ("never mind the printing" → `revert u3`), so the
  log keeps what was said.
- Nodes are referred to by ID (`n12`), by hole number in document order
  (`h2`, renumbered as holes are filled), by label (`@vowel-check`), or as
  `root`. Where a block is expected, a compound statement means its body,
  and `n7.orelse` picks another block.
- After every change the console prints the code with each statement's ID
  in a gutter, then the gaps and warnings. Inferences are counted, not
  listed, unless asked for (`:diag all`). This keeps the view quiet
  (ROADMAP §7).
- `op <json>` accepts any edit operation, so nothing the engine can do is
  out of reach.

Everything goes through `apply` and `applyEvent`. The console makes no edit
the engine wouldn't accept from any other caller.

### Temporary IDs are resolved op by op

ADR-008 resolved a batch's temporary IDs all at once, in the order they
appeared in the batch. The console grows a batch one command at a time and
re-applies it each time. Resolved all at once, an op's permanent IDs could
change when a later op was appended, so the IDs shown in the gutter would
be wrong. The applier now resolves each op's temporary IDs just before
running it, numbering after the ops before it. A reference to a temporary ID
that only a later op defines is now an error. Batches that don't do that
get the same IDs as before.

### Scenario scripts

A scenario (`packages/cli/scenarios/*.scenario`) is a list of console
commands. A command starts at the beginning of a line; indented lines
continue it, and a `#` line is a comment. Three commands only check things:

- `expect code:` followed by the export-mode code, indented.
- `expect gaps <codes>` or `expect gaps none`: the gap and warning codes,
  in any order, each as many times as it appears.
- `expect error <code>`: the previous command failed with this code. A
  command error that isn't followed by `expect error` is a failure.

`textscript run <files>` prints each transcript and exits 1 if any
expectation fails. In CI, each scenario must pass and its transcript must
match a golden file in `packages/cli/test/golden/`, so a change in what the
console shows is reviewed like any other output change.

## Consequences

- The §3.6 worked example and 13 more scenarios run in CI, covering every
  edit operation, undo, redo, revert and its conflicts, save and load, and
  and every diagnostic code.
- Scenarios refer to nodes by ID, so a change to ID allocation changes them.
  That's intended: IDs are part of what the console shows, and labels are
  there for scripts that should survive such a change.
- The console depends on Node (readline, files) and is marked as such. The
  engine packages stay environment-agnostic.
- Literals keep JSON's number type, so `0.0` renders as `0`. This is an IR
  limitation; it doesn't matter for walkthroughs yet.

## Alternatives considered

- **Node-by-node commands** (`add root ForEach num nums`). Nested code needs
  a command per node and an ID for each parent, which made the worked
  example four times longer and harder to read.
- **Resolving temporary IDs per command in the console** instead of in the
  applier. The console would have to rewrite IDs the applier then rewrites
  again, and a stored batch would replay with different IDs than the
  console showed.
- **Scenario expectations as exact transcripts only.** Goldens catch every
  change but don't say what a scenario is meant to show. `expect` lines
  carry the intent, and the golden carries the rest.
