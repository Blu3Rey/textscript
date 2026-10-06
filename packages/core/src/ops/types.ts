// Edit operations: the only way to change a solution (ROADMAP.md §3.3,
// docs/adr/008).
//
// The translator emits a batch of operations per utterance. The applier
// expands each into primitive steps (insert, delete, swap, set) that are
// exactly reversible, and returns the inverse batch alongside the result.
// The program must be well-formed after every operation except primitives,
// which may pass through intermediate states (an empty block, say).
//
// Nodes created by a batch may use temporary IDs (`t1`, `t2`, …) so later
// operations in the same batch can refer to them. The applier replaces them
// with permanent IDs before anything else happens.

import type {
  Block,
  DictEntry,
  Elif,
  Expr,
  IrDocument,
  NodeId,
  NoteTag,
  Span,
  Stmt,
} from '../ir/types';

/** Any JSON value: what `update_field` and `set_field` carry. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Where to put a statement in a block or the program body. */
export type InsertPosition = { at: 'start' | 'end' } | { before: NodeId } | { after: NodeId };

interface OpBase {
  /** The words that caused this operation. */
  provenance?: Span[];
}

/** Adds a statement to a block or the program. Fills the block's hole if it has one. */
export interface AddStmtOp extends OpBase {
  op: 'add_stmt';
  /** A `Block` or the `Program`. */
  parent: NodeId;
  position: InsertPosition;
  stmt: Stmt;
}

/** Fills a hole: an expression for an expression hole, statements for a `BlockHole`. */
export interface FillHoleOp extends OpBase {
  op: 'fill_hole';
  hole: NodeId;
  value: Expr | Stmt[];
}

/**
 * Changes one field of a node: an operator, a name, a literal's value, or a
 * child expression. Not for lists (use add/remove/move) or metadata (use
 * set_label and add_note). The op's provenance is added to the node's.
 */
export interface UpdateFieldOp extends OpBase {
  op: 'update_field';
  node: NodeId;
  field: string;
  /** A node for a child field; a string, number, boolean or null otherwise. */
  value: ReplaceableNode | JsonValue;
}

/** Replaces any node except the program. */
export interface ReplaceNodeOp extends OpBase {
  op: 'replace_node';
  node: NodeId;
  replacement: ReplaceableNode;
}

/**
 * Removes a node. A statement leaves a `BlockHole` if its block becomes
 * empty; a node in a required field leaves a hole of the matching kind; one
 * in an optional field leaves the field empty.
 */
export interface RemoveNodeOp extends OpBase {
  op: 'remove_node';
  node: NodeId;
}

/** Moves a statement to another place in any block or the program. */
export interface MoveNodeOp extends OpBase {
  op: 'move_node';
  node: NodeId;
  parent: NodeId;
  position: InsertPosition;
}

/**
 * Puts adjacent sibling statements inside a new compound statement. The
 * wrapper's `body` must hold exactly one `BlockHole`; the statements take
 * its place.
 */
export interface WrapNodesOp extends OpBase {
  op: 'wrap_nodes';
  nodes: NodeId[];
  wrapper: Stmt;
}

/** Renames a name everywhere it refers to the same thing. `node` is any of its `Name` nodes. */
export interface RenameSymbolOp extends OpBase {
  op: 'rename_symbol';
  node: NodeId;
  name: string;
}

/** Sets a node's label, or removes it when `label` is absent. Labels are unique. */
export interface SetLabelOp extends OpBase {
  op: 'set_label';
  node: NodeId;
  label?: string;
}

/** Attaches a note. Its provenance is the op's, which must not be empty. */
export interface AddNoteOp extends OpBase {
  op: 'add_note';
  node: NodeId;
  text: string;
  tag: NoteTag;
}

export interface RemoveNoteOp extends OpBase {
  op: 'remove_note';
  note: NodeId;
}

