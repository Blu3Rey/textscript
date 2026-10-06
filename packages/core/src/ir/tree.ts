// Generic traversal and immutable update for IR trees.
//
// Every utility is driven by CHILD_FIELDS, the list of node-valued fields of
// each kind, in source order. Holes are ordinary nodes, so they're visited
// like everything else.

import type { IrNode, NodeId, NodeKind, NodeOfKind } from './types';

/** The fields of `N` that hold a child node or a list of child nodes. */
export type ChildFieldOf<N> = {
  [F in keyof N]-?: NonNullable<N[F]> extends IrNode | readonly IrNode[] ? F : never;
}[keyof N];

/** Child fields of every node kind, in the order they appear in source. */
export const CHILD_FIELDS = {
  Program: ['body'],
  Block: ['stmts'],
  FunctionDef: ['name', 'params', 'body'],
  ForEach: ['target', 'iterable', 'body'],
  ForRange: ['target', 'start', 'stop', 'step', 'body'],
  While: ['cond', 'body'],
  If: ['cond', 'body', 'elifs', 'orelse'],
  Elif: ['cond', 'body'],
  Assign: ['target', 'value'],
  Update: ['target', 'value'],
  Return: ['value'],
  Break: [],
  Continue: [],
  ExprStmt: ['expr'],
  IntentStmt: [],
  BlockHole: [],
  Name: [],
  Literal: [],
  InfinityLiteral: [],
  UnaryOp: ['operand'],
  BinOp: ['left', 'right'],
  Compare: ['left', 'right'],
  BoolOp: ['operands'],
  Membership: ['element', 'container'],
  Call: ['callee', 'args'],
  Index: ['object', 'index'],
  Slice: ['object', 'start', 'stop', 'step'],
  Attribute: ['object'],
  CollectionLiteral: ['elements'],
  DictLiteral: ['entries'],
  DictEntry: ['key', 'value'],
  ExprHole: [],
  CondHole: [],
  NameHole: [],
  RefHole: [],
} as const satisfies { readonly [K in NodeKind]: readonly ChildFieldOf<NodeOfKind<K>>[] };

/** The child fields of `N` that may be absent. */
export type OptionalChildFieldOf<N> = {
  [F in ChildFieldOf<N>]-?: undefined extends N[F] ? F : never;
}[ChildFieldOf<N>];

/**
 * Child fields that may be absent, per kind. Removing the node in such a
 * field leaves the field empty; removing one in a required field leaves a
 * hole instead.
 */
export const OPTIONAL_CHILD_FIELDS = {
  ForRange: ['start', 'step'],
  If: ['orelse'],
  Return: ['value'],
  Slice: ['start', 'stop', 'step'],
} as const satisfies { readonly [K in NodeKind]?: readonly OptionalChildFieldOf<NodeOfKind<K>>[] };

const optionalChildFields: Partial<Record<NodeKind, readonly string[]>> = OPTIONAL_CHILD_FIELDS;

export function isOptionalChildField(kind: NodeKind, field: string): boolean {
  return optionalChildFields[kind]?.includes(field) ?? false;
}

export function isNodeKind(value: string): value is NodeKind {
  return Object.hasOwn(CHILD_FIELDS, value);
}

export const NODE_KINDS: readonly NodeKind[] = Object.keys(CHILD_FIELDS).filter(isNodeKind);

/** True for any object with a known node `kind`. Doesn't validate the rest. */
export function isIrNode(value: unknown): value is IrNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    isNodeKind(value.kind)
  );
}

/** Where a node sits in its parent. `index` is set for list fields. */
export interface Position {
  parent: IrNode;
  field: string;
  index?: number;
}

export interface ChildSlot extends Omit<Position, 'parent'> {
  node: IrNode;
}

/** The direct children of a node, in source order. */
export function children(node: IrNode): ChildSlot[] {
  const slots: ChildSlot[] = [];
  for (const field of CHILD_FIELDS[node.kind]) {
    const value: unknown = Reflect.get(node, field);
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      items.forEach((item, index) => {
        if (isIrNode(item)) slots.push({ node: item, field, index });
      });
    } else if (isIrNode(value)) {
      slots.push({ node: value, field });
    }
  }
  return slots;
}

export interface WalkContext {
  /** `undefined` for the root. */
  position?: Position;
  depth: number;
}

