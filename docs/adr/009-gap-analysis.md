# 009: Gap analysis and coverage

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S4

## Context

The analyzer turns a program into the list of what the explanation hasn't
covered. It's what the user sees most often, so two things matter more than
completeness: it must be faithful (never suggest a fix, per ADR-004), and it
must not be noisy (ROADMAP §7: "too pedantic" is a high-impact risk). It's
also where S2 left compile-time-only mistakes, and where the allowed-inference
rules get their checkers.

## Decision

### Shape

`analyze(program, options)` returns diagnostics, a coverage summary and the
symbol table. It's stateless and recomputed for every version. Each
diagnostic has a code, name, severity (`gap`, `warning`, `info`), the node it
concerns, related nodes, a message, the spans of the user's words involved,
and (given the utterances) those words quoted. Diagnostics come in document
order.

**Messages state the gap, never the fix**: "`seen` is used but never set
up", not "add `seen = set()`". A test checks messages for fix-suggesting
words.

### What the problem gives is an option, not a guess

A name used but never set up is a gap (GAP001), except for names the
language provides (`builtins`, e.g. `PYTHON_BUILTINS`) and names the
**problem** provides as inputs (`inputs`). In the worked example, `nums` (the
input) and `seen` (a real gap) look identical in the IR; only the problem
statement tells them apart. With no inputs given, both are reported. That's
the honest default for a free-form problem, and the coverage summary marks
inputs as `unknown`.

### The catalog

ROADMAP §3.4's codes, plus additions:

- **GAP008 unnamed** and **GAP009 step-in-words-only**: a `NameHole`
  outside a function's inputs, and an `IntentStmt`, are gaps too, so every
  hole and word-only step maps to exactly one code.
- **WARN004 unsupported-inference**: a node marked `inferred` that doesn't
  fit its rule. Fitting inferences are INFO001.
- **WARN005 used-before-set**: a use before the first definition in the same
  scope (`prev` read before it's assigned in a loop). Uses from inside a
  function aren't counted, since the function may run later.
- **WARN006 jump-outside-loop** and **WARN007 duplicate-parameter**: mistakes
  Python's compiler (but not its parser) rejects, deferred here by ADR-007.

### Rules chosen to keep noise down

- **Missing return (GAP003)** applies only when something in that function
  (or the top-level code) returns a value and some path reaches the end
  without one. A function that returns nothing is presumably meant to work
  in place, so it isn't flagged. Top-level code counts as a function body,
  because walkthroughs often skip the `def`.
- **Unused names (WARN001)** skip function names (a solution function is
  never called), loop variables (`for x in xs: count += 1` is fine) and
  names starting with `_`. Unused inputs *are* reported.
- **Shadowing (WARN003)** reports names set up inside a function that hide
  an outer one, but not parameters, where reusing outer names is normal.
- **Unreachable code (WARN002)** reports only the first unreachable step in
  each block, after `return`, `break`, `continue`, an `if` whose every
  branch (with an `else`) ends early, or `while True` without a way out.

### Inference rules

`INFERENCE_RULES` gives each §3.5 rule a description, an example and a
structural checker: the node is the kind of thing the rule covers, where it
covers it (a loop variable named after its collection, `i`/`j`/`k` for an
index, `len()` as a range bound, …). Rules that reinterpret words (synonym,
plural name, block end) also require provenance; rules that supply
something unsaid (a loop variable's name) don't. S8's validator will reuse
these checkers.

### Coverage

The coverage summary feeds the S11 checklist. It reports whether anything
has been described, whether inputs are named (from the function's
parameters, or the given inputs), whether returns cover all paths, some or
none, the notes tagged as edge cases and as complexity, and the number of
gaps. It describes coverage only; it never judges whether the approach is
right.

## Consequences

- The worked example (ROADMAP §3.6) is a test that checks the exact
  diagnostics, with quotes, after each of its four utterances. GAP003 first
  appears at step 2, as soon as something is returned; the roadmap table now
  says so.
- Callers must pass builtins and the problem's inputs, or names like `len`
  and `nums` are reported. The S5 console and S10 UI will pass them.
- Adding a node kind means deciding which diagnostic, if any, covers it.
  Property tests require every hole and word-only step to get exactly one.

## Alternatives considered

- **Guess inputs from usage** (names only read, never assigned). At the
  point in the walkthrough where `seen` is only read, it looks exactly like
  `nums`, so the guess would hide a real gap.
- **Flag every function without a return.** Wrong for in-place problems
  (rotate an array, reverse a list), which are common in interviews.
- **Fewer codes, with holes reported generically.** The UI and the S11
  report need to say *what kind* of thing is missing.
