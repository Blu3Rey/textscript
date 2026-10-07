// Applies an edit batch to a document: atomically, without mutating its
// input, and returning the batch that undoes it (docs/adr/008).

import { createIdAllocator } from '../ir/ids';
import { IDENTIFIER_PATTERN, NODE_SCHEMAS, ProgramSchema } from '../ir/schema';
import { parseDocument, zodIssueMessages } from '../ir/serialize';
import { buildSymbolTable, symbolAt } from '../ir/symbols';
import {
  CHILD_FIELDS,
  allNodes,
  isIrNode,
  isOptionalChildField,
  pathTo,
  type Position,
} from '../ir/tree';
import type {
  Block,
  BlockHole,
  IrDocument,
  IrNode,
  NodeId,
  NodeKind,
  NoteTag,
  Span,
  Stmt,
} from '../ir/types';
import { EditBatchSchema, EditOpSchema } from './schema';
import { resolveTempIds } from './temp-ids';
import { OpError, Transaction, isListField, isReplaceable, toJson } from './transaction';
import type {
  ApplyResult,
  Clarification,
  EditBatch,
  EditOp,
  FillHoleOp,
  InsertPosition,
  ReplaceableNode,
} from './types';

/** Reasons given to holes the applier creates when something is removed. */
export const HOLE_REASONS = {
  block: 'body not described',
  condition: 'condition not described',
  name: 'name not given',
  value: 'value not described',
} as const;

const STATEMENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'FunctionDef',
  'ForEach',
  'ForRange',
  'While',
  'If',
  'Assign',
  'Update',
  'Return',
  'Break',
  'Continue',
  'ExprStmt',
  'IntentStmt',
  'BlockHole',
]);

const HOLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'BlockHole',
  'CondHole',
  'ExprHole',
  'NameHole',
  'RefHole',
]);

/** Compound statements `wrap_nodes` can put statements into. */
const WRAPPER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'If',
  'While',
  'ForEach',
  'ForRange',
  'FunctionDef',
]);

/**
 * Steps inverse batches are made of. They may pass through malformed
 * states, so the program is only checked after the other operations.
 */
const PRIMITIVE_OPS: ReadonlySet<EditOp['op']> = new Set([
  'insert_at',
  'delete_child',
  'swap_node',
  'set_field',
]);

/** Metadata has its own operations, so `update_field` leaves it alone. */
const METADATA_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'id',
  'provenance',
  'inferred',
  'label',
  'notes',
]);

/** Fields where a removed node leaves a `NameHole`. */
const BINDING_FIELDS: ReadonlySet<string> = new Set(['target', 'name']);

function isStmt(node: IrNode): node is Stmt {
  return STATEMENT_KINDS.has(node.kind);
}

/** The field holding statements in a program or block. */
function statementField(node: IrNode): 'body' | 'stmts' | undefined {
  if (node.kind === 'Program') return 'body';
  if (node.kind === 'Block') return 'stmts';
  return undefined;
}

function statementsOf(node: IrNode): readonly Stmt[] {
  if (node.kind === 'Program') return node.body;
  if (node.kind === 'Block') return node.stmts;
  return [];
}

/** True when `position` is a slot in a program body or block. */
function isStatementSlot(position: Position | undefined): position is Position {
  return position?.index !== undefined && statementField(position.parent) === position.field;
}

interface PlacedStatement {
  node: Stmt;
  position: Position;
}

function sameSpan(a: Span, b: Span): boolean {
  return a.utteranceId === b.utteranceId && a.start === b.start && a.end === b.end;
}

function fieldsOf(kind: NodeKind): readonly string[] {
  return Object.keys(NODE_SCHEMAS[kind].shape);
}

/** Runs the operations of one batch inside a transaction. */
class Executor {
  readonly tx: Transaction;
  readonly clarifications: Clarification[] = [];

  constructor(tx: Transaction) {
    this.tx = tx;
  }

  run(op: EditOp): void {
    const provenance = op.provenance ?? [];
    switch (op.op) {
      case 'add_stmt':
        this.insertStatement(op.parent, op.position, op.stmt);
        return;
      case 'fill_hole':
        this.fillHole(op.hole, op.value);
        return;
      case 'update_field':
        this.updateField(op.node, op.field, op.value, provenance);
        return;
      case 'replace_node':
        this.tx.replace(op.node, op.replacement);
        return;
      case 'remove_node':
        this.remove(op.node, provenance);
        return;
      case 'move_node':
        this.move(op.node, op.parent, op.position, provenance);
        return;
      case 'wrap_nodes':
        this.wrap(op.nodes, op.wrapper);
        return;
      case 'rename_symbol':
        this.rename(op.node, op.name, provenance);
        return;
      case 'set_label':
        this.setLabel(op.node, op.label);
        return;
      case 'add_note':
        this.addNote(op.node, op.text, op.tag, provenance);
        return;
      case 'remove_note':
        this.removeNote(op.note);
        return;
      case 'ask_clarification':
        for (const candidate of op.candidates) this.tx.locate(candidate);
        this.clarifications.push({ question: op.question, candidates: op.candidates });
        return;
      case 'insert_at':
        this.tx.insertAt(op.parent, op.field, op.index, op.node);
        return;
      case 'delete_child':
        this.tx.deleteChild(op.node);
        return;
      case 'swap_node':
        this.tx.replace(op.node, op.replacement);
        return;
      case 'set_field':
        this.tx.setField(op.node, op.field, op.value);
        return;
    }
  }