/**
 * Visits every node depth-first in source order. Return `false` from the
 * visitor to skip a node's children.
 */
export function walk(root: IrNode, visit: (node: IrNode, context: WalkContext) => unknown) {
  const step = (node: IrNode, context: WalkContext) => {
    if (visit(node, context) === false) return;
    for (const slot of children(node)) {
      step(slot.node, {
        position: {
          parent: node,
          field: slot.field,
          ...(slot.index === undefined ? {} : { index: slot.index }),
        },
        depth: context.depth + 1,
      });
    }
  };
  step(root, { depth: 0 });
}

/** Every node depth-first in source order, root first. */
export function allNodes(root: IrNode): IrNode[] {
  const nodes: IrNode[] = [];
  walk(root, (node) => {
    nodes.push(node);
  });
  return nodes;
}

export interface IndexEntry {
  node: IrNode;
  /** `undefined` for the root. */
  position?: Position;
}

/**
 * Maps every node ID to its node and position. If IDs repeat (an invalid
 * tree) the first occurrence wins; `checkInvariants` reports the duplicate.
 */
export function indexTree(root: IrNode): Map<NodeId, IndexEntry> {
  const index = new Map<NodeId, IndexEntry>();
  walk(root, (node, { position }) => {
    if (!index.has(node.id)) {
      index.set(node.id, { node, ...(position === undefined ? {} : { position }) });
    }
  });
  return index;
}

export function findNode(root: IrNode, id: NodeId): IrNode | undefined {
  let found: IrNode | undefined;
  walk(root, (node) => {
    if (found !== undefined) return false;
    if (node.id === id) found = node;
    return undefined;
  });
  return found;
}

/** The parent of a node, or `undefined` for the root or a missing ID. */
export function parentOf(root: IrNode, id: NodeId): IrNode | undefined {
  return pathTo(root, id)?.at(-2);
}

/** The nodes from the root down to the node with `id`, inclusive. */
export function pathTo(root: IrNode, id: NodeId): IrNode[] | undefined {
  const path: IrNode[] = [];
  const search = (node: IrNode): boolean => {
    path.push(node);
    if (node.id === id) return true;
    for (const slot of children(node)) {
      if (search(slot.node)) return true;
    }
    path.pop();
    return false;
  };
  return search(root) ? path : undefined;
}

/**
 * Returns a copy of `node` with `visit` applied to each direct child. Nodes
 * whose children didn't change are returned as is (structural sharing).
 */
function mapChildren<N extends IrNode>(node: N, visit: (child: IrNode) => IrNode): N {
  let changes: Record<string, unknown> | undefined;
  for (const field of CHILD_FIELDS[node.kind]) {
    const value: unknown = Reflect.get(node, field);
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      const next = items.map((item) => (isIrNode(item) ? visit(item) : item));
      if (next.some((item, i) => item !== items[i])) (changes ??= {})[field] = next;
    } else if (isIrNode(value)) {
      const next = visit(value);
      if (next !== value) (changes ??= {})[field] = next;
    }
  }
  return changes === undefined ? node : Object.assign({}, node, changes);
}

/**
 * Returns a new tree where the node with `id` is replaced by `update(node)`.
 * Only the path from the root to that node is copied; everything else is
 * shared with the original.
 *
 * The result isn't validated: replacing an expression with a statement, for
 * example, produces an invalid tree. Validate before keeping it.
 */
export function updateNode<R extends IrNode>(
  root: R,
  id: NodeId,
  update: (node: IrNode) => IrNode,
): R {
  if (root.id === id) {
    throw new Error(`Cannot replace the root node ${id}; build a new tree instead`);
  }
  // An object rather than a `let`: TypeScript doesn't see the callback
  // setting a local, and would treat the not-found check as dead code.
  const search = { found: false };
  const visit = (node: IrNode): IrNode => {
    if (search.found) return node;
    if (node.id === id) {
      search.found = true;
      return update(node);
    }
    return mapChildren(node, visit);
  };
  const result = mapChildren(root, visit);
  if (!search.found) throw new Error(`No node with id ${id}`);
  return result;
}

export function replaceNode<R extends IrNode>(root: R, id: NodeId, replacement: IrNode): R {
  return updateNode(root, id, () => replacement);
}
