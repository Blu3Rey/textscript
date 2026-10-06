// Constructors for every node kind.
//
// Each constructor allocates a fresh ID and builds the node with its keys in
// schema order, so a constructed node serializes exactly like a parsed one.
// Provenance defaults to empty; the invariant checker decides whether that's
// allowed for the node in its context.

import { createIdAllocator, type IdAllocator } from './ids';
import type { InferenceRuleId } from './inference';
import type {
  Assign,
  Attribute,
  BinOp,
  Block,
  BlockHole,
  BoolOp,
  Break,
  Call,
  CollectionLiteral,
  Compare,
  CondHole,
  Continue,
  DictEntry,
  DictLiteral,
  Elif,
  Expr,
  ExprHole,
  ExprStmt,
  ForEach,
  ForRange,
  FunctionDef,
  If,
  Index,
  InfinityLiteral,
  IntentStmt,
  IrDocument,
  Literal,
  Membership,
  Name,
  NameHole,
  NodeId,
  NodeKind,
  NodeMeta,
  Note,
  NoteTag,
  Program,
  RefHole,
  Return,
  Slice,
  Span,
  Stmt,
  UnaryOp,
  Update,
  While,
} from './types';
import { IR_SCHEMA_VERSION } from './version';

/** Optional metadata accepted by every constructor. */
export interface MetaInput {
  provenance?: Span[];
  inferred?: InferenceRuleId;
  label?: string;
  notes?: Note[];
}

/** A node's own fields, without `kind`, `id` and metadata. */
type Fields<N> = Omit<N, 'kind' | 'id' | keyof NodeMeta>;

