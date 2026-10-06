// Zod schemas for the IR in `types.ts`.
//
// The schemas check shape only: what JSON Schema can express. Rules that
// span several nodes (unique IDs, provenance requirements, where holes may
// appear) live in `invariants.ts`. Keeping that split means the exported
// JSON Schema accepts exactly what these schemas accept.
//
// Recursive fields are getters with explicit return types, which is how
// Zod 4 builds recursive schemas without `z.lazy` or casts.

import { z } from 'zod';
import { INFERENCE_RULE_IDS } from './inference';
import type { Binding, Block, DictEntry, Elif, Expr, IrDocument, Stmt, Target } from './types';
import { IR_SCHEMA_VERSION } from './version';

/** Gives schemas readable names in the exported JSON Schema's `$defs`. */
const registry = z.registry<{ id: string }>();

function named<T extends z.ZodType>(id: string, schema: T): T {
  const registered: z.ZodType = schema;
  registry.add(registered, { id });
  return schema;
}

export const NODE_ID_PATTERN = /^n[1-9][0-9]*$/;
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const NodeIdSchema = named('NodeId', z.string().regex(NODE_ID_PATTERN));
const IdentifierSchema = named('Identifier', z.string().regex(IDENTIFIER_PATTERN));
const TextSchema = named('Text', z.string().min(1));

export const SpanSchema = named(
  'Span',
  z.strictObject({
    utteranceId: TextSchema,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  }),
);

export const NoteSchema = named(
  'Note',
  z.strictObject({
    id: NodeIdSchema,
    text: TextSchema,
    tag: z.enum(['general', 'edge-case', 'complexity']),
    provenance: z.array(SpanSchema),
  }),
);

const ProvenanceSchema = named('Provenance', z.array(SpanSchema));
const InferenceRuleIdSchema = named('InferenceRuleId', z.enum(INFERENCE_RULE_IDS));
const NotesSchema = named('Notes', z.array(NoteSchema));

/**
 * Fields every node has. Spread last so payload fields come first in JSON.
 * A function so each node gets its own optional wrappers, which keeps them
 * inline in the JSON Schema instead of becoming anonymous `$defs`.
 */
function meta() {
  return {
    provenance: ProvenanceSchema,
    inferred: InferenceRuleIdSchema.exactOptional(),
    label: TextSchema.exactOptional(),
    notes: NotesSchema.exactOptional(),
  };
}

const reason = TextSchema;

// ---------------------------------------------------------------------------
// Holes

export const BlockHoleSchema = named(
  'BlockHole',
  z.strictObject({ kind: z.literal('BlockHole'), id: NodeIdSchema, reason, ...meta() }),
);
export const CondHoleSchema = named(
  'CondHole',
  z.strictObject({ kind: z.literal('CondHole'), id: NodeIdSchema, reason, ...meta() }),
);
export const ExprHoleSchema = named(
  'ExprHole',
  z.strictObject({ kind: z.literal('ExprHole'), id: NodeIdSchema, reason, ...meta() }),
);
export const NameHoleSchema = named(
  'NameHole',
  z.strictObject({ kind: z.literal('NameHole'), id: NodeIdSchema, reason, ...meta() }),
);
export const RefHoleSchema = named(
  'RefHole',
  z.strictObject({
    kind: z.literal('RefHole'),
    id: NodeIdSchema,
    reason,
    candidates: z.array(NodeIdSchema).min(2),
    ...meta(),
  }),
);

// ---------------------------------------------------------------------------
// Expressions

export const NameSchema = named(
  'Name',
  z.strictObject({ kind: z.literal('Name'), id: NodeIdSchema, name: IdentifierSchema, ...meta() }),
);

export const LiteralSchema = named(
  'Literal',
  z.strictObject({
    kind: z.literal('Literal'),
    id: NodeIdSchema,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ...meta(),
  }),
);

export const InfinityLiteralSchema = named(
  'InfinityLiteral',
  z.strictObject({
    kind: z.literal('InfinityLiteral'),
    id: NodeIdSchema,
    negative: z.boolean(),
    ...meta(),
  }),
);

