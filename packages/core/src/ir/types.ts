// The TextScript intermediate representation (IR).
//
// The IR is the single source of truth for a solution. It is close to a
// Python AST with three additions (ROADMAP.md §3.1):
//   - holes: explicit placeholders for anything the user hasn't described,
//   - provenance: the spans of the user's words each node came from,
//   - labels and notes: names for parts of the solution, and things said
//     about them that aren't code.
//
// These interfaces are the readable spec. `schema.ts` mirrors them as Zod
// schemas, and the tests check that the two stay exactly equal.

import type { InferenceRuleId } from './inference';

/** Stable node identifier: `n` followed by a positive integer. Never reused. */
export type NodeId = string;

/**
 * A range of tokens in one utterance: the words a node came from.
 * Token indices, `start` inclusive and `end` exclusive (docs/adr/006).
 */
export interface Span {
  utteranceId: string;
  start: number;
  end: number;
}

/** What a note is about. The analyzer uses tags for the coverage checklist. */
export type NoteTag = 'general' | 'edge-case' | 'complexity';

/** Something the user said about a node that isn't code ("this is O(n)"). */
export interface Note {
  id: NodeId;
  text: string;
  tag: NoteTag;
  provenance: Span[];
}

/** Fields every node has. */
export interface NodeMeta {
  /** Required (non-empty) unless `inferred` is set or the node is a hole or structural. */
  provenance: Span[];
  /** The allowed-inference rule that produced this node (ROADMAP.md §3.5). */
  inferred?: InferenceRuleId;
  /** A user-given name for this part ("the duplicate check"). */
  label?: string;
  notes?: Note[];
}

// ---------------------------------------------------------------------------
// Operators

export type ArithmeticOp = '+' | '-' | '*' | '/' | '//' | '%' | '**';
export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export type BoolOpKind = 'and' | 'or';
export type UnaryOpKind = 'not' | '-';
/**
 * In-place updates. Kept language-neutral (`append`, not a call to `.append`)
 * so renderers for other languages can map them to their own idioms.
 */
export type UpdateOp =
  '+=' | '-=' | '*=' | '/=' | '//=' | '%=' | 'append' | 'extend' | 'add' | 'remove' | 'discard';
export type CollectionKind = 'list' | 'set' | 'tuple';

// ---------------------------------------------------------------------------
// Holes: things the user referred to or implied but didn't describe.

/** A block whose contents were never described. Only ever the sole statement of a block. */
export interface BlockHole extends NodeMeta {
  kind: 'BlockHole';
  id: NodeId;
  reason: string;
}

/** A condition mentioned but not stated ("if it's valid"). */
export interface CondHole extends NodeMeta {
  kind: 'CondHole';
  id: NodeId;
  reason: string;
}

/** A value mentioned vaguely ("update the count"). */
export interface ExprHole extends NodeMeta {
  kind: 'ExprHole';
  id: NodeId;
  reason: string;
}

/** Something referred to but never named ("the list"). */
export interface NameHole extends NodeMeta {
  kind: 'NameHole';
  id: NodeId;
  reason: string;
}

/** A reference that matches more than one thing; `candidates` are the possible nodes. */
export interface RefHole extends NodeMeta {
  kind: 'RefHole';
  id: NodeId;
  reason: string;
  candidates: NodeId[];
}

// ---------------------------------------------------------------------------
// Expressions

export interface Name extends NodeMeta {
  kind: 'Name';
  id: NodeId;
  name: string;
}

/** A finite number, string, boolean, or `null` (Python `None`). */
export interface Literal extends NodeMeta {
  kind: 'Literal';
  id: NodeId;
  value: string | number | boolean | null;
}

/** Positive or negative infinity ("start the minimum at infinity"). */
export interface InfinityLiteral extends NodeMeta {
  kind: 'InfinityLiteral';
  id: NodeId;
  negative: boolean;
}

export interface UnaryOp extends NodeMeta {
  kind: 'UnaryOp';
  id: NodeId;
  op: UnaryOpKind;
  operand: Expr;
}

export interface BinOp extends NodeMeta {
  kind: 'BinOp';
  id: NodeId;
  op: ArithmeticOp;
  left: Expr;
  right: Expr;
}

/** One comparison. Chains like `0 <= i < n` are a `BoolOp` of two comparisons. */
export interface Compare extends NodeMeta {
  kind: 'Compare';
  id: NodeId;
  op: CompareOp;
  left: Expr;
  right: Expr;
}

/** `and`/`or` over two or more operands. */
export interface BoolOp extends NodeMeta {
  kind: 'BoolOp';
  id: NodeId;
  op: BoolOpKind;
  operands: Expr[];
}

/** `element in container`, or `not in` when `negated`. */
export interface Membership extends NodeMeta {
  kind: 'Membership';
  id: NodeId;
  negated: boolean;
  element: Expr;
  container: Expr;
}

