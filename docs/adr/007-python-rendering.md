# 007: Rendering the IR as Python

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S2

## Context

The renderer is what the user actually sees. It has to show exactly the
structure the IR holds, make gaps obvious, link every piece of code back to a
node, stay stable while the user keeps talking, and (in export) produce a
file Python accepts. ROADMAP §8 left one question for S2: what placeholders
holes become in exported code.

## Decision

### Output: tokens plus a source map

`render(program, { mode })` returns the text, the tokens of each line, and a
source map from every node and note ID to a text range. Positions are
0-based lines and columns plus an offset into the text, counted in UTF-16
code units like JavaScript strings and CodeMirror. A node's range runs from
its first token to the end of its last: indentation and any parentheses its
parent adds are outside it. Every token except indentation records the
innermost node that produced it. These types are language-neutral so S13
renderers can share them.

### Two modes

- **export**: plain Python that always parses.
- **ui**: identical except holes become `⟨reason⟩` chips for the UI to
  decorate.

| IR | export | ui |
|---|---|---|
| `BlockHole` | `...  # TODO(textscript): <reason>` | `⟨reason⟩` |
| `ExprHole`, `CondHole`, `RefHole`, `NameHole` in an expression | `__hole__("<reason>")` | `⟨reason⟩` |
| `NameHole` where a name is bound (target, function name, parameter) | `__hole_<id>__` plus `# TODO(textscript): <reason>` at line end | `⟨reason⟩` |
| `IntentStmt` | `# <the user's words>` then `...` | `⟨the user's words⟩` |

A hole in a binding position can't be a call (`__hole__("x") = 1` is a
syntax error), hence the placeholder name. Several TODO reasons on one line
share one comment: `# TODO(textscript): a; b`.

### Notes become comments, never inline

A statement's notes, and the notes of any expression on its header line, are
comment lines directly above it. An `Elif`'s notes go above its `elif`, a
block's notes are the first lines inside the block, and the program's notes
open the file. Tags add a prefix: `# Complexity: …`, `# Edge case: …`.
Comment text is reduced to one line with no control characters.

Labels and inference markers are **not** rendered. They're metadata the UI
shows from the IR, using the source map to place them.

### Formatting

- Four-space indentation. PEP 8 blank lines around functions (two at top
  level, one when nested) and nowhere else.
- Minimal parentheses from Python's precedence table, with three deliberate
  exceptions that keep the tree visible or the text readable: a `BoolOp`
  nested in the same operator keeps its parentheses, comparisons are never
  chained (`(a < b) < c`), and a minus applied to a minus is `-(-x)`.
- Python idioms where they change nothing: `x is None` for a comparison
  with `None`, `set()` for an empty set, `(a,)` for a one-element tuple,
  `float("inf")` for infinity, `(1).real` for an attribute of a number.
- Names that are Python keywords get a trailing underscore (`class_`).
- `range()` needs a start before a step, so a loop with a step and no stated
  start renders `range(0, n, 2)`. The `0` is Python's own default, not an
  inference about the user's intent; the token belongs to the `ForRange`
  node, not a node of its own.

### Verification

- 45 golden cases, each rendered in both modes; every export golden must
  parse (`pnpm check:python`).
- Property tests on random IR:
  - Export output parses with Python's own `ast` (500 programs per run).
  - **Same meaning:** rendering with minimal parentheses and with every
    compound expression parenthesized gives identical Python ASTs. The fully
    parenthesized form needs no precedence logic, so any precedence mistake,
    including one that still parses but means something else, shows up as a
    mismatch.
  - Every node has a range, and children sit inside their parent in source
    order.
  - Each expression's mapped text equals rendering it alone.
  - **Locality:** replacing one expression or statement leaves every line
    outside its range byte-identical.

Each property was checked by injecting a bug it should catch.

## Consequences

- The UI can highlight, hover and place chips from the tokens and source map
  alone, without re-deriving positions.
- Output is stable while the user talks: only the changed node's lines move,
  apart from notes (a new comment line) and functions (blank lines around
  them), both by design.
- Some valid-looking IR still renders code Python's compiler (not parser)
  rejects: duplicate parameter names, assigning `__debug__`, `return` outside
  a function. These are gaps for the S4 analyzer to report, not render errors.
- Renaming keywords can collide if a user uses both `class` and `class_`.
  This is rare enough to leave for now.
- Placeholder names (`__hole_n12__`) come from node IDs, so they're stable
  until the hole is filled.

## Alternatives considered

- **`pass` for block holes.** Reads as "do nothing", which is a claim the
  user never made; `...` reads as "something goes here".
- **`None` or `...` for expression holes.** Valid Python, but a reader can't
  tell the gap from a deliberate value. `__hole__("…")` can't be mistaken
  for real code and carries the reason.
- **Inline comments for notes.** They don't fit inside expressions or
  multi-line statements, and they make lines long.
- **Formatting with Black.** Would need Python at render time and reflows
  whole files, breaking locality.
