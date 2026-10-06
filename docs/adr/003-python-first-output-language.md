# 003: Python as the first output language

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S0 (renderer in S2)

## Context

The first renderer sets the vocabulary the corpus, prompts and tests are
written in. Supporting several languages from the start would multiply that
work before the core idea is proven.

## Decision

Python is the only output language until segment S13. The IR stays
language-neutral where that costs little (for example `Update{op: "append"}`
rather than a raw method call), so later renderers can map operations to
their own idioms.

## Consequences

- Rendered code reads close to pseudocode, which suits explaining an approach.
- Python is the most common language in coding interviews, so the corpus is
  easiest to build and review.
- CI can check that every golden file parses with Python's own `ast` module.
- Python-specific idioms (comprehensions, tuple unpacking) need a lowering
  plan before S13.

## Alternatives considered

- **JavaScript/TypeScript first.** Matches the implementation language, but
  reads less like pseudocode and is less common in interviews.
- **Language-agnostic pseudocode.** Unfamiliar to interviewers and can't be
  checked by a real parser.
