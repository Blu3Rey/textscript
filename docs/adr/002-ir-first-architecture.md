# 002: IR-first architecture

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S0 (implemented in S1–S3)

## Context

The product turns a user's spoken-style explanation into code, and lets them
add to it or revise earlier parts later. Translating text straight to code
on every message would regenerate the whole solution each turn: unrelated
lines would churn, revisions couldn't target a specific part, and there
would be nowhere to record which words produced which code.

## Decision

All code is derived from an **intermediate representation (IR)**, a tree of
statement and expression nodes with three additions: holes for missing
parts, provenance spans linking each node to the user's words, and labels.

- The translator never writes code. It emits **edit operations** on the IR.
- The **op applier** is the only thing that changes the IR. It validates
  every batch against the IR invariants and applies it atomically.
- **Renderers** turn the IR into source text plus a source map. They are
  deterministic: the same IR always produces the same bytes.
- The **analyzer** derives diagnostics (gaps, warnings) from the IR on demand.

## Consequences

- Revisions are precise edits to identified nodes, so untouched code stays
  byte-identical between turns.
- Provenance and holes are structural, so they can be checked, not just
  requested from a model.
- New output languages are new renderers; the IR doesn't change.
- The IR schema is a long-lived contract. It is versioned from S1 and every
  change needs a tested migration.

## Alternatives considered

- **Text → code per turn.** Simplest, but fails on stability, targeted
  revision and verifiable faithfulness.
- **Text → code, then diff against the previous code.** Diffing text can't
  tell a revision from a regeneration, and provenance is lost.
