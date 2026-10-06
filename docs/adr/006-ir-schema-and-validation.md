# 006: IR schema definition and validation

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S1

## Context

The IR is the contract every other part of TextScript depends on: the
renderer reads it, the op applier changes it, sessions persist it, and in S7
a language model produces edits to it through structured outputs. It needs:

- TypeScript types that read like a spec,
- runtime validation for untrusted input (saved sessions, model output),
- a JSON Schema for structured outputs that accepts **exactly** what the
  runtime validator accepts, and
- rules that span several nodes (unique IDs, provenance requirements), which
  JSON Schema can't express.

ROADMAP §8 left two questions for S1: whether to use a schema library, and
whether spans count tokens or characters.

## Decision

**Types, schemas and invariants are three separate layers.**

1. **Hand-written interfaces** (`packages/core/src/ir/types.ts`) are the
   readable spec.
2. **Zod 4 schemas** (`schema.ts`) mirror them. A type-level test fails
   `pnpm typecheck` if any kind's schema output stops being exactly equal to
   its interface. Recursive fields use getters with explicit return types,
   so there are no casts. Objects are strict: unknown keys are errors.
3. **Invariants** (`invariants.ts`) hold every rule that spans nodes: unique
   IDs below `nextId`, provenance required unless the node is a hole, a
   structural node or carries an inference rule, `BlockHole` only as the sole
   statement of a block, span ordering, and `RefHole` candidates that exist.

The schemas check shape only, so `irDocumentJsonSchema()` (Zod's JSON Schema
export, draft 2020-12, with named `$defs`) accepts exactly what they accept.
Property tests compare the two on random valid documents and on random
corruptions of them.

**Zod is the core package's one runtime dependency.** It has no dependencies
of its own and runs in any JavaScript environment, so the engine stays
environment-agnostic (ADR-001).

**Spans count tokens**, with `start` inclusive and `end` exclusive. Whoever
tokenizes an utterance (the session layer, S3/S7) must do it
deterministically and store the tokens with the utterance.

**Serialization is canonical.** Writing a document re-parses it through the
schema, which validates it and emits keys in schema order (payload fields
first, then provenance and metadata). Equal documents always produce
identical text. Reading runs JSON → version/migration → shape → invariants,
and reports which stage failed.

**IDs** are `n<k>` with `k` increasing. `IrDocument.nextId` stores where
allocation stopped, so IDs are never reused across saves.

**The symbol table follows Python scoping** (ADR-003): only the program and
functions create scopes, and a name assigned anywhere in a function is local
to it. Each occurrence records its evaluation order so the analyzer can
detect use-before-definition. Built-in names are supplied by the caller,
which keeps the IR language-neutral.

### Changes from the ROADMAP §3.1 sketch

| Sketch | Implemented | Why |
|---|---|---|
| `Not` | `UnaryOp` with `not` and `-` | Negation (`-x`) is needed too. |
| — | `InfinityLiteral` | "Start the minimum at infinity" is common, and JSON has no infinity. |
| `CollectionLiteral` for dicts too | `CollectionLiteral` (list, set, tuple) plus `DictLiteral` of `DictEntry` nodes | Dict entries have two children each. |
| `If { then, else }` | `If { body, elifs: Elif[], orelse? }` | An object with a `then` field looks like a promise to JavaScript. `Elif` is a node so edits can target it. |
| Program has a block | `Program.body` is a plain list, possibly empty | An empty session has no statements, not a hole. |
| Notes are strings | `Note { id, text, tag, provenance }` | Notes need IDs for editing and tags for the S4 coverage checklist. |

## Consequences

- One readable source for the types, and drift between types and schemas is
  a compile error rather than a runtime surprise.
- The JSON Schema is a golden file (`packages/core/test/golden/`), so every
  schema change shows up in review.
- S7 must check the JSON Schema against what Claude's structured outputs
  support, and may need to adapt the export.
- The schema is at version 1. Any change to what a valid document looks
  like bumps `IR_SCHEMA_VERSION` and adds a tested migration.

## Alternatives considered

- **Hand-written guards plus a hand-written JSON Schema.** Three sources to
  keep in sync by hand, with nothing checking that they agree.
- **Types inferred from Zod schemas.** Recursive inference needs explicit
  annotations anyway, and the inferred types are hard to read as a spec.
- **JSON Schema as the source, with Ajv and generated types.** Ajv compiles
  validators with `new Function`, which a strict Content Security Policy in
  the web app (S10) would block. It's used only in tests here.