export interface Call extends NodeMeta {
  kind: 'Call';
  id: NodeId;
  callee: Expr;
  args: Expr[];
}

export interface Index extends NodeMeta {
  kind: 'Index';
  id: NodeId;
  object: Expr;
  index: Expr;
}

export interface Slice extends NodeMeta {
  kind: 'Slice';
  id: NodeId;
  object: Expr;
  start?: Expr;
  stop?: Expr;
  step?: Expr;
}

export interface Attribute extends NodeMeta {
  kind: 'Attribute';
  id: NodeId;
  object: Expr;
  name: string;
}

export interface CollectionLiteral extends NodeMeta {
  kind: 'CollectionLiteral';
  id: NodeId;
  collection: CollectionKind;
  elements: Expr[];
}

export interface DictEntry extends NodeMeta {
  kind: 'DictEntry';
  id: NodeId;
  key: Expr;
  value: Expr;
}

export interface DictLiteral extends NodeMeta {
  kind: 'DictLiteral';
  id: NodeId;
  entries: DictEntry[];
}

export type Expr =
  | Name
  | Literal
  | InfinityLiteral
  | UnaryOp
  | BinOp
  | Compare
  | BoolOp
  | Membership
  | Call
  | Index
  | Slice
  | Attribute
  | CollectionLiteral
  | DictLiteral
  | ExprHole
  | CondHole
  | NameHole
  | RefHole;

/** What can be assigned to. */
export type Target = Name | NameHole | Index | Attribute;

/** What a loop variable, function name or parameter can be. */
export type Binding = Name | NameHole;

// ---------------------------------------------------------------------------
// Statements

/** A non-empty statement list. Holds exactly one `BlockHole` when nothing was described. */
export interface Block extends NodeMeta {
  kind: 'Block';
  id: NodeId;
  stmts: Stmt[];
}

export interface FunctionDef extends NodeMeta {
  kind: 'FunctionDef';
  id: NodeId;
  name: Binding;
  params: Binding[];
  body: Block;
}

export interface ForEach extends NodeMeta {
  kind: 'ForEach';
  id: NodeId;
  target: Binding;
  iterable: Expr;
  body: Block;
}

/** `for target in range(start, stop, step)`; `start` and `step` are optional. */
export interface ForRange extends NodeMeta {
  kind: 'ForRange';
  id: NodeId;
  target: Binding;
  start?: Expr;
  stop: Expr;
  step?: Expr;
  body: Block;
}

export interface While extends NodeMeta {
  kind: 'While';
  id: NodeId;
  cond: Expr;
  body: Block;
}

export interface Elif extends NodeMeta {
  kind: 'Elif';
  id: NodeId;
  cond: Expr;
  body: Block;
}

export interface If extends NodeMeta {
  kind: 'If';
  id: NodeId;
  cond: Expr;
  body: Block;
  elifs: Elif[];
  orelse?: Block;
}

export interface Assign extends NodeMeta {
  kind: 'Assign';
  id: NodeId;
  target: Target;
  value: Expr;
}

export interface Update extends NodeMeta {
  kind: 'Update';
  id: NodeId;
  target: Target;
  op: UpdateOp;
  value: Expr;
}

export interface Return extends NodeMeta {
  kind: 'Return';
  id: NodeId;
  value?: Expr;
}

export interface Break extends NodeMeta {
  kind: 'Break';
  id: NodeId;
}

export interface Continue extends NodeMeta {
  kind: 'Continue';
  id: NodeId;
}

export interface ExprStmt extends NodeMeta {
  kind: 'ExprStmt';
  id: NodeId;
  expr: Expr;
}

/**
 * A step the user described in words that has no code form yet
 * ("process the element here"). The text is kept verbatim.
 */
export interface IntentStmt extends NodeMeta {
  kind: 'IntentStmt';
  id: NodeId;
  text: string;
}

export type Stmt =
  | FunctionDef
  | ForEach
  | ForRange
  | While
  | If
  | Assign
  | Update
  | Return
  | Break
  | Continue
  | ExprStmt
  | IntentStmt
  | BlockHole;

/** The root. An empty `body` is a session where nothing has been said yet. */
export interface Program extends NodeMeta {
  kind: 'Program';
  id: NodeId;
  body: Stmt[];
}

/** A serialized solution: the program plus what's needed to keep editing it. */
export interface IrDocument {
  schemaVersion: 1;
  /** The next ID to allocate. Every ID in the document is below it. */
  nextId: number;
  program: Program;
}

// ---------------------------------------------------------------------------
// Unions over every node kind

export type Hole = BlockHole | CondHole | ExprHole | NameHole | RefHole;

/** Every kind of node, including the helper nodes `Elif` and `DictEntry`. */
export type IrNode = Program | Block | Stmt | Expr | Elif | DictEntry;

export type NodeKind = IrNode['kind'];

export type NodeOfKind<K extends NodeKind> = Extract<IrNode, { kind: K }>;
