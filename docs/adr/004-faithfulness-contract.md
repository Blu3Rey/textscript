# 004: Faithfulness contract and allowed-inference policy

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S0 (enforced from S4 and S8)

## Context

TextScript shows what a user has covered in their explanation. Its value
disappears if it quietly completes their thinking: a filled-in initial value
or return statement hides exactly the gap the user needs to see. Language
models fill gaps by default, so asking them not to is not enough.

## Decision

1. **Every IR node carries provenance:** at least one span of the user's
   words, or the ID of an allowed-inference rule. A node with neither is
   invalid and the op applier rejects it.
2. **Unsupported content becomes a hole.** When part of a translation isn't
   supported by the user's words, that part is replaced with the matching
   hole kind and the rest of the batch still applies.
3. **Allowed inferences are an explicit, versioned list** (ROADMAP §3.5),
   such as naming a loop variable `num` from "the numbers". Each rule has an
   ID and a checker. Adding or widening a rule means updating that list and
   adding corpus cases that show the rule doesn't fill real gaps.
4. **Never inferred:** initial values, data structure choices, conditions,
   return values, edge-case handling, function signatures beyond what was
   said, and anything the user deferred.
5. **Diagnostics state the gap, never the fix.** "`seen` is used but never
   set up", not "add `seen = set()`".
6. **Nothing said is dropped.** Text that can't be encoded becomes a note on
   the closest node.

## Consequences

- Faithfulness can be tested and measured. Corpus walkthroughs that are
  deliberately incomplete become a merge gate (S6).
- The tool will sometimes be more literal than a user wants. The inference
  list is where that trade-off is tuned, deliberately and visibly.
- Every new IR construct needs provenance handling and corpus coverage before
  it counts as supported.

## Alternatives considered

- **Prompt-only faithfulness.** Not verifiable, and the failure is silent.
- **No inference at all.** Leaves holes for things no reader would consider
  missing (`for num in nums`), which buries the real gaps.
