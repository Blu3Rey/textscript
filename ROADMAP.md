# TextScript Roadmap

TextScript turns a written, plain-English walkthrough of a coding approach
("loop through the list of numbers; if we've already seen the number, return
true") into code that shows **exactly what was said: nothing more**. Gaps in
the explanation stay visible as *holes* instead of being filled in. Users can
add to the solution as ideas come, and go back to refine earlier parts.

This document is the development plan. It is split into **milestones**, each
made of **segments**. A segment is one deliverable that can be finished,
tested and merged before the next one starts.

---

## Table of contents

1. [Product principles](#1-product-principles)
2. [Architecture](#2-architecture)
3. [Core concepts reference](#3-core-concepts-reference)
4. [Milestones at a glance](#4-milestones-at-a-glance)
5. [Segments in detail](#5-segments-in-detail)
6. [Evaluation strategy](#6-evaluation-strategy)
7. [Risk register](#7-risk-register)
8. [Decisions to make](#8-decisions-to-make)
9. [Out of scope (for now)](#9-out-of-scope-for-now)
10. [Glossary](#10-glossary)

---

## 1. Product principles

These rules break ties when a design question is close. Every segment is judged
against them.

1. **Faithful over helpful.** The tool never adds logic the user didn't
   describe. When in doubt, leave a hole and say what's missing.
2. **Gaps are a feature.** A visible hole ("you never said what to return") is
   the most useful feedback the tool gives. Holes are first-class data, not
   error states.
3. **Every line has a source.** Each piece of generated code links back to the
   words that produced it. Code without a source is a bug.
4. **Edits, not regeneration.** A new sentence changes the existing solution in
   place. Code the user didn't touch stays exactly as it was.
5. **Deterministic core, AI at the edge.** Only one step uses a language model:
   turning text into edit operations. Rendering, analysis, undo and validation
   are plain, tested code.
6. **Nothing said is lost.** Anything that can't be encoded structurally is
   kept as a note attached to the relevant spot. It is never dropped silently.

---

## 2. Architecture

### 2.1 Data flow

```
 ┌──────────────┐   utterance    ┌──────────────────┐   EditBatch    ┌─────────────────┐
 │  Input layer │ ─────────────► │    Translator    │ ─────────────► │   Provenance    │
 │ (text; later │                │ (LLM or baseline │                │   validator     │
 │   speech)    │                │  → edit ops)     │ ◄── retry ──── │ (reject/downgrade│
 └──────────────┘                └──────────────────┘   feedback     │  unsupported)   │
        ▲                                ▲                           └────────┬────────┘
        │ clarification                  │ IR outline, symbols,               │ validated ops
        │ questions                      │ open holes, recent text            ▼
 ┌──────┴───────┐                ┌───────┴──────────┐                ┌─────────────────┐
 │      UI      │ ◄───────────── │  Session store   │ ◄───────────── │   Op applier    │
 │ transcript ↔ │  rendered code │ (event log: text │   new IR       │ (invariants,    │
 │ code ↔ gaps  │  + source map  │  + op batches)   │   version      │  history/undo)  │
 └──────────────┘  + diagnostics └──────────────────┘                └─────────────────┘
                         ▲                                                    │
                         │        ┌─────────────────┐   ┌─────────────────┐   │
                         └─────── │    Renderer     │ ◄─│  Analyzer (gaps │ ◄─┘
                                  │ (IR → Python +  │   │  & diagnostics) │
                                  │  source map)    │   └─────────────────┘
                                  └─────────────────┘
```

Only the **Translator** talks to a language model. Everything else is pure,
synchronous code that can run in the browser.

### 2.2 Technology choices (proposed; recorded as ADRs in S0)

| Area | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict) everywhere | The engine runs in the browser so rendering and undo are instant. One language for engine and UI means no duplicated IR types. |
| Repo | pnpm workspaces monorepo | Clean package boundaries (the core engine's only runtime dependency is Zod). |
| Tests | Vitest + golden-file snapshots | Fast. Snapshots fit renderer output well. |
| First output language | **Python** | Closest to pseudocode, and the most common interview language. |
| LLM | Claude API via `@anthropic-ai/sdk`, default model `claude-opus-5-5` | Structured outputs make the model return schema-valid edit operations. |
| UI | React + Vite + CodeMirror 6 | CodeMirror decorations handle hole chips, hover links and gutter markers. |
| Server | Thin stateless proxy (Hono or Fastify) | Keeps the API key off the client. It holds no transcripts. |
| Output validity check | `python3 -c "import ast; ast.parse(...)"` in CI | Shows that rendered code (with hole sentinels) is real Python. |

### 2.3 Repository layout (target)

```
textscript/
├── packages/
│   ├── core/            # IR types, ids, edit ops, applier, history, analyzer (Zod only)
│   ├── render-python/   # IR → Python text + source map
│   ├── translator/      # Translator interface, LLM translator, baseline translator
│   ├── validator/       # provenance + inference-policy checks
│   ├── eval/            # corpus runner, metrics, reports
│   └── cli/             # developer console (drive the engine by hand)
├── apps/
│   ├── web/             # practice UI
│   └── server/          # API proxy for the translator
├── corpus/
│   ├── problems/        # problem statements only (never solutions)
│   ├── walkthroughs/    # utterance scripts
│   └── gold/            # expected IR / ops / holes per walkthrough step
└── docs/
    └── adr/             # architecture decision records
```

---

## 3. Core concepts reference

### 3.1 The IR (intermediate representation)

The IR is a tree of statements and expressions. It is close to Python's AST but
has three additions: **holes**, **provenance** and **labels**.

> The sketch below was the starting point. The authoritative definitions are in
> [`packages/core/src/ir/types.ts`](packages/core/src/ir/types.ts), and
> [ADR-006](docs/adr/006-ir-schema-and-validation.md) lists what changed (for
> example `Not` became `UnaryOp`, and `InfinityLiteral`, `DictLiteral` and
> `Elif` were added).

```ts
type NodeId = string;                       // stable, e.g. "n12"; never reused

interface Span {                            // where in the user's text a node came from
  utteranceId: string;
  start: number;                            // token index (inclusive)
  end: number;                              // token index (exclusive)
}

interface NodeBase {
  id: NodeId;
  kind: string;
  provenance: Span[];                       // ≥1 required unless `inferred` is set
  inferred?: InferenceRuleId;               // see 3.5; shown to the user
  label?: string;                           // "main loop", "duplicate check"
  notes?: Note[];                           // things said here that aren't code
}

// Statements
type Stmt =
  | FunctionDef   // name, params, body
  | ForEach       // target, iterable, body
  | ForRange      // var, start, stop, step, body
  | While         // cond, body
  | If            // cond, then, elifs[], else?
  | Assign        // target, value
  | Update        // target, op ("+=", "append", "add", ...), value
  | Return        // value?
  | Break | Continue
  | ExprStmt      // e.g. a bare call
  | IntentStmt;   // "process the element here": text kept verbatim, renders as comment + hole

// Expressions
type Expr =
  | Name | Literal | BinOp | Compare | BoolOp | Not
  | Call | Index | Slice | Attribute | Membership
  | CollectionLiteral   // empty list/set/dict, etc.
  | Hole;

interface Block { id: NodeId; stmts: Stmt[] | [BlockHole] }
```

**Symbols.** A symbol table (computed by the analyzer, not stored) records where
each name is introduced and used, and its scope. Renames go through symbols, not
text replacement.

### 3.2 Holes

| Hole kind | Meaning | Rendered (UI) | Rendered (plain-text export) |
|---|---|---|---|
| `BlockHole` | A block whose contents were never described | `⟨body not described⟩` | `...  # TODO(textscript): body not described` |
| `CondHole` | A condition mentioned but not stated ("if it's valid") | `⟨condition: "it's valid"⟩` | `__hole__("condition: it's valid")` |
| `ExprHole` | A value mentioned vaguely ("update the count") | `⟨value⟩` | `__hole__("value")` |
| `NameHole` | Something referenced but never named ("the list") | `⟨which list?⟩` | `__hole__("which list?")` |
| `RefHole` | A reference that couldn't be resolved, with candidates | `⟨nums or seen?⟩` | `__hole__("nums or seen?")` |

Every hole has its own ID, a short reason, and (where possible) the quoted
words it stands for. The plain-text export always parses as valid Python.
[ADR-007](docs/adr/007-python-rendering.md) has the exact renderings,
including placeholder names for holes in binding positions.

### 3.3 Edit operations

The translator outputs a **batch** of operations per utterance. Batches are
atomic: all ops apply, or none do.

| Op | Purpose | Example trigger |
|---|---|---|
| `add_stmt(parent, position, stmt)` | Add new code | "then return false" |
| `fill_hole(holeId, value)` | Fill in a gap | "the condition is when the number is negative" |
| `update_field(nodeId, field, value)` | Change one part of a node | "actually loop from 1, not 0" |
| `replace_node(nodeId, node)` | Swap a node out | "instead of a list, use a set" |
| `remove_node(nodeId)` | Delete | "we don't need the counter" |
| `move_node(nodeId, parent, position)` | Reorder | "do the check before the update" |
| `wrap_nodes(nodeIds, wrapper)` | Put existing code inside a construct | "only do those two steps if the list isn't empty" |
| `rename_symbol(symbolId, name)` | Rename everywhere | "call it `seen` instead" |
| `set_label(nodeId, label)` | Name a part for later reference | "call this the duplicate check" |
| `add_note(nodeId, text)` | Keep non-code statements | "this is O(n)" |
| `ask_clarification(question, candidates)` | No mutation; asks the user | "which loop?" |

Each op carries its own `provenance`. The applier enforces invariants (valid
tree, unique IDs, no orphaned holes, provenance present) and rejects a batch
that breaks any of them.

### 3.4 Diagnostics (gap analysis)

| Code | Severity | Meaning |
|---|---|---|
| `GAP001 undeclared-name` | gap | A name is used but never introduced ("if num in seen", but `seen` was never set up) |
| `GAP002 empty-block` | gap | A block contains only a `BlockHole` |
| `GAP003 missing-return` | gap | A function path ends without a described return |
| `GAP004 unstated-condition` | gap | A `CondHole` exists |
| `GAP005 vague-value` | gap | An `ExprHole` exists |
| `GAP006 unknown-input` | gap | A function's inputs were never named |
| `GAP007 ambiguous-reference` | gap | A `RefHole` exists |
| `WARN001 unused-name` | warning | Introduced but never used |
| `WARN002 unreachable` | warning | Statements after a `return`/`break` |
| `WARN003 shadowing` | warning | A name is reintroduced in an inner scope |
| `INFO001 inferred` | info | Something was added under an allowed inference rule |

Diagnostics describe what's missing. They **never** suggest what the fix should be.

### 3.5 Allowed-inference policy

Some inference is needed or the tool becomes pedantic. The list is explicit,
short and versioned. Anything not on it is a hole.

| Rule ID | Allowed inference | Example |
|---|---|---|
| `INF-LOOPVAR` | Name a loop variable from the iterable's name | "loop through the numbers" → `for num in nums` |
| `INF-INDEXVAR` | Use `i`/`j` for index loops when no name is given | "loop over the indices" → `for i in range(len(nums))` |
| `INF-RANGE-BOUNDS` | `range(len(x))` for "each index of x" | |
| `INF-SYNONYM` | Map common synonyms to one operation | "add it to the set" / "put it in the set" → `.add()` |
| `INF-PLURAL-NAME` | Name collections in plural form when the user names the item | "the number list" → `nums` |
| `INF-BLOCK-END` | Close a block when the next statement clearly starts outside it | "after the loop, return false" |

**Never inferred:** initial values, data structure choice, conditions,
return values, edge-case handling, function signatures beyond what was said,
and anything the user said "we'll figure out later" about.

### 3.6 Worked example

| # | User says | Ops (summary) | Result |
|---|---|---|---|
| 1 | "Loop through the list of numbers." | `add_stmt(root, ForEach{target: num (INF-LOOPVAR), iterable: nums, body: BlockHole})` | `for num in nums:` + `⟨body not described⟩` |
| 2 | "If we've already seen the number, return true." | `fill_hole(body, If{cond: Membership(num, seen), then: [Return(True)]})` | `if num in seen: return True`. **GAP001**: `seen` never introduced |
| 3 | "Oh, we keep a set called seen, empty at the start." | `add_stmt(root, before loop, Assign(seen, set()))` | GAP001 resolved |
| 4 | "Otherwise add it to the set." | `update_field(if, else, [Update(seen, add, num)])` (`INF-SYNONYM`) | `else: seen.add(num)` |
| — | (nothing said about the end) | — | **GAP003**: no return described after the loop |

The user never said "return False". The tool shows that they didn't.

---

## 4. Milestones at a glance

| Milestone | Outcome | Segments | Rough size (one dev) |
|---|---|---|---|
| **M1: Deterministic engine** | You can build, render, edit and analyze a solution by hand, with no AI | S0–S5 | 5–7 weeks |
| **M2: Language understanding** | Typed sentences become faithful edits, measured against a corpus | S6–S9 | 6–9 weeks |
| **M3: Practice tool** | A usable web app for practicing walkthroughs | S10–S12 | 6–8 weeks |
| **M4: Beyond** | More languages, hardening, speech, live sessions | S13–S16 | open-ended |

Sizes are rough planning guesses. Re-estimate at the end of each milestone.

Dependency graph:

```
S0 → S1 → S2 ─┐
        └→ S3 ─┼→ S4 → S5 ──────────────┐
               │                        ▼
               └────────── S6 → S7 → S8 → S9 → S10 → S11 → S12
                                                 │
                                                 ├→ S13 (languages)
                                                 ├→ S14 (hardening)
                                                 ├→ S15 (speech)
                                                 └→ S16 (live mode)
```

S6 (corpus) can start in parallel with S2–S5. It only needs the IR schema from S1.

---

## 5. Segments in detail

Each segment lists: **Goal**, **Deliverables**, **Design notes**, **Exit
criteria** (the definition of done) and **Risks**.

---

### Milestone 1: Deterministic engine

#### S0: Project foundations

**Status:** ✅ Done

**Goal:** A repo where adding code is cheap and breaking it is loud.

**Deliverables**
- pnpm workspace with empty `core`, `render-python`, `cli` packages; strict `tsconfig`; ESLint + Prettier.
- Vitest configured with coverage; a sample golden-file test.
- GitHub Actions CI: install → typecheck → lint → test (→ Python parse check once S2 lands).
- `docs/adr/` with the first ADRs:
  - ADR-001 TypeScript monorepo
  - ADR-002 IR-first architecture (no direct text→code)
  - ADR-003 Python as first output language
  - ADR-004 Faithfulness contract and allowed-inference policy
  - ADR-005 Event-sourced session history
- `CONTRIBUTING.md` with the principles from §1, plus a `CLAUDE.md` for AI-assisted work in the repo.

**Exit criteria:** CI is green on an empty-but-wired repo. A new package can be added in under 5 minutes.

**Risks:** Over-engineering the tooling. Keep it minimal and add tools only when a need shows up.

---

#### S1: IR schema and holes

**Status:** ✅ Done ([ADR-006](docs/adr/006-ir-schema-and-validation.md))

**Goal:** One precise, versioned definition of what a solution *is*.

**Deliverables**
- `core/ir`: TypeScript types for every node in §3.1, all hole kinds (§3.2), `Span`, `Note`, labels.
- Runtime validation (hand-written guards, or a schema library if one earns its place) plus a **JSON Schema export**. S7 reuses that schema for LLM structured outputs.
- ID generator (monotonic, never reused, survives serialization).
- Tree utilities: `walk`, `find(id)`, `parentOf`, `path`, immutable update helpers.
- Serialization round-trip (`toJSON`/`fromJSON`) with a `schemaVersion` field and a migration hook.
- Symbol-table builder (scopes, definitions, uses).

**Design notes**
- Keep the IR **language-neutral where cheap**. For example, `Update{op: "append"}` instead of a raw `Call(Attribute(x, "append"))`, so later renderers (S13) can map it to `push`/`add`.
- Holes are ordinary nodes, so every tree utility handles them for free.
- Provenance lives on nodes, not in a side table, so it travels with moves and copies.

**Exit criteria**
- Every node kind has a constructor, a validator and a round-trip test.
- Property tests (fast-check) show that random valid trees survive serialization unchanged.

**Risks:** The schema will change. Version it from day one, and keep migrations as tested functions.

---

#### S2: Python renderer and source maps

**Status:** ✅ Done ([ADR-007](docs/adr/007-python-rendering.md))

**Goal:** IR in, readable Python out, with a precise map between the two.

**Deliverables**
- `render-python`: IR → **token stream** (keywords, names, punctuation, hole tokens, comment tokens) → text.
- Two output modes:
  - **UI mode:** hole tokens carry IDs so the UI can render chips.
  - **Export mode:** holes become `...`/`__hole__("…")`, so the text always parses as Python.
- **Source map:** `nodeId ↔ [line/col ranges]` for every node.
- Notes render as comments next to their node. `IntentStmt` renders as `# <user's words>` followed by a hole.
- Stable formatting: deterministic indentation, blank-line rules and naming. The same IR always gives the same bytes.
- Golden tests: 40+ IR fixtures → expected `.py`. CI parses every export with Python's `ast`.

**Design notes**
- Rendering must be **local**: changing one node changes only that node's lines. This is what keeps on-screen code stable during a walkthrough (principle 4).
- Precedence-aware expression printing (parentheses only where needed).

**Exit criteria**
- All golden tests pass, and every export parses.
- The source map covers 100% of nodes (tested by walking the IR).
- A one-node change produces a minimal text diff (tested).

**Risks:** Trying to match Black's formatting exactly. Don't; consistent and readable is enough.

---

#### S3: Edit operations, applier and history

**Goal:** The only way to change a solution is through validated, undoable operations.

**Deliverables**
- `core/ops`: types for every op in §3.3; `EditBatch { utteranceId, ops[], provenance }`.
- `apply(ir, batch) → { ir, inverse } | Error`. Atomic, pure, never mutates its input.
- Invariant checker run after every batch: tree validity, unique IDs, every non-inferred node has provenance, holes are referenced correctly, moves don't create cycles.
- **Event-sourced session:** an append-only log of `{utterance, batch, resultingVersion}`. The current IR is a fold over the log (cache snapshots every N events).
- Undo/redo (pop/push batches); `revert(utteranceId)` ("scratch that").
- IR diff utility (structural diff between two versions), used by the UI to animate changes.

**Exit criteria**
- Every op has unit tests for success and each failure mode.
- Property test: `apply(batch)` then `apply(inverse)` gives back the original IR.
- Replaying a session log rebuilds the same IR, byte for byte.

**Risks:** `wrap_nodes` and `move_node` have tricky edge cases (non-adjacent nodes, moving into your own child). Spec them in tests before implementing them.

---

#### S4: Analyzer (gap and diagnostic engine)

**Goal:** Turn "what's missing" into a precise, explainable list.

**Deliverables**
- `core/analyze`: every diagnostic in §3.4, each with code, severity, node ID, message and the quoted words involved.
- Inference-policy registry (§3.5): each rule is an ID, a description and a checker that verifies an `inferred` node really fits the rule.
- A **coverage summary** computed from the IR: inputs named? return described on all paths? edge cases mentioned (notes tagged as edge cases)? complexity stated (notes tagged as complexity)? This becomes the practice checklist in S11.

**Design notes**
- Messages state the gap, never the fix: "`seen` is used but never set up", not "add `seen = set()`".
- Diagnostics are recomputed from scratch on every version. The analyzer is cheap and stateless.

**Exit criteria**
- Every diagnostic code has tests that make it fire and tests that keep it quiet.
- The §3.6 example produces exactly the expected diagnostics at each step.

**Risks:** Too much noise. Every warning-level rule needs a reason to exist. Default to fewer.

---

#### S5: Developer console

**Goal:** Drive the whole engine by hand, with no AI, to show that M1 works and to make debugging easy later.

**Deliverables**
- `cli` REPL: type ops as compact commands (`add root ForEach num nums`, `fill h3 ...`), see rendered code, diagnostics and history after each one.
- `:undo`, `:redo`, `:log`, `:ir` (dump JSON), `:export file.py`, `:load session.json`.
- **Scenario scripts:** a file of op commands plus expected output, run in CI as end-to-end tests of the engine.

**Exit criteria (M1 done)**
- The §3.6 example and at least 10 more scripted scenarios run end to end in CI.
- A new contributor can follow the README and drive the console without help.

---

### Milestone 2: Language understanding

#### S6: Walkthrough corpus and evaluation harness

**Goal:** Measure translation quality from the first LLM call onward. This
segment **comes before the translator** on purpose.

**Deliverables**
- `corpus/problems/`: 30 classic interview problems (two-sum, valid parentheses, merge intervals, sliding-window max, BFS on a grid, etc.). **Statements only**, never reference solutions.
- `corpus/walkthroughs/`: 2–3 walkthroughs per problem in different styles:
  - *terse* ("hash map from value to index, one pass")
  - *rambling* (restarts, filler, "um, so basically")
  - *corrective* (says something wrong, then fixes it)
  - *deliberately incomplete* (leaves out the return or an edge case; tests faithfulness)
- `corpus/gold/`: for each utterance, the expected IR after the step, the expected holes, and the set of acceptable op batches. A step can have more than one acceptable answer.
- Annotation guide: how to write gold data, especially *what must stay a hole*.
- `eval` runner: plays each walkthrough through any `Translator`, applies batches, and compares against gold. Outputs per-metric scores (§6), per-problem breakdowns, and an HTML/Markdown report that diffs each failure.
- CI gate (activated in S7): faithfulness must not regress. Coverage changes are reported.

**Design notes**
- Compare **IR structure** (after normalizing IDs and names), not rendered text.
- Hold out 20% of the corpus as a test set that is never used for prompt tuning.

**Exit criteria:** At least 60 walkthroughs annotated. The runner works against a stub translator. The report clearly explains every failure.

**Risks:** Annotation is slow and subjective. Write the guide first, and have two people annotate a sample so you can measure how often they agree.

---

#### S7: Translator (text → edit operations)

**Goal:** Turn one utterance plus the current solution into a validated edit batch.

**Deliverables**
- `Translator` interface: `translate(context) → { batch, clarifications, unparsedSpans }`.
- **Baseline translator** (rule-based, about 30 phrase patterns). It is the eval floor, an offline fallback, and a sanity check on the corpus.
- **LLM translator** (Claude API, TypeScript SDK):
  - Default model `claude-opus-5-5`. Run an `effort` sweep (`low`/`medium`/`high`) against the corpus and pick the cheapest setting that holds faithfulness and coverage. Note that Opus 5.5 defaults to `medium`, so set the effort explicitly.
  - **Structured outputs** (`output_config.format` with the JSON Schema from S1/S3) so responses are always schema-valid batches. Forced `tool_choice` is not supported on this model, so structured outputs is the right mechanism.
  - **Prompt caching:** a frozen system prompt, schema, inference policy and few-shot examples go first (cached). The volatile context (IR outline, utterance) goes last.
  - Check `stop_reason` before parsing (`refusal`, `max_tokens`). Enable the server-side refusal fallback.
  - Calls go through `apps/server`; the key never reaches the browser.
- **Context packing** (what the model sees each turn):
  - The utterance, **pre-tokenized with indices** (`[0]loop [1]through [2]the [3]list …`), so provenance cites token ranges instead of fragile character offsets.
  - A compact IR outline with node IDs, labels and open hole IDs.
  - The symbol table (names, where they were introduced).
  - The last few utterances (for "it", "that", "then").
  - The allowed-inference rules and their IDs.
- Output contract: `{ ops[], clarifications[], unparsedSpans[] }`. Unparsed spans become notes, so nothing is dropped (principle 6).
- Retry loop: if the validator (S8) or applier (S3) rejects a batch, send the errors back **once**. If it fails again, apply the valid parts and turn the rest into notes and holes.

**Exit criteria**
- The LLM translator beats the baseline on coverage across the held-out set.
- Faithfulness meets the target in §6 (with S8 in place).
- p50 latency per utterance is under 3 s on typical inputs.
- Cost per 20-utterance session is measured and recorded.

**Risks**
- *The model fills gaps anyway.* S8 is the guard; also add "deliberately incomplete" few-shot examples where the right answer is a hole.
- *Latency.* Mitigate with caching, a smaller effort setting, and optimistic UI (show the utterance immediately and a "translating" state on the affected region).

---

#### S8: Provenance validator and faithfulness guardrails

**Goal:** Make "don't fill gaps" a rule that is **checked**, not just a request in a prompt.

**Deliverables**
- `validator` package, run on every batch before the applier:
  1. **Structural:** every created node and changed field has at least one span, or an `inferred` rule ID. Spans exist and point at the current or an earlier utterance.
  2. **Lexical support:** for names, literals and operators, the cited span must contain supporting words. A cue lexicon maps "greater than", "bigger than", "more than" and ">" to `>`, and "zero", "empty", "nothing" to the matching literals.
  3. **Inference policy:** an `inferred` node must pass its rule's checker (S4 registry).
- **Downgrade, don't discard:** an unsupported subtree is replaced with the matching hole kind. The supported parts of the batch still apply, and the user sees an `INFO`-level note on what was held back.
- Optional **second-opinion verifier**: a cheaper model call (e.g. `claude-haiku-4-5`) that answers "does span X actually say Y?" for nodes without a lexical check. It is on by default in eval and behind a flag at runtime until the cost/benefit is measured.
- Validator metrics in the eval report: rejection rate, downgrade rate, and false rejections (gold-supported nodes the validator wrongly blocked).

**Exit criteria**
- On the "deliberately incomplete" walkthroughs, **no** gold-hole position is filled.
- False-rejection rate is under 5%.

**Risks:** A lexicon that is too strict blocks correct output. Tune it against the false-rejection metric, not by gut feel.

---

#### S9: Reference resolution and refinement

**Goal:** Make "go back and change that part" reliable.

**Deliverables**
- **Auto-labels:** a deterministic, readable label for every block-level node ("loop over nums", "if num in seen"). User-given labels ("call this the duplicate check") take priority.
- **Explicit scope:** a `scope: NodeId` field in the translator context. When it is set (UI click, in S10), it beats any implicit reference.
- **Correction semantics:** cue words ("actually", "instead", "no wait", "rather than") lean toward `replace`/`update` over `add`. Corpus walkthroughs in the *corrective* style test this.
- **Deterministic intercepts** handled before the LLM: "undo", "scratch that", "go back" → history ops. These are free, instant and exact.
- **Ambiguity:** if two or more nodes are plausible targets, the translator returns `ask_clarification` with candidates instead of guessing.
- New metrics: **placement accuracy** (did the edit hit the right node?) and **clarification appropriateness** (did it ask when gold says the reference was ambiguous, and *only* then?).

**Exit criteria (M2 done):** All §6 targets for M2 are met on the held-out set.

---

### Milestone 3: Practice tool

#### S10: Web UI MVP

**Goal:** The two-pane experience described in the original pitch.

**Deliverables**
- `apps/web` layout:
  - **Left:** transcript and input box. Each utterance shows its status: translating, applied, partially applied, needs clarification.
  - **Right:** read-only code (CodeMirror 6). Holes are inline chips; inferred nodes get a subtle marker; changed lines briefly highlight after each edit.
  - **Bottom:** gaps panel, listing diagnostics grouped by severity. Clicking one jumps to the node.
- **Two-way provenance highlighting:** hover a code line to highlight the words that produced it; hover words to highlight their code.
- **Click-to-scope:** clicking a node pins it as the scope for the next utterance (a chip in the input box; Esc clears it).
- **Clarification chips:** a translator question shows the candidates as buttons.
- Undo/redo buttons and shortcuts; a version scrubber.
- Keyboard-first: everything works without a mouse.

**Exit criteria**
- A full walkthrough of 5 corpus problems works in the browser with no console use.
- Playwright tests cover typing, hover links, click-to-scope, undo, clarification and export.

**Risks:** UI scope creep. Ship exactly the layout above, then iterate based on real use.

---

#### S11: Sessions, feedback and practice features

**Goal:** Turn the engine into a practice routine.

**Deliverables**
- **Persistence:** the session event log is saved locally (IndexedDB). Sessions can be listed, resumed and deleted.
- **Problem picker:** choose a corpus problem (statement shown at the top) or type your own.
- **Walkthrough checklist** (from the S4 coverage summary): inputs ✓, approach ✓, edge cases ✗, return ✓, complexity ✗. It describes what was covered; it never grades whether the approach is correct.
- **Session report** (Markdown/PDF export): the final code with holes, the gap list, the full transcript with provenance, and a timeline of when each part was added or revised.
- **Replay mode:** step through a past session utterance by utterance, to review how the explanation developed.
- Export: `.py` (export-mode holes), `.json` (full session), `.md` (report).

**Exit criteria:** A user can do a timed practice session, close the browser, come back, and export a report.

---

#### S12: Construct expansion

**Goal:** Cover the full range of common interview problems.

**Deliverables** (each one is IR nodes + renderer + analyzer rules + corpus walkthroughs + baseline patterns where reasonable):
- Helper functions and calls between them; recursion (with a `GAP` rule for "no base case described").
- `while` loops with two pointers; sliding-window idioms.
- Simple classes for `ListNode`/`TreeNode` (provided as givens with the problem, not inferred).
- Dicts with default values, `Counter`-style counting, sorting with keys, heaps (`heapq`), deques for BFS.
- Nested loops; early `break`/`continue`; multiple returns.
- Grid traversal (`for r in range(rows)` …) and neighbor iteration.

**Exit criteria:** The corpus grows to 60+ problems, and M2 targets hold on the expanded held-out set.

**Risks:** Every construct adds surface area to the faithfulness guarantee. Add corpus cases for each before calling it supported.

---

### Milestone 4: Beyond

#### S13: Additional output languages

- A `Renderer` interface (token stream + source map) implemented per language: JavaScript/TypeScript first, then Java and C++.
- Lowering passes for constructs without a direct equivalent (Python `for x in xs` → Java enhanced-for; `x in set` → `.has()`/`.contains()`).
- A language toggle in the UI. The **IR doesn't change**; only rendering does.
- Exit criteria: golden tests and a compile/parse check per language in CI.

#### S14: Hardening

- **Latency:** stream partial results; optimistic rendering; pre-warm the prompt cache when a session opens.
- **Cost:** per-session budget display; effort and model re-tuning from S7 data; batch-run evals to save cost.
- **Privacy:** transcripts stay on the device by default. The server proxy is stateless and logs no content. Contributing sessions to the corpus is opt-in.
- **Security:** rate limiting and auth on the proxy; input size limits.
- **Accessibility:** holes are never shown by color alone; screen-reader labels for chips and diagnostics; WCAG AA contrast in both themes.
- **Offline mode:** the baseline translator plus the full engine work with no network.

#### S15: Speech input

- An input adapter that turns streaming speech-to-text into utterances (push-to-talk segments), with word timings mapped to token spans.
- Disfluency handling: strip filler words, collapse restarts. The cleaned text is shown so provenance stays honest.
- Since everything downstream already takes text, this segment shouldn't touch the core. If it needs to, that's a design bug worth fixing.

#### S16: Live and shared sessions

- A read-only shareable link to a session (event-log replay).
- **Presenter mode** for real interviews: a clean code view for the interviewer, with the gaps panel visible only to the candidate (or neither, by choice).
- Interviewer annotations on nodes.
- Real-time sync by broadcasting the event log (single writer, so no CRDT needed).
- Talk to interviewers before building this: its value depends on whether they accept the tool (§7).

---

## 6. Evaluation strategy

### 6.1 Metrics

| Metric | Definition | M2 target | M3 target |
|---|---|---|---|
| **Faithfulness** | % of produced nodes supported by the user's words (validator + judge) | ≥ 99% | ≥ 99.5% |
| **Gap preservation** | % of gold-hole positions left as holes | 100% on "incomplete" set | 100% |
| **Coverage** | % of gold nodes produced (structural match) | ≥ 85% | ≥ 92% |
| **Placement accuracy** | % of refinements applied to the correct node | ≥ 90% | ≥ 95% |
| **Clarification precision / recall** | Asks when the reference is ambiguous, and only then | ≥ 80% / ≥ 80% | ≥ 90% / ≥ 90% |
| **Stability** | % of untouched lines byte-identical across a turn | 100% (deterministic) | 100% |
| **False rejections** | Gold-supported nodes the validator blocked | ≤ 5% | ≤ 2% |
| **Latency** | p50 / p95 per utterance | ≤ 3 s / ≤ 7 s | ≤ 2 s / ≤ 5 s |
| **Cost** | API cost per 20-utterance session | measured | within budget set after M2 |

Faithfulness and gap preservation **block merges** in CI. The rest are tracked
and reported.

### 6.2 Process

- Every translator, prompt or validator change runs the full corpus. The report is attached to the PR.
- Tune only on the training split. The held-out split is scored but never tuned against.
- Every bug report becomes a corpus case before it is fixed.

---

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The LLM fills gaps despite instructions | High | Critical | S8 validator with downgrade-to-hole; "incomplete" corpus set as a merge gate |
| Too pedantic: holes for obvious things | Medium | High | Explicit allowed-inference list (§3.5), tuned with user feedback; `INFO` markers instead of holes for allowed inferences |
| Wrong node edited during refinement | Medium | High | Labels, click-to-scope, clarification instead of guessing, placement metric |
| Latency breaks the flow of talking | Medium | High | Caching, effort tuning, optimistic UI, baseline translator for simple phrases |
| Corpus too small or biased toward the author's speaking style | High | Medium | Several walkthrough styles; outside contributors; opt-in session donation (S14) |
| Typing is slower than writing code for fluent programmers | High | Medium | Position the tool for practice and learning first; live interview use is a later bet (S16) |
| Interviewers see it as a crutch | Medium | Medium | Talk to interviewers before S16; presenter mode hides the gap hints |
| IR schema churn breaks saved sessions | Medium | Medium | `schemaVersion` + tested migrations from S1 |
| API cost grows with usage | Medium | Medium | Per-session cost metric, caching, effort sweeps, offline baseline |

---

## 8. Decisions to make

Decide these in the listed segment and record each one as an ADR.

| Question | Decide in | Leaning |
|---|---|---|
| Use a schema library (e.g. Zod) or hand-written guards + JSON Schema? | S1 | **Decided:** Zod 4 with hand-written types ([ADR-006](docs/adr/006-ir-schema-and-validation.md)) |
| Hole sentinel in export: `...` + comment, or `__hole__("…")`? | S2 | **Decided:** both, plus placeholder names in binding positions ([ADR-007](docs/adr/007-python-rendering.md)) |
| Spans as token indices or character offsets? | S1/S7 | **Decided:** token indices ([ADR-006](docs/adr/006-ir-schema-and-validation.md)) |
| How strict is the lexical check by default? | S8 | Start strict; loosen based on the false-rejection rate |
| Hosted app or local-only first? | S10 | Local dev server first; hosted after S14 privacy work |
| Should the user's stated complexity ("this is O(n)") be checked? | S11 | No. Record it as a note. Checking it would be grading, which is outside the tool's job |
| First language after Python | S13 | JavaScript/TypeScript |

---

## 9. Out of scope (for now)

- Solving problems, suggesting next steps, or grading correctness.
- Running the user's code or generating tests for it.
- Free-form code editing in the code pane (the code is a *view* of the explanation; edits go through words).
- Languages other than Python before S13.
- Speech before S15.

---

## 10. Glossary

| Term | Meaning |
|---|---|
| **Utterance** | One submitted piece of user text (a sentence or a few). |
| **IR** | The tree that represents the solution so far. The single source of truth. |
| **Hole** | An explicit placeholder for something the user hasn't described. |
| **Provenance** | The span(s) of user text a node came from. |
| **Edit batch** | The atomic set of operations produced from one utterance. |
| **Allowed inference** | One of a small, explicit set of things the tool may add without being told. |
| **Downgrade** | Replacing an unsupported part of a batch with a hole instead of rejecting the whole batch. |
| **Gold** | The hand-annotated expected result used for evaluation. |
| **Scope** | A node the user pinned as the target of their next utterance. |
