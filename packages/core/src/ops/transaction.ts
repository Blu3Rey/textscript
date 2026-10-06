// The four primitive steps every edit operation is made of. Each records
// its exact inverse as it runs, so a batch's inverse is its primitives'
// inverses in reverse order.
//
// Intermediate states may be invalid (a block can be empty between a delete
// and an insert); the applier validates once, after the whole batch.

import { createIdAllocator, type IdAllocator } from '../ir/ids';
import { CHILD_FIELDS, indexTree, isIrNode, updateNode, type IndexEntry } from '../ir/tree';
import type { IrDocument, IrNode, NodeId, Program } from '../ir/types';
import type { ApplyErrorCode, JsonValue, ListNode, PrimitiveOp, ReplaceableNode } from './types';

/** Thrown by a step that can't run; the applier turns it into an `ApplyError`. */
export class OpError extends Error {
  readonly code: ApplyErrorCode;

  constructor(code: ApplyErrorCode, message: string) {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}

/** Fields no operation may set directly. */
const FIXED_FIELDS: ReadonlySet<string> = new Set(['kind', 'id']);

export function isListField(node: IrNode, field: string): boolean {
  const childFields: readonly string[] = CHILD_FIELDS[node.kind];
  return childFields.includes(field) && Array.isArray(Reflect.get(node, field));
}

/** A copy of `node` with `field` set. */
function withField<N extends IrNode>(node: N, field: string, value: unknown): N {
  return Object.assign({}, node, { [field]: value });
}

/** A copy of `node` without `field`. */
function withoutField<N extends IrNode>(node: N, field: string): N {
  const copy = Object.assign({}, node);
  Reflect.deleteProperty(copy, field);
  return copy;
}

function listOf(node: IrNode, field: string): readonly IrNode[] {
  const value: unknown = Reflect.get(node, field);
  return Array.isArray(value) ? (value as readonly unknown[]).filter(isIrNode) : [];
}

export class Transaction {
  document: IrDocument;
  readonly ids: IdAllocator;
  /** Inverses of the steps taken so far, in the order they were taken. */
  readonly #undo: PrimitiveOp[] = [];

  constructor(document: IrDocument, ids: IdAllocator = createIdAllocator(document.nextId)) {
    this.document = document;
    this.ids = ids;
  }

  /** The inverse of everything done so far, ready to apply. */
  inverse(): PrimitiveOp[] {
    return [...this.#undo].reverse();
  }

  get program(): Program {
    return this.document.program;
  }

  locate(id: NodeId): IndexEntry {
    const entry = indexTree(this.program).get(id);
    if (entry === undefined) throw new OpError('unknown-node', `No node with ID ${id}`);
    return entry;
  }

  /** Inserts `node` into the list `field` of `parentId` at `index`. */
  insertAt(parentId: NodeId, field: string, index: number, node: ListNode): void {
    const { node: parent } = this.locate(parentId);
    if (!isListField(parent, field)) {
      throw new OpError('invalid-field', `${parent.kind} ${parentId} has no list field "${field}"`);
    }
    const list = listOf(parent, field);
    if (!Number.isInteger(index) || index < 0 || index > list.length) {
      throw new OpError('invalid-index', `Index ${String(index)} is outside ${parentId}.${field}`);
    }
    this.#update(parentId, (p) => withField(p, field, list.toSpliced(index, 0, node)));
    this.#undo.push({ op: 'delete_child', node: node.id });
  }

  /** Deletes a node from the list it's in. Adds no holes. */
  deleteChild(id: NodeId): void {
    const { node, position } = this.locate(id);
    if (position === undefined) throw new OpError('root', 'The program cannot be deleted');
    if (position.index === undefined) {
      throw new OpError(
        'not-in-list',
        `${node.kind} ${id} is in ${position.field}, which is not a list`,
      );
    }
    if (!isListNode(node))
      throw new OpError('not-in-list', `${node.kind} ${id} can't be re-inserted`);
    const { parent, field, index } = position;
    this.#update(parent.id, (p) => withField(p, field, listOf(p, field).toSpliced(index, 1)));
    this.#undo.push({ op: 'insert_at', parent: parent.id, field, index, node });
  }

  /** Replaces a node wherever it is. */
  replace(id: NodeId, replacement: ReplaceableNode): void {
    const { node, position } = this.locate(id);
    if (position === undefined) throw new OpError('root', 'The program cannot be replaced');
    if (!isReplaceable(node)) throw new OpError('root', `${node.kind} ${id} cannot be replaced`);
    this.#update(id, () => replacement);
    this.#undo.push({ op: 'swap_node', node: replacement.id, replacement: node });
  }

  /** Sets a field that isn't a list of children, or clears it when `value` is undefined. */
  setField(id: NodeId, field: string, value: JsonValue | undefined): void {
    if (FIXED_FIELDS.has(field)) throw new OpError('invalid-field', `"${field}" cannot be changed`);
    const { node } = this.locate(id);
    if (isListField(node, field)) {
      throw new OpError('invalid-field', `"${field}" is a list; add or remove its items instead`);
    }
    const had = Object.hasOwn(node, field);
    const old: unknown = Reflect.get(node, field);
    this.#update(id, (n) =>
      value === undefined ? withoutField(n, field) : withField(n, field, value),
    );
    this.#undo.push(
      had
        ? { op: 'set_field', node: id, field, value: toJson(old) }
        : { op: 'set_field', node: id, field },
    );
  }

  #update(id: NodeId, change: (node: IrNode) => IrNode): void {
    if (id === this.program.id) {
      const next = change(this.program);
      if (next.kind !== 'Program') throw new OpError('root', 'The program must stay a Program');
      this.document = { ...this.document, program: next };
    } else {
      this.document = { ...this.document, program: updateNode(this.program, id, change) };
    }
  }
}

function isListNode(node: IrNode): node is ListNode {
  return node.kind !== 'Program' && node.kind !== 'Block';
}

export function isReplaceable(node: IrNode): node is ReplaceableNode {
  return node.kind !== 'Program';
}

/**
 * IR values are JSON already; this narrows the type so inverse ops can carry
 * them. Anything else would be a bug, so it throws.
 */
export function toJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return (value as readonly unknown[]).map(toJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
  }
  throw new Error(`Not a JSON value: a ${typeof value}`);
}