/** Changes nothing; asks the user a question. */
export interface AskClarificationOp extends OpBase {
  op: 'ask_clarification';
  question: string;
  candidates: NodeId[];
}

// Primitives: exactly reversible steps that every operation expands into.
// Inverse batches consist of these.

/** Inserts a node into a list field. */
export interface InsertAtOp extends OpBase {
  op: 'insert_at';
  parent: NodeId;
  field: string;
  index: number;
  node: ListNode;
}

/** Deletes a node from the list it's in. No holes are added. */
export interface DeleteChildOp extends OpBase {
  op: 'delete_child';
  node: NodeId;
}

/** Puts `replacement` where node `node` is. The primitive behind `replace_node`. */
export interface SwapNodeOp extends OpBase {
  op: 'swap_node';
  node: NodeId;
  replacement: ReplaceableNode;
}

/** Sets a field that isn't a list of children, or clears it when `value` is absent. */
export interface SetFieldOp extends OpBase {
  op: 'set_field';
  node: NodeId;
  field: string;
  value?: JsonValue;
}

/** Nodes that can stand in for another node (anything but the program). */
export type ReplaceableNode = Stmt | Expr | Block | Elif | DictEntry;

/** Nodes that live in list fields. */
export type ListNode = Stmt | Expr | Elif | DictEntry;

export type PrimitiveOp = InsertAtOp | DeleteChildOp | SwapNodeOp | SetFieldOp;

export type EditOp =
  | AddStmtOp
  | FillHoleOp
  | UpdateFieldOp
  | ReplaceNodeOp
  | RemoveNodeOp
  | MoveNodeOp
  | WrapNodesOp
  | RenameSymbolOp
  | SetLabelOp
  | AddNoteOp
  | RemoveNoteOp
  | AskClarificationOp
  | InsertAtOp
  | DeleteChildOp
  | SwapNodeOp
  | SetFieldOp;

export type EditOpKind = EditOp['op'];

/** Everything one utterance changed. Applied atomically. */
export interface EditBatch {
  utteranceId: string;
  ops: EditOp[];
}

export interface Clarification {
  question: string;
  candidates: NodeId[];
}

export type ApplyErrorCode =
  /** The batch doesn't match the operation schemas. */
  | 'invalid-batch'
  /** A temporary ID is used before being given to a node, or given twice. */
  | 'invalid-temp-id'
  | 'unknown-node'
  | 'unknown-note'
  /** The node is the program, which can't be replaced, removed or moved. */
  | 'root'
  /** The parent can't hold statements, or the field isn't a list. */
  | 'invalid-parent'
  /** A position anchor isn't a statement in the given parent. */
  | 'invalid-anchor'
  | 'invalid-field'
  | 'invalid-index'
  /** The value doesn't fit: statements for an expression hole, or the reverse. */
  | 'invalid-value'
  | 'not-a-hole'
  | 'not-a-statement'
  | 'not-a-name'
  | 'not-in-list'
  /** A move would put a statement inside itself. */
  | 'move-into-self'
  /** Nodes to wrap don't share a parent list, or aren't adjacent. */
  | 'not-siblings'
  | 'not-adjacent'
  | 'invalid-wrapper'
  | 'invalid-name'
  | 'duplicate-label'
  /** The op needs provenance (a note must come from the user's words). */
  | 'missing-provenance'
  /** An op left the program malformed, or the batch left the document invalid. */
  | 'invalid-result';

export interface ApplyError {
  code: ApplyErrorCode;
  message: string;
  /** The op that failed; absent for errors about the whole batch. */
  opIndex?: number;
  /** For `invalid-batch` and `invalid-result`: each problem found. */
  issues?: string[];
}

export type ApplyResult =
  | {
      ok: true;
      document: IrDocument;
      /** A batch that undoes this one when applied to `document`. */
      inverse: EditBatch;
      clarifications: Clarification[];
    }
  | { ok: false; error: ApplyError };