function metaFields(input: MetaInput): NodeMeta {
  return {
    provenance: input.provenance ?? [],
    ...(input.inferred === undefined ? {} : { inferred: input.inferred }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

export type Builder = ReturnType<typeof createBuilder>;

/**
 * Returns constructors that draw IDs from `ids`. To keep editing an existing
 * document, pass `createIdAllocator(doc.nextId)`.
 */
export function createBuilder(ids: IdAllocator = createIdAllocator()) {
  const head = <K extends NodeKind>(kind: K) => ({ kind, id: ids.allocate() });

  return {
    ids,

    /** Wraps a program in a document that records where ID allocation stopped. */
    document(program: Program): IrDocument {
      return { schemaVersion: IR_SCHEMA_VERSION, nextId: ids.next, program };
    },

    note(text: string, tag: NoteTag, provenance: Span[]): Note {
      return { id: ids.allocate(), text, tag, provenance };
    },

    // Holes ---------------------------------------------------------------

    blockHole(reason: string, m: MetaInput = {}): BlockHole {
      return { ...head('BlockHole'), reason, ...metaFields(m) };
    },
    condHole(reason: string, m: MetaInput = {}): CondHole {
      return { ...head('CondHole'), reason, ...metaFields(m) };
    },
    exprHole(reason: string, m: MetaInput = {}): ExprHole {
      return { ...head('ExprHole'), reason, ...metaFields(m) };
    },
    nameHole(reason: string, m: MetaInput = {}): NameHole {
      return { ...head('NameHole'), reason, ...metaFields(m) };
    },
    refHole(reason: string, candidates: NodeId[], m: MetaInput = {}): RefHole {
      return { ...head('RefHole'), reason, candidates, ...metaFields(m) };
    },

    // Expressions ---------------------------------------------------------

    name(name: string, m: MetaInput = {}): Name {
      return { ...head('Name'), name, ...metaFields(m) };
    },
    literal(value: Literal['value'], m: MetaInput = {}): Literal {
      return { ...head('Literal'), value, ...metaFields(m) };
    },
    infinity(negative: boolean, m: MetaInput = {}): InfinityLiteral {
      return { ...head('InfinityLiteral'), negative, ...metaFields(m) };
    },
    unaryOp(f: Fields<UnaryOp>, m: MetaInput = {}): UnaryOp {
      return { ...head('UnaryOp'), op: f.op, operand: f.operand, ...metaFields(m) };
    },
    binOp(f: Fields<BinOp>, m: MetaInput = {}): BinOp {
      return { ...head('BinOp'), op: f.op, left: f.left, right: f.right, ...metaFields(m) };
    },
    compare(f: Fields<Compare>, m: MetaInput = {}): Compare {
      return { ...head('Compare'), op: f.op, left: f.left, right: f.right, ...metaFields(m) };
    },
    boolOp(f: Fields<BoolOp>, m: MetaInput = {}): BoolOp {
      return { ...head('BoolOp'), op: f.op, operands: f.operands, ...metaFields(m) };
    },
    membership(
      f: Omit<Fields<Membership>, 'negated'> & { negated?: boolean },
      m: MetaInput = {},
    ): Membership {
      return {
        ...head('Membership'),
        negated: f.negated ?? false,
        element: f.element,
        container: f.container,
        ...metaFields(m),
      };
    },
    call(f: Fields<Call>, m: MetaInput = {}): Call {
      return { ...head('Call'), callee: f.callee, args: f.args, ...metaFields(m) };
    },
    index(f: Fields<Index>, m: MetaInput = {}): Index {
      return { ...head('Index'), object: f.object, index: f.index, ...metaFields(m) };
    },
    slice(f: Fields<Slice>, m: MetaInput = {}): Slice {
      return {
        ...head('Slice'),
        object: f.object,
        ...(f.start === undefined ? {} : { start: f.start }),
        ...(f.stop === undefined ? {} : { stop: f.stop }),
        ...(f.step === undefined ? {} : { step: f.step }),
        ...metaFields(m),
      };
    },
    attribute(f: Fields<Attribute>, m: MetaInput = {}): Attribute {
      return { ...head('Attribute'), object: f.object, name: f.name, ...metaFields(m) };
    },
    collection(f: Fields<CollectionLiteral>, m: MetaInput = {}): CollectionLiteral {
      return {
        ...head('CollectionLiteral'),
        collection: f.collection,
        elements: f.elements,
        ...metaFields(m),
      };
    },
    dictEntry(f: Fields<DictEntry>, m: MetaInput = {}): DictEntry {
      return { ...head('DictEntry'), key: f.key, value: f.value, ...metaFields(m) };
    },
    dict(entries: DictEntry[], m: MetaInput = {}): DictLiteral {
      return { ...head('DictLiteral'), entries, ...metaFields(m) };
    },

    // Statements ----------------------------------------------------------

    program(body: Stmt[], m: MetaInput = {}): Program {
      return { ...head('Program'), body, ...metaFields(m) };
    },
    block(stmts: Stmt[], m: MetaInput = {}): Block {
      return { ...head('Block'), stmts, ...metaFields(m) };
    },
    functionDef(f: Fields<FunctionDef>, m: MetaInput = {}): FunctionDef {
      return {
        ...head('FunctionDef'),
        name: f.name,
        params: f.params,
        body: f.body,
        ...metaFields(m),
      };
    },
    forEach(f: Fields<ForEach>, m: MetaInput = {}): ForEach {
      return {
        ...head('ForEach'),
        target: f.target,
        iterable: f.iterable,
        body: f.body,
        ...metaFields(m),
      };
    },
    forRange(f: Fields<ForRange>, m: MetaInput = {}): ForRange {
      return {
        ...head('ForRange'),
        target: f.target,
        ...(f.start === undefined ? {} : { start: f.start }),
        stop: f.stop,
        ...(f.step === undefined ? {} : { step: f.step }),
        body: f.body,
        ...metaFields(m),
      };
    },
    while(f: Fields<While>, m: MetaInput = {}): While {
      return { ...head('While'), cond: f.cond, body: f.body, ...metaFields(m) };
    },
    elif(f: Fields<Elif>, m: MetaInput = {}): Elif {
      return { ...head('Elif'), cond: f.cond, body: f.body, ...metaFields(m) };
    },
    if(f: Omit<Fields<If>, 'elifs'> & { elifs?: Elif[] }, m: MetaInput = {}): If {
      return {
        ...head('If'),
        cond: f.cond,
        body: f.body,
        elifs: f.elifs ?? [],
        ...(f.orelse === undefined ? {} : { orelse: f.orelse }),
        ...metaFields(m),
      };
    },
    assign(f: Fields<Assign>, m: MetaInput = {}): Assign {
      return { ...head('Assign'), target: f.target, value: f.value, ...metaFields(m) };
    },
    update(f: Fields<Update>, m: MetaInput = {}): Update {
      return {
        ...head('Update'),
        target: f.target,
        op: f.op,
        value: f.value,
        ...metaFields(m),
      };
    },
    return(value?: Expr, m: MetaInput = {}): Return {
      return { ...head('Return'), ...(value === undefined ? {} : { value }), ...metaFields(m) };
    },
    break(m: MetaInput = {}): Break {
      return { ...head('Break'), ...metaFields(m) };
    },
    continue(m: MetaInput = {}): Continue {
      return { ...head('Continue'), ...metaFields(m) };
    },
    exprStmt(expr: Expr, m: MetaInput = {}): ExprStmt {
      return { ...head('ExprStmt'), expr, ...metaFields(m) };
    },
    intent(text: string, m: MetaInput = {}): IntentStmt {
      return { ...head('IntentStmt'), text, ...metaFields(m) };
    },
  };
}