export const UnaryOpSchema = named(
  'UnaryOp',
  z.strictObject({
    kind: z.literal('UnaryOp'),
    id: NodeIdSchema,
    op: z.enum(['not', '-']),
    get operand(): z.ZodType<Expr> {
      return ExprSchema;
    },
    ...meta(),
  }),
);

export const BinOpSchema = named(
  'BinOp',
  z.strictObject({
    kind: z.literal('BinOp'),
    id: NodeIdSchema,
    op: z.enum(['+', '-', '*', '/', '//', '%', '**']),
    get left(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get right(): z.ZodType<Expr> {
      return ExprSchema;
    },
    ...meta(),
  }),
);

export const CompareSchema = named(
  'Compare',
  z.strictObject({
    kind: z.literal('Compare'),
    id: NodeIdSchema,
    op: z.enum(['==', '!=', '<', '<=', '>', '>=']),
    get left(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get right(): z.ZodType<Expr> {
      return ExprSchema;
    },
    ...meta(),
  }),
);

export const BoolOpSchema = named(
  'BoolOp',
  z.strictObject({
    kind: z.literal('BoolOp'),
    id: NodeIdSchema,
    op: z.enum(['and', 'or']),
    get operands(): z.ZodArray<z.ZodType<Expr>> {
      return z.array(ExprSchema).min(2);
    },
    ...meta(),
  }),
);

export const MembershipSchema = named(
  'Membership',
  z.strictObject({
    kind: z.literal('Membership'),
    id: NodeIdSchema,
    negated: z.boolean(),
    get element(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get container(): z.ZodType<Expr> {
      return ExprSchema;
    },
    ...meta(),
  }),
);

export const CallSchema = named(
  'Call',
  z.strictObject({
    kind: z.literal('Call'),
    id: NodeIdSchema,
    get callee(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get args(): z.ZodArray<z.ZodType<Expr>> {
      return z.array(ExprSchema);
    },
    ...meta(),
  }),
);

export const IndexSchema = named(
  'Index',
  z.strictObject({
    kind: z.literal('Index'),
    id: NodeIdSchema,
    get object(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get index(): z.ZodType<Expr> {
      return ExprSchema;
    },
    ...meta(),
  }),
);

export const SliceSchema = named(
  'Slice',
  z.strictObject({
    kind: z.literal('Slice'),
    id: NodeIdSchema,
    get object(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get start(): z.ZodExactOptional<z.ZodType<Expr>> {
      return ExprSchema.exactOptional();
    },
    get stop(): z.ZodExactOptional<z.ZodType<Expr>> {
      return ExprSchema.exactOptional();
    },
    get step(): z.ZodExactOptional<z.ZodType<Expr>> {
      return ExprSchema.exactOptional();
    },
    ...meta(),
  }),
);

export const AttributeSchema = named(
  'Attribute',
  z.strictObject({
    kind: z.literal('Attribute'),
    id: NodeIdSchema,
    get object(): z.ZodType<Expr> {
      return ExprSchema;
    },
    name: IdentifierSchema,
    ...meta(),
  }),
);

export const CollectionLiteralSchema = named(
  'CollectionLiteral',
  z.strictObject({
    kind: z.literal('CollectionLiteral'),
    id: NodeIdSchema,
    collection: z.enum(['list', 'set', 'tuple']),
    get elements(): z.ZodArray<z.ZodType<Expr>> {
      return z.array(ExprSchema);
    },
    ...meta(),
  }),
);

export const DictEntrySchema = named(
  'DictEntry',
  z.strictObject({
    kind: z.literal('DictEntry'),
    id: NodeIdSchema,
    get key(): z.ZodType<Expr> {
      return ExprSchema;
    },
    get value(): z.ZodType<Expr> {
      return ExprSchema;
    },
    ...meta(),
  }),
);

export const DictLiteralSchema = named(
  'DictLiteral',
  z.strictObject({
    kind: z.literal('DictLiteral'),
    id: NodeIdSchema,
    get entries(): z.ZodArray<z.ZodType<DictEntry>> {
      return z.array(DictEntrySchema);
    },
    ...meta(),
  }),
);

export const ExprSchema: z.ZodType<Expr> = named(
  'Expr',
  z.discriminatedUnion('kind', [
    NameSchema,
    LiteralSchema,
    InfinityLiteralSchema,
    UnaryOpSchema,
    BinOpSchema,
    CompareSchema,
    BoolOpSchema,
    MembershipSchema,
    CallSchema,
    IndexSchema,
    SliceSchema,
    AttributeSchema,
    CollectionLiteralSchema,
    DictLiteralSchema,
    ExprHoleSchema,
    CondHoleSchema,
    NameHoleSchema,
    RefHoleSchema,
  ]),
);

export const TargetSchema: z.ZodType<Target> = named(
  'Target',
  z.discriminatedUnion('kind', [NameSchema, NameHoleSchema, IndexSchema, AttributeSchema]),
);

export const BindingSchema: z.ZodType<Binding> = named(
  'Binding',
  z.discriminatedUnion('kind', [NameSchema, NameHoleSchema]),
);

// ---------------------------------------------------------------------------
// Statements

export const BlockSchema = named(
  'Block',
  z.strictObject({
    kind: z.literal('Block'),
    id: NodeIdSchema,
    get stmts(): z.ZodArray<z.ZodType<Stmt>> {
      return z.array(StmtSchema).min(1);
    },
    ...meta(),
  }),
);

export const FunctionDefSchema = named(
  'FunctionDef',
  z.strictObject({
    kind: z.literal('FunctionDef'),
    id: NodeIdSchema,
    name: BindingSchema,
    params: z.array(BindingSchema),
    get body(): z.ZodType<Block> {
      return BlockSchema;
    },
    ...meta(),
  }),
);

export const ForEachSchema = named(
  'ForEach',
  z.strictObject({
    kind: z.literal('ForEach'),
    id: NodeIdSchema,
    target: BindingSchema,
    iterable: ExprSchema,
    get body(): z.ZodType<Block> {
      return BlockSchema;
    },
    ...meta(),
  }),
);

export const ForRangeSchema = named(
  'ForRange',
  z.strictObject({
    kind: z.literal('ForRange'),
    id: NodeIdSchema,
    target: BindingSchema,
    start: ExprSchema.exactOptional(),
    stop: ExprSchema,
    step: ExprSchema.exactOptional(),
    get body(): z.ZodType<Block> {
      return BlockSchema;
    },
    ...meta(),
  }),
);

export const WhileSchema = named(
  'While',
  z.strictObject({
    kind: z.literal('While'),
    id: NodeIdSchema,
    cond: ExprSchema,
    get body(): z.ZodType<Block> {
      return BlockSchema;
    },
    ...meta(),
  }),
);

export const ElifSchema = named(
  'Elif',
  z.strictObject({
    kind: z.literal('Elif'),
    id: NodeIdSchema,
    cond: ExprSchema,
    get body(): z.ZodType<Block> {
      return BlockSchema;
    },
    ...meta(),
  }),
);

export const IfSchema = named(
  'If',
  z.strictObject({
    kind: z.literal('If'),
    id: NodeIdSchema,
    cond: ExprSchema,
    get body(): z.ZodType<Block> {
      return BlockSchema;
    },
    get elifs(): z.ZodArray<z.ZodType<Elif>> {
      return z.array(ElifSchema);
    },
    get orelse(): z.ZodExactOptional<z.ZodType<Block>> {
      return BlockSchema.exactOptional();
    },
    ...meta(),
  }),
);

export const AssignSchema = named(
  'Assign',
  z.strictObject({
    kind: z.literal('Assign'),
    id: NodeIdSchema,
    target: TargetSchema,
    value: ExprSchema,
    ...meta(),
  }),
);

export const UpdateSchema = named(
  'Update',
  z.strictObject({
    kind: z.literal('Update'),
    id: NodeIdSchema,
    target: TargetSchema,
    op: z.enum([
      '+=',
      '-=',
      '*=',
      '/=',
      '//=',
      '%=',
      'append',
      'extend',
      'add',
      'remove',
      'discard',
    ]),
    value: ExprSchema,
    ...meta(),
  }),
);

export const ReturnSchema = named(
  'Return',
  z.strictObject({
    kind: z.literal('Return'),
    id: NodeIdSchema,
    value: ExprSchema.exactOptional(),
    ...meta(),
  }),
);

export const BreakSchema = named(
  'Break',
  z.strictObject({ kind: z.literal('Break'), id: NodeIdSchema, ...meta() }),
);

export const ContinueSchema = named(
  'Continue',
  z.strictObject({ kind: z.literal('Continue'), id: NodeIdSchema, ...meta() }),
);

export const ExprStmtSchema = named(
  'ExprStmt',
  z.strictObject({ kind: z.literal('ExprStmt'), id: NodeIdSchema, expr: ExprSchema, ...meta() }),
);

export const IntentStmtSchema = named(
  'IntentStmt',
  z.strictObject({ kind: z.literal('IntentStmt'), id: NodeIdSchema, text: TextSchema, ...meta() }),
);

export const StmtSchema: z.ZodType<Stmt> = named(
  'Stmt',
  z.discriminatedUnion('kind', [
    FunctionDefSchema,
    ForEachSchema,
    ForRangeSchema,
    WhileSchema,
    IfSchema,
    AssignSchema,
    UpdateSchema,
    ReturnSchema,
    BreakSchema,
    ContinueSchema,
    ExprStmtSchema,
    IntentStmtSchema,
    BlockHoleSchema,
  ]),
);

export const ProgramSchema = named(
  'Program',
  z.strictObject({
    kind: z.literal('Program'),
    id: NodeIdSchema,
    body: z.array(StmtSchema),
    ...meta(),
  }),
);

export const IrDocumentSchema: z.ZodType<IrDocument> = named(
  'IrDocument',
  z.strictObject({
    schemaVersion: z.literal(IR_SCHEMA_VERSION),
    nextId: z.number().int().min(1),
    program: ProgramSchema,
  }),
);

/** One schema per node kind, for validating a single node. */
export const NODE_SCHEMAS = {
  Program: ProgramSchema,
  Block: BlockSchema,
  FunctionDef: FunctionDefSchema,
  ForEach: ForEachSchema,
  ForRange: ForRangeSchema,
  While: WhileSchema,
  If: IfSchema,
  Elif: ElifSchema,
  Assign: AssignSchema,
  Update: UpdateSchema,
  Return: ReturnSchema,
  Break: BreakSchema,
  Continue: ContinueSchema,
  ExprStmt: ExprStmtSchema,
  IntentStmt: IntentStmtSchema,
  BlockHole: BlockHoleSchema,
  Name: NameSchema,
  Literal: LiteralSchema,
  InfinityLiteral: InfinityLiteralSchema,
  UnaryOp: UnaryOpSchema,
  BinOp: BinOpSchema,
  Compare: CompareSchema,
  BoolOp: BoolOpSchema,
  Membership: MembershipSchema,
  Call: CallSchema,
  Index: IndexSchema,
  Slice: SliceSchema,
  Attribute: AttributeSchema,
  CollectionLiteral: CollectionLiteralSchema,
  DictLiteral: DictLiteralSchema,
  DictEntry: DictEntrySchema,
  ExprHole: ExprHoleSchema,
  CondHole: CondHoleSchema,
  NameHole: NameHoleSchema,
  RefHole: RefHoleSchema,
} as const;

/**
 * JSON Schema (draft 2020-12) for an `IrDocument`. Shared node shapes are
 * emitted once under `$defs`, named after their kind.
 */
export function irDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(IrDocumentSchema, { metadata: registry, reused: 'ref' });
}
