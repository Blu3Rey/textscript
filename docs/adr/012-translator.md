# 012: The translator

- **Status:** Accepted
- **Date:** 2026-10-07
- **Roadmap segment:** S7

## Context

S7 adds the translators: a language model, and a rule-based baseline that
is the eval floor and the offline fallback. They take one utterance and
the solution so far, and return an edit batch (ROADMAP.md §2.1). Four
forces shape the design:

- The model must say only what the speaker said (ADR-004). Anything it
  can't encode must stay visible, not vanish.
- Its answers have to be valid edit batches, with provenance pointing at
  the words that caused each edit.
- The API key must never reach the browser.
- Latency and cost are product constraints: p50 under 3 s, and the cost of
  a 20-utterance session measured.

## Decision

### The model writes console commands, not edit operations

The model answers with a flat JSON object:

```json
{ "commands": [{ "command": "add root: seen = set()", "words": [3, 7] }],
  "unparsed": [{ "start": 9, "end": 14 }] }
```

Each `command` is a line of the developer console's edit language
(ADR-010): `add`, `fill`, `set`, `wrap`, `ask` for clarifying questions and the others, with Python
snippets that use `?` for holes and `~` marks for allowed inferences.
`words` cites the utterance's numbered words; the commands package turns
those into provenance.

Structured outputs keep the envelope schema-valid. They can't describe the
edit operations themselves, because the IR is recursive and the API
doesn't accept recursive schemas. Writing commands has three other
advantages:

- Corpus gold is written in the same language (ADR-011), so few-shot
  examples come straight from training-split gold.
- The snippet parser and `apply` reject anything that isn't valid code or
  doesn't fit the tree, with error messages the model can act on.
- Commands are short, which keeps output tokens and latency down.

The command compiler moved from `cli` into a new browser-safe package,
`@textscript/commands`. The console, the translators and the eval runner
all use it, so a command means the same thing everywhere.

### Context packing

Each request has three parts:

1. **The system prompt.** Instructions plus four worked walkthroughs, one
   per style, rendered from gold. It's frozen, so it's cached.
2. **The problem.** It stays the same for a whole session, so it's a
   second cached block.
3. **The turn.** This part changes every time. It holds:
   - earlier utterances;
   - the code outline with node IDs;
   - open gaps with their hole numbers;
   - the names in scope and any labels;
   - the utterance with every word numbered.

The examples come from four training problems. LLM eval runs leave those
problems out, so no walkthrough is scored with its own answer in the
prompt. A test checks that `examples.json` matches the corpus.

### Unparsed words and failures

Words the model can't encode go in `unparsed`. Translators report these
spans and never add notes themselves. The app calls `withUnparsedNotes`,
which turns each span into a note ("Not encoded: …") so the words stay
visible. Eval scores the batch without those notes; scoring them would
punish the model for being honest.

If the answer doesn't compile or apply, the error goes back to the model
once. The retry is append-only: the reply goes back unchanged, followed by
the error. If the second answer fails too, the commands that work are
kept, applied in order so later ones can build on earlier ones. The words
of the commands that failed become unparsed spans.

Some stop reasons are errors, not answers:

- `refusal` raises a typed error.
- `max_tokens` raises a typed error.
- An answer that isn't JSON twice running raises a typed error.

Refusals also get the API's server-side fallback, so the model Anthropic
recommends retries the request first.

### Model, effort and cost

The default model is `claude-opus-5-5`. Effort is always set explicitly
(default `medium`). `pnpm eval sweep` compares efforts on quality, p50 and
p95 latency, and cost per 20 utterances. The translator adds up tokens
over all attempts, prices them from a table that includes cache reads and
writes, and the eval report shows the total.

### The server

`apps/server` is a small Hono app with two routes:

- `POST /translate` takes a translation context as JSON, validates it
  (including the document, against the IR schema), runs the Claude
  translator and returns the translation.
- `GET /health` reports that the server is up.

The browser uses `createRemoteTranslator`, which validates the server's
answer the same way. The key comes from the server's environment, as the
SDK resolves it. Error responses carry a code and never internal detail.

### The rule-based baseline

`rulesTranslator` matches about 30 phrase patterns, such as:

- "a set called seen";
- "for each num in nums";
- "if x is in seen" followed by an action;
- "return true if the stack is empty";
- "after the loop, return false";
- "store i in seen under nums at i".

It never guesses. Words it can't read become `?value` or `?cond` holes,
and clauses it can't read are reported as unparsed. Its placement rules
are the following, in order:

1. A step said to come after a loop goes after the open loop.
2. Otherwise the step fills the newest open block hole.
3. Otherwise a bare return goes after the open loop.
4. Otherwise the step goes in the open loop's body, then the newest
   function's, then the top level.

### The CI gate

`pnpm check` and CI run `pnpm check:eval`. It validates the corpus and runs
the rules translator against `corpus/baselines/rules.json`. Faithfulness
and gap preservation must not drop; coverage is reported but not gated.

The LLM translator is gated by a manually started workflow
(`.github/workflows/eval.yml`). It needs the `ANTHROPIC_API_KEY` secret,
and gates against `corpus/baselines/claude.json` once that file has been
recorded.

### After the first local runs

qwen3:14b through Ollama ran on the test split. In about 12 of its 29
failing steps, nothing was applied. Most of these were "Otherwise …"
utterances: the prompt said `add <if>.orelse:`, which failed when the
`if` had no `else` yet. That command now creates the `else`, and
`<program>.orelse` is an error instead of adding to the top level.

The prompt now also says where edits go:

- change one field with `set` rather than rebuilding the statement;
- put "after the loop" in the block that holds the loop;
- add at the end unless the words say otherwise.

The eval report shows why a model's answer failed when it was retried.

## Consequences

- The model can only make edits the command language can express, which
  is what the console can do. New IR features need console syntax first.
- Prompt changes are measurable. Any change to `prompt.ts`, `context.ts` or
  the examples should come with an eval run on the held-out split.
- Holes in the model's output are trusted only as far as `apply` and the
  analyzer check them. The S8 validator adds the semantic checks
  (downgrading inferred code to holes).
- The baseline is deliberately weak: 65% faithfulness, 14% coverage.
  Making it smarter makes it "helpful", so its job is to stay predictable.
- Every utterance in the app costs one or two API calls. A session's cost
  is visible in eval reports, not yet in the app.

## Alternatives considered

- **Edit operations as tool calls, or JSON edit operations.** The schema
  would have to be flattened or loosened until it no longer validated much.
  The model would also write IDs, kinds and child fields by hand, which
  costs far more output tokens than a line of Python.
- **The model writes the whole program each turn, and the engine diffs
  it.** Simpler for the model, but it would lose provenance and hole
  identity, and it invites rewriting code nobody mentioned.
- **Notes for unparsed words added by the translator.** The eval would
  count them as unsupported nodes, and the eval and the app would see
  different batches. Reporting spans keeps one translation for both.
- **Calling the API from the browser.** It would expose the key.