  // Statements in lists --------------------------------------------------------

  /** Finds a statement that sits directly in a block or the program body. */
  statementAt(id: NodeId): PlacedStatement {
    const { node, position } = this.tx.locate(id);
    if (position === undefined) throw new OpError('root', 'The program is not a statement');
    if (!isStmt(node) || !isStatementSlot(position)) {
      throw new OpError('not-a-statement', `${node.kind} ${id} is not a statement in a block`);
    }
    return { node, position };
  }

  /** The list index a position refers to, checking its anchor. */
  resolveIndex(parentId: NodeId, statements: readonly Stmt[], position: InsertPosition): number {
    if ('at' in position) return position.at === 'start' ? 0 : statements.length;
    const anchor = 'before' in position ? position.before : position.after;
    const index = statements.findIndex((stmt) => stmt.id === anchor);
    if (index === -1) {
      throw new OpError('invalid-anchor', `${anchor} is not a statement directly in ${parentId}`);
    }
    return 'before' in position ? index : index + 1;
  }

  /** Adds a statement; in a block that only holds a hole, the statement fills it. */
  insertStatement(parentId: NodeId, position: InsertPosition, stmt: Stmt): void {
    const { node: parent } = this.tx.locate(parentId);
    const field = statementField(parent);
    if (field === undefined) {
      throw new OpError('invalid-parent', `${parent.kind} ${parentId} can't hold statements`);
    }
    const statements = statementsOf(parent);
    const index = this.resolveIndex(parentId, statements, position);
    const [only] = statements;
    if (only?.kind === 'BlockHole' && statements.length === 1) this.tx.replace(only.id, stmt);
    else this.tx.insertAt(parentId, field, index, stmt);
  }

  /** Removes a statement; a block left empty gets a `BlockHole`. */
  removeStatement(id: NodeId, provenance: Span[]): void {
    const { position } = this.tx.locate(id);
    this.tx.deleteChild(id);
    if (position?.parent.kind !== 'Block') return;
    const block = this.tx.locate(position.parent.id).node;
    if (statementsOf(block).length === 0) {
      this.tx.insertAt(block.id, 'stmts', 0, this.blockHole(provenance));
    }
  }

  blockHole(provenance: Span[]): BlockHole {
    return {
      kind: 'BlockHole',
      id: this.tx.ids.allocate(),
      reason: HOLE_REASONS.block,
      provenance,
    };
  }

  /** The hole that takes a removed node's place in a required field. */
  holeFor(node: IrNode, field: string, provenance: Span[]): ReplaceableNode {
    if (node.kind === 'Block') {
      const id = this.tx.ids.allocate();
      const block: Block = {
        kind: 'Block',
        id,
        stmts: [this.blockHole(provenance)],
        provenance: [],
      };
      return block;
    }
    const id = this.tx.ids.allocate();
    if (field === 'cond')
      return { kind: 'CondHole', id, reason: HOLE_REASONS.condition, provenance };
    if (BINDING_FIELDS.has(field))
      return { kind: 'NameHole', id, reason: HOLE_REASONS.name, provenance };
    return { kind: 'ExprHole', id, reason: HOLE_REASONS.value, provenance };
  }

  // Operations -------------------------------------------------------------------

  fillHole(holeId: NodeId, value: FillHoleOp['value']): void {
    const { node, position } = this.tx.locate(holeId);
    if (!HOLE_KINDS.has(node.kind))
      throw new OpError('not-a-hole', `${node.kind} ${holeId} is not a hole`);
    if (node.kind === 'BlockHole') {
      if (!Array.isArray(value)) {
        throw new OpError('invalid-value', `BlockHole ${holeId} must be filled with statements`);
      }
      if (position?.index === undefined) {
        throw new OpError('invalid-parent', `BlockHole ${holeId} is not in a block`);
      }
      const [first, ...rest] = value;
      if (first === undefined)
        throw new OpError('invalid-value', 'No statements to fill the hole with');
      this.tx.replace(holeId, first);
      rest.forEach((stmt, i) => {
        this.tx.insertAt(position.parent.id, position.field, (position.index ?? 0) + 1 + i, stmt);
      });
      return;
    }
    if (Array.isArray(value)) {
      throw new OpError(
        'invalid-value',
        `${node.kind} ${holeId} must be filled with an expression`,
      );
    }
    this.tx.replace(holeId, value);
  }

