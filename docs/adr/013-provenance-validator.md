# 013: The provenance validator

- **Status:** Accepted
- **Date:** 2026-10-07
- **Roadmap segment:** S8

## Context

ADR-004 says the engine may only produce what the user said. Through S7
that rule lived in the translator's prompt, and a prompt is only a
request. A model that wants to be helpful will fill a gap, and it will
cite the user's words while doing so. S8 turns "don't fill gaps" into a
check that runs on every batch before it is applied.

The check works under three constraints:

- It has to be cheap and deterministic, so it can run on every utterance
  and in CI without an API key.
- A batch is never all wrong. Rejecting the whole batch would throw away
  the parts the user did say.
- A check that is too strict blocks correct output, and the user then
  repeats themselves for nothing. Strictness has to be measured, not
  guessed.

## Decision

### A `validator` package between the translator and the applier

`validate({ document, batch, utterances, inputs })` returns the batch with
everything unsupported held back, plus a list of what was held back. It
works on the result of the batch: it applies the batch, finds the nodes
the batch created (IDs at or above the document's `nextId`), and checks
each one top-down where it ends up. That way a node's position (a
condition slot, a loop target) is known whatever op created it.

Three checks, in order:

1. **Structural.** A created node cites words, or names an inference
   rule. Every span points into this utterance or an earlier one, inside
   its tokens.
2. **Inference.** A node marked `inferred` must fit its rule, using the
   S4 registry (`fitsInferenceRule`). A rule that supplies something
   unsaid skips the lexical check: the loop variable for INF-LOOPVAR, and
   `len` for INF-RANGE-BOUNDS.
3. **Lexical.** The cited words must contain supporting words for the
   node. For each kind of node:
   - **Names** must be said: by their parts, as an abbreviation ("cnt"),
     as initials ("dp"), as words run together, or by a synonym. A name
     that already exists may also be referred to ("it", "the list").
   - **Literals** need a number word, a digit, or a cue: "empty" supports
     `[]`, and "zero" or "start" supports `0`.
   - **Operators** need a cue word: "at least" supports `>=`, and "bigger"
     supports `>`.
   - **Statement kinds** need a keyword: "return", "break", "if", "loop"
     and so on.

   The cues live in one file, `lexicon.ts`.

Two refinements came from the corpus:

- **Nearness.** An arithmetic or comparison operator must be said within
  six words of what it combines, in the same sentence. In "ways is prev
  plus curr, from two to n inclusive", the words say `prev + curr` but not
  `prev + 1`.
- **Operands.** An operator whose operand isn't said is held back whole.
  In `best = total + ?`, the words "add it to total" would otherwise
  vouch for a structure nobody described.

A node the cited words don't support is checked again against the whole
utterance those words come from before it is held back. The first local
run (Ollama, qwen3:14b) held back 26% of gold-supported units. Models
cite narrower word ranges than they should, such as "num" for `seen`,
while the lexicon was tuned and measured on whole utterances, which is
what gold cites. The second opinion is given the whole utterance for the
same reason. The report now breaks held-back items down by code, so it
shows whether the lexicon or the second opinion is the one that's too
strict.

The breakdown answered the question. On the test split with qwen3:14b,
the second opinion from the same local model held back 27 items; gold
supports 26 of them (113 units). The lexicon held back 9, and gold
supports only 1. A local model's second opinion is therefore off by
default (`--validator lexical` for Ollama runs). Claude Haiku and Gemini
Flash-Lite as second opinions still need measuring with a key.

Two more rules came from the third local run's failing steps:

- In an `and`/`or`, each run of unsaid operands becomes one hole and the
  rest is kept. For "if nr, nc is in bounds and grid[nr][nc] is 1", the
  result is `? and grid[nr][nc] == 1`, which is what gold has. The whole
  condition is held back only if none of it was said.
- A loop variable can't be named by its collection's exact name. In "each
  amount in nums", `num` matches only "nums", so it is held back.

One more rule came from the fourth local run. A new variable whose value
is held back loses its whole line, unless a setup word ("starts", "set",
"is") is said near its name. For "add one to islands", the line
`islands = 0` became `islands = ?`, which closed the "never set up" gap
the speaker left open; now the line is held back as a whole.

The sixth run turned "the key is just count" into `key = tuple(count)`,
fixing a mistake the speaker corrects one utterance later. The words
passed because "key" and "sorted" were cues for `tuple`. Only "tuple" and
"pair" are now; gold false rejections stayed at 1.4%.

