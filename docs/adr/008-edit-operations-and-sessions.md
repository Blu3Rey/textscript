# 008: Edit operations, inverses and the session log

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S3

## Context

ROADMAP §3.3 lists the operations the translator will emit, and ADR-005
chose an append-only session log. S3 has to make both concrete: how an
operation finds its target, how new nodes get IDs, what each operation does
at the edges (an emptied block, a removed condition), how a batch is undone
exactly, and how undo, redo and "scratch that" fit the log.

## Decision

### Operations expand into four exact primitives

The translator-facing operations are `add_stmt`, `fill_hole`,
`update_field`, `replace_node`, `remove_node`, `move_node`, `wrap_nodes`,
`rename_symbol`, `set_label`, `add_note`, `remove_note` and
`ask_clarification`. The applier expands each into **primitives**:
`insert_at` (into a list), `delete_child` (from a list), `swap_node`
(replace a node in place) and `set_field` (set or clear a non-list field).
Each primitive records its exact inverse as it runs, so **a batch's inverse
is its primitives' inverses in reverse order**. The inverse is itself a
valid batch, made only of primitives, and applying it restores the original
program exactly.

Primitives are also accepted in batches, which is what lets inverses be
applied, but the translator has no reason to emit them.

### Statements are placed by anchor, not index

`add_stmt` and `move_node` take `{ at: 'start' | 'end' }`, `{ before: id }`
or `{ after: id }`. A model can name a node it sees far more reliably than
count positions, and anchors survive other edits.

### New nodes use temporary IDs

A batch may give new nodes temporary IDs (`t1`, `t2`, …) so later operations
in the same batch can refer to them (add a loop, then add to its body). The
applier first replaces every temporary ID with the next permanent one, in
the order they appear in the batch, rewriting only ID and reference fields
(so a string literal reading `"t1"` is untouched). The IR shape accepts
temporary IDs so batches can be validated with the IR schemas, and a new
invariant, `temp-id`, keeps them out of documents. Valid documents are
unchanged, so the schema version stays at 1.

### Gaps stay gaps when code moves around

- Adding a statement to a block that only holds a `BlockHole` fills the
  hole instead of sitting next to it.
- Removing or moving out a block's last statement leaves a `BlockHole`;
  the program body may become empty.
- Removing a node in a required field leaves a hole of the matching kind
  (`CondHole` for conditions, `NameHole` for names being bound, `ExprHole`
  otherwise, a block holding a `BlockHole` for blocks). Removing one in an
  optional field (`else`, `range` start or step, a `return` value, slice
  parts) just clears the field.

These holes get fixed reasons (`HOLE_REASONS`) and the op's provenance, so
the user can see what their words removed.

### Rules for the other operations

- `update_field` changes non-list, non-metadata fields, replacing a child
  node when given one. The op's provenance is added to the node's, so a node
  changed by words cites them.
- `wrap_nodes` takes adjacent siblings only, and a compound wrapper whose
  body is a single `BlockHole` that the statements take the place of.
  Wrapping non-adjacent statements would silently reorder the ones between.
- `move_node` moves statements only, never into themselves.
- `rename_symbol` takes **any `Name` node** of the symbol rather than a
  symbol ID (the translator sees node IDs). It renames every definition and
  use; for a name that's never defined, every use of that name.
- Labels are unique. Notes need provenance and get applier-allocated IDs.
  `remove_note` was added alongside `add_note`.
- `ask_clarification` changes nothing and returns the question.

### Atomic, validated, never mutating

`apply(document, batch)` returns the new document in canonical form, its
inverse and any clarification questions, or an error with a code and the
index of the op that caused it. The input is never modified. After every
operation except a primitive, the program must be well-formed. That pins
errors to the op that caused them, and guarantees everything an inverse
captures is well-formed too. (Primitives are exempt: an inverse may pass
through an empty block for a moment.) After the whole batch, the document
must pass the full schema and invariants. `nextId` never decreases, even
when an inverse is applied, so IDs are never reused.

### Sessions

A session is a log of events: `edit` (an utterance and its batch), `undo`,
`redo` and `revert` (undo one earlier utterance's edit). The state is a
fold of the log over an empty program.

- **Undo and redo** restore exact snapshots of the program. They keep the
  current `nextId`.
- **Revert** applies the target edit's inverse on top of everything since.
  If later edits make that impossible, it reports `revert-conflict` and
  changes nothing. A revert is itself undoable, and a new edit or revert
  clears the redo stack.
- Only events that applied are logged; an utterance that changed nothing is
  logged with an empty batch.
- `replay(events, start)` rebuilds the state, optionally from a cached
  state, which is how snapshots work.
- Utterances are stored with their tokens. A token is a decimal number, a
  word (letters, digits, underscores, inner apostrophes) or any other
  non-space character.

### Diffs

`diffPrograms(before, after)` reports added, removed, changed (a node's own
fields, labels, notes or provenance) and moved nodes, for the UI to animate.
A reorder reports the fewest statements that explain it: those outside the
longest run that kept its order.

### Changes from ROADMAP §3.3

- `rename_symbol` takes a node, not a symbol ID.
- Added `remove_note` and the four primitives.
- `EditBatch` has no batch-level provenance: every op carries its own.

## Consequences

- Undo is exact, and revert works across later edits whenever they don't
  conflict, which property tests check on random sessions.
- The translator must order operations so each leaves a well-formed
  program. To replace an expression with a statement, it replaces the
  enclosing statement instead. The error names the op, which helps S7's
  retry loop.
- `editBatchJsonSchema()` is ready for S7's structured outputs, with
  temporary IDs allowed. Its golden file shows every change in review.
- Inverses carry whole subtrees, so they're larger than the batches they
  undo. Sessions are small, so this doesn't matter yet.

## Alternatives considered

- **Inverses in the user-level vocabulary.** Exact inverses of operations
  like `wrap_nodes` or a hole-filling `add_stmt` can't be expressed in it.
- **One primitive that sets a whole list.** Exact, but reverting an older
  utterance would overwrite later changes to the same block.
- **Undo by inverse only.** Works, but snapshots are simpler and exact, and
  structural sharing keeps them cheap; inverses are kept for revert.
- **Index positions.** Easier to apply, much harder for a model to get right.
- **Model-chosen permanent IDs.** Can't be made collision-free.