  updateField(id: NodeId, field: string, value: unknown, provenance: Span[]): void {
    const { node } = this.tx.locate(id);
    if (METADATA_FIELDS.has(field) || !fieldsOf(node.kind).includes(field)) {
      throw new OpError(
        'invalid-field',
        `${node.kind} has no field "${field}" that update_field can change`,
      );
    }
    if (isListField(node, field)) {
      throw new OpError(
        'invalid-field',
        `"${field}" is a list; add, remove or move its items instead`,
      );
    }
    const childFields: readonly string[] = CHILD_FIELDS[node.kind];
    if (childFields.includes(field)) {
      if (!isIrNode(value) || !isReplaceable(value)) {
        throw new OpError('invalid-value', `"${field}" of ${node.kind} must be set to a node`);
      }
      const current: unknown = Reflect.get(node, field);
      if (isIrNode(current)) this.tx.replace(current.id, value);
      else this.tx.setField(id, field, toJson(value));
    } else {
      this.tx.setField(id, field, toJson(value));
    }
    this.addProvenance(id, provenance);
  }

  /** Adds spans to a node's provenance, skipping ones it already has. */
  addProvenance(id: NodeId, spans: readonly Span[]): void {
    const { node } = this.tx.locate(id);
    const added = spans.filter((span) => !node.provenance.some((own) => sameSpan(own, span)));
    if (added.length > 0)
      this.tx.setField(id, 'provenance', toJson([...node.provenance, ...added]));
  }

  remove(id: NodeId, provenance: Span[]): void {
    const { node, position } = this.tx.locate(id);
    if (position === undefined) throw new OpError('root', 'The program cannot be removed');
    if (position.index !== undefined) {
      if (isStmt(node) && isStatementSlot(position)) this.removeStatement(id, provenance);
      else this.tx.deleteChild(id);
    } else if (isOptionalChildField(position.parent.kind, position.field)) {
      this.tx.setField(position.parent.id, position.field, undefined);
    } else {
      this.tx.replace(id, this.holeFor(node, position.field, provenance));
    }
  }

  move(id: NodeId, parentId: NodeId, position: InsertPosition, provenance: Span[]): void {
    const { node } = this.statementAt(id);
    if (node.kind === 'BlockHole')
      throw new OpError('not-a-statement', `BlockHole ${id} can't move`);
    const { node: target } = this.tx.locate(parentId);
    if (statementField(target) === undefined) {
      throw new OpError('invalid-parent', `${target.kind} ${parentId} can't hold statements`);
    }
    if (pathTo(this.tx.program, parentId)?.some((ancestor) => ancestor.id === id)) {
      throw new OpError('move-into-self', `${id} can't move into itself or its own block`);
    }
    if (
      ('before' in position && position.before === id) ||
      ('after' in position && position.after === id)
    ) {
      throw new OpError('invalid-anchor', `${id} can't be positioned relative to itself`);
    }
    this.removeStatement(id, provenance);
    this.insertStatement(parentId, position, node);
  }

  wrap(ids: readonly NodeId[], wrapper: Stmt): void {
    if (!WRAPPER_KINDS.has(wrapper.kind) || !('body' in wrapper)) {
      throw new OpError('invalid-wrapper', `A ${wrapper.kind} can't wrap statements`);
    }
    const body: Block = wrapper.body;
    const [hole] = body.stmts;
    if (hole?.kind !== 'BlockHole' || body.stmts.length !== 1) {
      throw new OpError('invalid-wrapper', "The wrapper's body must be a single BlockHole");
    }
    if (new Set(ids).size !== ids.length)
      throw new OpError('invalid-value', 'A node is listed twice');

    const entries = ids.map((id) => this.statementAt(id));
    const [firstEntry] = entries;
    if (firstEntry === undefined) throw new OpError('invalid-value', 'Nothing to wrap');
    const parent = firstEntry.position.parent;
    if (entries.some((e) => e.position.parent.id !== parent.id)) {
      throw new OpError('not-siblings', 'Statements to wrap must be in the same block');
    }
    const sorted = entries.toSorted((a, b) => (a.position.index ?? 0) - (b.position.index ?? 0));
    const start = sorted[0]?.position.index ?? 0;
    if (sorted.some((e, i) => e.position.index !== start + i)) {
      throw new OpError('not-adjacent', 'Statements to wrap must be next to each other');
    }

    for (const entry of sorted.toReversed()) this.tx.deleteChild(entry.node.id);
    this.tx.insertAt(parent.id, firstEntry.position.field, start, wrapper);
    sorted.forEach((entry, i) => {
      if (i === 0) this.tx.replace(hole.id, entry.node);
      else this.tx.insertAt(body.id, 'stmts', i, entry.node);
    });
  }

