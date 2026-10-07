# 011: Walkthrough corpus and evaluation

- **Status:** Accepted
- **Date:** 2026-10-07
- **Roadmap segment:** S6

## Context

From S7 on, a language model turns utterances into edit batches. Whether a
prompt, model or validator change helps can only be answered by measuring
it on many walkthroughs, so the corpus and the runner come first. Three
things make measuring this hard:

- A step can have more than one right answer.
- What *must not* happen (filling a gap) matters more than what should.
- Translator mistakes compound across a walkthrough.

## Decision

### Corpus layout and formats

`corpus/` holds problems (statements only), walkthroughs (one utterance per
line, in one of four styles: terse, rambling, corrective, incomplete) and
gold. The split between training and held-out data is **per problem**, set
in the problem's header, so no walkthrough of a held-out problem can leak
into prompt tuning. Six of the thirty problems are held out.

### Gold is written as console commands

A gold file has one `step` per utterance, written in the developer
console's command language (ADR-010). Each step can list several acceptable
answers separated by `or`. Compiling a gold file runs every answer through
the console, starting from the state the step's *first* answer left before
it. That produces, for each utterance, exactly what the roadmap asks for:
the expected IR after the step, the gaps the analyzer reports there, and
the set of acceptable batches. Gold can't contain anything the engine would
reject, and `expect` lines let the annotator pin down what must stay open.
`pnpm eval check` fails on any gold that doesn't compile or meet its
expectations.

[corpus/ANNOTATION.md](../../corpus/ANNOTATION.md) is the annotation guide:
what each style must contain, what gold may and may not include, and how to
write around things the IR can't express yet.

### Each step is scored from the gold state ("teacher forcing")

The runner gives the translator the utterance, the gold state before it,
earlier utterances and the problem. It applies the returned batch with
`apply` (a rejected batch counts as producing nothing) and compares the
result with every acceptable answer, keeping the most favorable one. Since
every step starts from gold, one mistake doesn't lower the scores of the
steps after it, and each score says how well that one utterance was
translated.

### Comparison is structural

The translator's program and the gold program are aligned node by node.
The alignment follows the tree, uses a sequence alignment for statement
lists, and maximizes the number of *equal* pairs: same kind and same
values. It ignores node IDs, provenance, hole reasons, the wording of
notes and of steps in words, and the spelling of names bound by an allowed
inference (a `~loopvar` called `num` or `n`). Holes and steps in words may
pair with anything, so the alignment shows what took their place.

What gets counted are **units**: nodes (not blocks), notes and labels.
A step *produces* the units that are new or whose own values changed, not
counting code rewritten exactly as it was. When gold replaces a whole `if`
to add an `elif`, its unchanged first branch isn't credited to it.

| Metric | Computed as |
|---|---|
| Faithfulness | produced units, holes excepted, that pair with an equal gold unit |
| Coverage | gold-produced units that pair with an equal produced unit |
| Gap preservation | gaps the analyzer reports in the gold state that are still open in the translator's state |
| Placement | for steps whose gold changes existing code below the top level: the set of changed existing nodes is exactly gold's |
| Clarification precision/recall | asked when some gold answer asks / asked when every gold answer asks |
| Stability | lines of statements gold leaves alone that stay byte-identical |
| Latency, cost | measured per call; cost from the translator's reported usage |

Gap preservation is defined over **analyzer gaps, not just holes**. Holes
alone would miss the most important failure: an `incomplete` walkthrough
never says what to return at the end, so the gap is a GAP003 on the
function, not a hole node. A translator that adds `return False` closes
it, and that has to count. A gap counts as closed only if the translator's
counterpart of its node lacks it. A hole stays open if any hole takes its
place. A missing return is closed only if the counterpart returns a value,
because GAP003 only exists once something returns. Gaps on code the
translator didn't produce at all aren't counted against it.

Faithfulness here means "supported by a gold answer". ROADMAP §6 defines it
with the S8 validator and a judge. Until those exist, gold support is the
stricter stand-in: anything gold doesn't have is unsupported.

### Reports, stubs and the gate

- `pnpm eval run` prints the metrics and writes `report.md` (to attach to
  pull requests), `report.html` and `results.json`. Each step that isn't an
  exact match is listed with a plain-language reason for every difference
  and a diff of expected and produced code.
- The `Translator` interface lives in `packages/translator`. S6 ships two
  stub translators: `empty`, the floor, and `oracle`, which replays gold
  and must score 100% on every metric. A test runs both over the whole
  corpus, which also proves the corpus and the scorer agree.
- `--write-baseline` and `--baseline` record scores and fail when
  faithfulness or gap preservation drop, overall or on the incomplete
  walkthroughs. S7 runs this in CI.

### Agreement between annotators

`pnpm eval agree` compares second annotations (`corpus/agreement/`) with
the corpus gold, step by step, on what each step produced: the share of
identical steps, node-level F1, and holes in the same place. Comparing
whole states instead would count one early disagreement again at every
later step.

## Consequences

- Gold is only as good as the guide. Disagreements found by `agree` should
  become guide rules, and the guide is versioned with the corpus.
- Annotating by node ID is tedious. `pnpm eval gold` shows IDs after each
  step, including for gold that stops at a failing step.
- Writing the corpus surfaced IR gaps: tuple targets, keyword arguments,
  conditional expressions, chained assignment and imports. The guide lists
  how gold works around each. They're inputs for future IR changes.
- Teacher forcing measures single steps. A whole-session ("free-running")
  mode, where errors do compound, is a later addition once a real
  translator exists.

## Alternatives considered

- **Gold as hand-written IR JSON.** Exact, but unreadable, slow to write
  and easy to get subtly wrong. Console commands are checked by the engine
  itself.
- **Compare rendered code as text.** Breaks on formatting, names and hole
  wording, and can't tell a filled gap from a reworded one.
- **Score whole sessions only.** One early mistake would dominate a
  walkthrough's score and hide how the rest of the steps did.
- **Gap preservation over hole nodes only.** Misses filled missing returns,
  invented setup for undeclared names and other gaps the analyzer reports
  without a hole.
