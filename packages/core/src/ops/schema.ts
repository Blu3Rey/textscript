// Zod schemas for edit operations, mirroring `types.ts`. Node payloads reuse
// the IR schemas, so a batch is checked as thoroughly as a document. The
// translator (S7) uses `editBatchJsonSchema()` for structured outputs.

import { z } from 'zod';
import {
  BlockSchema,
  DictEntrySchema,
  ElifSchema,
  ExprSchema,
  NodeIdSchema,
  SpanSchema,
  StmtSchema,
  TextSchema,
  named,
  schemaRegistry,
} from '../ir/schema';
import type { EditBatch, EditOp, JsonValue } from './types';

const JsonValueSchema: z.ZodType<JsonValue> = named('JsonValue', z.json());

const InsertPositionSchema = named(
  'InsertPosition',
  z.union([
    z.strictObject({ at: z.enum(['start', 'end']) }),
    z.strictObject({ before: NodeIdSchema }),
    z.strictObject({ after: NodeIdSchema }),
  ]),
);

const ReplaceableNodeSchema = named(
  'ReplaceableNode',
  z.union([StmtSchema, ExprSchema, BlockSchema, ElifSchema, DictEntrySchema]),
);

const ListNodeSchema = named(
  'ListNode',
  z.union([StmtSchema, ExprSchema, ElifSchema, DictEntrySchema]),
);

/** Spread last into every op so the op's own fields come first. */
function base() {
  return { provenance: z.array(SpanSchema).exactOptional() };
}

export const AddStmtOpSchema = named(
  'AddStmtOp',
  z.strictObject({
    op: z.literal('add_stmt'),
    parent: NodeIdSchema,
    position: InsertPositionSchema,
    stmt: StmtSchema,
    ...base(),
  }),
);

export const FillHoleOpSchema = named(
  'FillHoleOp',
  z.strictObject({
    op: z.literal('fill_hole'),
    hole: NodeIdSchema,
    value: z.union([ExprSchema, z.array(StmtSchema).min(1)]),
    ...base(),
  }),
);

export const UpdateFieldOpSchema = named(
  'UpdateFieldOp',
  z.strictObject({
    op: z.literal('update_field'),
    node: NodeIdSchema,
    field: TextSchema,
    value: z.union([ReplaceableNodeSchema, JsonValueSchema]),
    ...base(),
  }),
);

export const ReplaceNodeOpSchema = named(
  'ReplaceNodeOp',
  z.strictObject({
    op: z.literal('replace_node'),
    node: NodeIdSchema,
    replacement: ReplaceableNodeSchema,
    ...base(),
  }),
);

export const RemoveNodeOpSchema = named(
  'RemoveNodeOp',
  z.strictObject({ op: z.literal('remove_node'), node: NodeIdSchema, ...base() }),
);

export const MoveNodeOpSchema = named(
  'MoveNodeOp',
  z.strictObject({
    op: z.literal('move_node'),
    node: NodeIdSchema,
    parent: NodeIdSchema,
    position: InsertPositionSchema,
    ...base(),
  }),
);

export const WrapNodesOpSchema = named(
  'WrapNodesOp',
  z.strictObject({
    op: z.literal('wrap_nodes'),
    nodes: z.array(NodeIdSchema).min(1),
    wrapper: StmtSchema,
    ...base(),
  }),
);

export const RenameSymbolOpSchema = named(
  'RenameSymbolOp',
  z.strictObject({
    op: z.literal('rename_symbol'),
    node: NodeIdSchema,
    name: TextSchema,
    ...base(),
  }),
);

export const SetLabelOpSchema = named(
  'SetLabelOp',
  z.strictObject({
    op: z.literal('set_label'),
    node: NodeIdSchema,
    label: TextSchema.exactOptional(),
    ...base(),
  }),
);

export const AddNoteOpSchema = named(
  'AddNoteOp',
  z.strictObject({
    op: z.literal('add_note'),
    node: NodeIdSchema,
    text: TextSchema,
    tag: z.enum(['general', 'edge-case', 'complexity']),
    ...base(),
  }),
);

export const RemoveNoteOpSchema = named(
  'RemoveNoteOp',
  z.strictObject({ op: z.literal('remove_note'), note: NodeIdSchema, ...base() }),
);

export const AskClarificationOpSchema = named(
  'AskClarificationOp',
  z.strictObject({
    op: z.literal('ask_clarification'),
    question: TextSchema,
    candidates: z.array(NodeIdSchema),
    ...base(),
  }),
);

export const InsertAtOpSchema = named(
  'InsertAtOp',
  z.strictObject({
    op: z.literal('insert_at'),
    parent: NodeIdSchema,
    field: TextSchema,
    index: z.number().int().min(0),
    node: ListNodeSchema,
    ...base(),
  }),
);

export const DeleteChildOpSchema = named(
  'DeleteChildOp',
  z.strictObject({ op: z.literal('delete_child'), node: NodeIdSchema, ...base() }),
);

export const SwapNodeOpSchema = named(
  'SwapNodeOp',
  z.strictObject({
    op: z.literal('swap_node'),
    node: NodeIdSchema,
    replacement: ReplaceableNodeSchema,
    ...base(),
  }),
);

export const SetFieldOpSchema = named(
  'SetFieldOp',
  z.strictObject({
    op: z.literal('set_field'),
    node: NodeIdSchema,
    field: TextSchema,
    value: JsonValueSchema.exactOptional(),
    ...base(),
  }),
);

export const EditOpSchema: z.ZodType<EditOp> = named(
  'EditOp',
  z.discriminatedUnion('op', [
    AddStmtOpSchema,
    FillHoleOpSchema,
    UpdateFieldOpSchema,
    ReplaceNodeOpSchema,
    RemoveNodeOpSchema,
    MoveNodeOpSchema,
    WrapNodesOpSchema,
    RenameSymbolOpSchema,
    SetLabelOpSchema,
    AddNoteOpSchema,
    RemoveNoteOpSchema,
    AskClarificationOpSchema,
    InsertAtOpSchema,
    DeleteChildOpSchema,
    SwapNodeOpSchema,
    SetFieldOpSchema,
  ]),
);

export const EditBatchSchema: z.ZodType<EditBatch> = named(
  'EditBatch',
  z.strictObject({ utteranceId: TextSchema, ops: z.array(EditOpSchema) }),
);

/** One schema per op kind. */
export const OP_SCHEMAS = {
  add_stmt: AddStmtOpSchema,
  fill_hole: FillHoleOpSchema,
  update_field: UpdateFieldOpSchema,
  replace_node: ReplaceNodeOpSchema,
  remove_node: RemoveNodeOpSchema,
  move_node: MoveNodeOpSchema,
  wrap_nodes: WrapNodesOpSchema,
  rename_symbol: RenameSymbolOpSchema,
  set_label: SetLabelOpSchema,
  add_note: AddNoteOpSchema,
  remove_note: RemoveNoteOpSchema,
  ask_clarification: AskClarificationOpSchema,
  insert_at: InsertAtOpSchema,
  delete_child: DeleteChildOpSchema,
  swap_node: SwapNodeOpSchema,
  set_field: SetFieldOpSchema,
} as const;

/** JSON Schema (draft 2020-12) for an `EditBatch`, with named `$defs`. */
export function editBatchJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EditBatchSchema, { metadata: schemaRegistry, reused: 'ref' });
}