The seventh run showed what holding back parts can leave behind. "So I'll
scan for that drop" became `for i in range(⟨held back⟩): if ⟨held back⟩:
...`, and a musing became `⟨held back⟩ = ⟨held back⟩`. Only a keyword
was left, and a weak one ("that" is a cue for `if`). A new statement with
nothing said left in it is now held back whole: every expression in it
held back or inferred, at least one held back, and no statements kept in
its blocks. The check runs bottom-up, so an emptied `if` empties its
loop. A `return` stays, because "return" says it returns; so do holes
the model wrote with the speaker's words. Gold false rejections stayed at
1.4%.

Three more came from the eighth run:

- The pronoun "I" no longer says the variable `i`. "So I'll just scan"
  had kept an empty `for i in range(⟨held back⟩)` alive. Every spoken `i`
  in the corpus is lowercase.
- A function the program defines is called by name. "Inside that" had
  let an invented `sink(r, c)` through. Built-ins like `len` still accept
  "it", which gold relies on.
- "Return True if the stack is empty" written as `return not stack` is
  held back. The words say when it returns True, not what it returns
  otherwise, and returning the condition closes that gap.

Gold false rejections stayed at 1.4%. A removed empty statement now gives
one notice instead of one for each of its parts.

Code that a batch removes and rebuilds unchanged needs no new words
(restructuring an `if` chain, for example). It was checked when it was
first said.

### Downgrade, don't discard

What is held back depends on what it is:

- **An expression** becomes a hole of the matching kind: a condition slot
  gets `CondHole`, a name gets `NameHole`, anything else `ExprHole`. The
  hole keeps the node's spans, so the UI can point at the words, and its
  reason is `held back: not stated in the words`.
- **A statement** is removed. If that empties its block, the applier puts
  the block's hole back.
- **A field change** is dropped: an operator, a rename or a label.

All of this is expressed as edit ops appended to the batch
(`replace_node`, `remove_node`). Apply stays the only way to change a
document (ADR-008), and the session log shows what the translator
proposed and what was held back.

Each held-back item becomes an info-level notice:

- a code, `VAL001` to `VAL005`;
- the proposed code;
- the spans;
- a message that states what the words don't say, never what to say
  (ADR-009).

`validatedTranslator` wraps any translator and returns these notices as
`Translation.heldBack`. `apps/server` always validates.

### The second opinion

Some nodes have no lexical check, such as an index, a slice, or an
assignment's shape. The validator returns these as claims ("do these words
say this code?"). `checkBatch` sends them to a verifier and validates
again with its rejections, which become `VAL005`.

`createClaudeVerifier` asks Claude Haiku 4.5 about all of a batch's claims
in one structured-output call. If the call fails, is refused, or skips a
claim, the claim stands: the second opinion can only hold more back.

The verifier is on by default in the eval for the Claude translator
(`--validator verified`). At runtime it is off unless the server runs
with `TEXTSCRIPT_VERIFY=on`, until its cost and benefit are measured.

### Measuring it

When a validator runs, the eval report adds three rates:

- **Rejection rate:** batches with anything held back.
- **Downgrade rate:** checked nodes and changes held back.
- **False-rejection rate:** units of the unvalidated output that a gold
  answer supports and the validator held back.

The `filler` translator replays gold and fills every remaining hole with
made-up code that cites the whole utterance. It is the adversary for the
"no gold hole filled" criterion.

On the full corpus, with the lexical validator only:

| Run | False rejections | Gap preservation | Incomplete walkthroughs |
|---|---|---|---|
| Oracle | 1.4% | 100% | 100% |
| Filler, no validator | – | 66.0% | – |
| Filler, validator | 2.1% | 99.0% | 98.0% |

The rules baseline is unchanged (nothing held back).

The fills that still get through use the same words the user said, in
another role. For example, "move low to mid plus one" can be read as
`low + 1`. A bag of words can't tell these apart; reference resolution
(S9) and the verifier can.

## Consequences

- Faithfulness no longer depends on the model's restraint alone. A gap
  that gets filled is visible in the report as a held-back notice, or as
  a closed gap if it slipped through.
- The lexicon decides what counts as "said". Every cue added makes the
  validator accept more. Changes are judged by the false-rejection rate
  and the filler's gap preservation, both in `pnpm eval run`.
- Lexical checks see words, not meaning. Narrow spans make them stronger.
  A translator that cites the whole utterance for every command gets the
  weakest check, which is why the Claude translator is asked for word
  ranges.
- The validator holds back and does not ask for a retry. Sending
  downgrades back to the model would invite it to cite different words
  for the same guess.
- The verifier costs one cheap call per batch that has claims. That cost
  needs a run with an API key to measure, like the S7 LLM criteria.

## Alternatives considered

- **Reject the whole batch on any failure.** This is simpler, but it
  discards supported edits, and the user would have to repeat them.
- **Only the second-opinion model, no lexicon.** It costs a call on every
  utterance, isn't deterministic, and can't run in CI without a key.
- **A per-statement verifier prompt instead of per-node claims.** A
  statement-level "no" can't say which part to hold back. It would also
  remove supported code along with the guess.
- **Recording held-back items as notes in the IR.** Notes are the user's
  words. Held-back items are the translator's proposals, so they belong
  in the translation's notices and in the hole's reason.