  rename(id: NodeId, name: string, provenance: Span[]): void {
    const { node } = this.tx.locate(id);
    if (node.kind !== 'Name') throw new OpError('not-a-name', `${node.kind} ${id} is not a name`);
    if (!IDENTIFIER_PATTERN.test(name))
      throw new OpError('invalid-name', `"${name}" is not a valid name`);
    const table = buildSymbolTable(this.tx.program);
    const symbol = symbolAt(table, id);
    const targets = symbol
      ? [...symbol.definitions, ...symbol.uses].map((occurrence) => occurrence.nodeId)
      : table.references
          .filter((ref) => ref.resolution.kind !== 'symbol' && ref.name === node.name)
          .map((ref) => ref.nodeId);
    for (const target of targets) {
      this.tx.setField(target, 'name', name);
      this.addProvenance(target, provenance);
    }
  }

  setLabel(id: NodeId, label: string | undefined): void {
    this.tx.locate(id);
    if (
      label !== undefined &&
      allNodes(this.tx.program).some((n) => n.id !== id && n.label === label)
    ) {
      throw new OpError('duplicate-label', `Another node is already labeled "${label}"`);
    }
    this.tx.setField(id, 'label', label);
  }

  addNote(id: NodeId, text: string, tag: NoteTag, provenance: Span[]): void {
    if (provenance.length === 0) throw new OpError('missing-provenance', 'A note needs provenance');
    const { node } = this.tx.locate(id);
    const note = { id: this.tx.ids.allocate(), text, tag, provenance };
    this.tx.setField(id, 'notes', toJson([...(node.notes ?? []), note]));
  }

  removeNote(noteId: NodeId): void {
    const holder = allNodes(this.tx.program).find((n) =>
      n.notes?.some((note) => note.id === noteId),
    );
    if (holder === undefined) throw new OpError('unknown-note', `No note with ID ${noteId}`);
    const remaining = (holder.notes ?? []).filter((note) => note.id !== noteId);
    this.tx.setField(holder.id, 'notes', remaining.length > 0 ? toJson(remaining) : undefined);
  }
}

/**
 * Applies a batch atomically. On success, returns the new document (in
 * canonical form), the inverse batch and any clarification questions. On
 * failure, returns what went wrong and which op caused it; `document` is
 * never modified either way.
 */
export function apply(document: IrDocument, batch: EditBatch): ApplyResult {
  // Shapes first: temporary IDs are valid IDs to the schema.
  const parsed = EditBatchSchema.safeParse(batch);
  if (!parsed.success) {
    const issues = zodIssueMessages(parsed.error);
    return {
      ok: false,
      error: { code: 'invalid-batch', message: 'The batch is malformed', issues },
    };
  }

  const ids = createIdAllocator(document.nextId);
  const assigned = new Map<string, string>();
  const executor = new Executor(new Transaction(document, ids));
  for (const [opIndex, raw] of parsed.data.ops.entries()) {
    // Temporary IDs are resolved op by op, so an op's IDs (and those of the
    // holes and notes it creates) don't change when later ops are added.
    const resolved = resolveTempIds(raw, ids, assigned);
    if (!resolved.ok) {
      return { ok: false, error: { code: 'invalid-temp-id', message: resolved.message, opIndex } };
    }
    const op = EditOpSchema.parse(resolved.value);
    try {
      executor.run(op);
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      return { ok: false, error: { code: error.code, message: error.message, opIndex } };
    }
    // Every operation but a primitive must leave a well-formed program. That
    // pins errors to the op that caused them, and means everything the
    // inverse captures is well-formed too.
    if (!PRIMITIVE_OPS.has(op.op)) {
      const shaped = ProgramSchema.safeParse(executor.tx.program);
      if (!shaped.success) {
        return {
          ok: false,
          error: {
            code: 'invalid-result',
            message: `Op ${String(opIndex)} (${op.op}) leaves the program malformed`,
            opIndex,
            issues: zodIssueMessages(shaped.error),
          },
        };
      }
    }
  }

  const checked = parseDocument({ ...executor.tx.document, nextId: ids.next });
  if (!checked.ok) {
    return {
      ok: false,
      error: {
        code: 'invalid-result',
        message: 'The batch leaves the document invalid',
        issues: checked.issues,
      },
    };
  }
  return {
    ok: true,
    document: checked.document,
    inverse: { utteranceId: batch.utteranceId, ops: executor.tx.inverse() },
    clarifications: executor.clarifications,
  };
}
