import { describe, expect, it } from 'vitest';
import {
  NODE_KINDS,
  allNodes,
  children,
  createBuilder,
  findNode,
  indexTree,
  isIrNode,
  parentOf,
  pathTo,
  replaceNode,
  updateNode,
  walk,
  type IrNode,
  type Program,
} from '../src';
import { said, workedExample } from './fixtures';

function program(): Program {
  return workedExample().program;
}

/** Finds the first node matching `predicate`, failing the test if there is none. */
function first(root: IrNode, predicate: (node: IrNode) => boolean): IrNode {
  const node = allNodes(root).find(predicate);
  if (node === undefined) throw new Error('no matching node');
  return node;
}

describe('isIrNode', () => {
  it('recognizes every node kind and nothing else', () => {
    for (const kind of NODE_KINDS) expect(isIrNode({ kind })).toBe(true);
    expect(isIrNode({ kind: 'Bogus' })).toBe(false);
    expect(isIrNode({ kind: 'toString' })).toBe(false);
    expect(isIrNode(null)).toBe(false);
    expect(isIrNode('Name')).toBe(false);
  });
});

describe('children', () => {
  it('lists child nodes in source order with their positions', () => {
    const b = createBuilder();
    const cond = b.name('a', said(0));
    const body = b.block([b.break(said(1))]);
    const elif = b.elif(
      { cond: b.name('b', said(2)), body: b.block([b.continue(said(3))]) },
      said(2),
    );
    const orelse = b.block([b.return(undefined, said(4))]);
    const node = b.if({ cond, body, elifs: [elif], orelse }, said(0));

    expect(children(node)).toEqual([
      { node: cond, field: 'cond' },
      { node: body, field: 'body' },
      { node: elif, field: 'elifs', index: 0 },
      { node: orelse, field: 'orelse' },
    ]);
  });

  it('skips absent optional children', () => {
    const b = createBuilder();
    expect(children(b.return())).toEqual([]);
    expect(children(b.slice({ object: b.name('xs', said(0)) })).map((s) => s.field)).toEqual([
      'object',
    ]);
  });
});

describe('walk', () => {
  it('visits depth-first in source order', () => {
    const kinds: string[] = [];
    walk(program(), (node) => {
      kinds.push(node.kind);
    });
    expect(kinds).toEqual([
      'Program',
      'Assign',
      'Name', // seen
      'CollectionLiteral',
      'ForEach',
      'Name', // num
      'Name', // nums
      'Block',
      'If',
      'Membership',
      'Name',
      'Name',
      'Block',
      'Return',
      'Literal',
      'Block',
      'Update',
      'Name',
      'Name',
    ]);
  });

  it('reports depth and position', () => {
    const seen: { kind: string; depth: number; field?: string; index?: number }[] = [];
    walk(program(), (node, { depth, position }) => {
      seen.push({
        kind: node.kind,
        depth,
        ...(position === undefined ? {} : { field: position.field }),
        ...(position?.index === undefined ? {} : { index: position.index }),
      });
    });
    expect(seen.slice(0, 3)).toEqual([
      { kind: 'Program', depth: 0 },
      { kind: 'Assign', depth: 1, field: 'body', index: 0 },
      { kind: 'Name', depth: 2, field: 'target' },
    ]);
  });

  it('skips children when the visitor returns false', () => {
    const kinds: string[] = [];
    walk(program(), (node) => {
      kinds.push(node.kind);
      return node.kind !== 'ForEach';
    });
    expect(kinds).toEqual(['Program', 'Assign', 'Name', 'CollectionLiteral', 'ForEach']);
  });
});

describe('lookups', () => {
  const root = program();
  const ret = first(root, (node) => node.kind === 'Return');

  it('indexTree maps every node to its position', () => {
    const index = indexTree(root);
    expect(index.size).toBe(allNodes(root).length);
    expect(index.get(root.id)).toEqual({ node: root });
    expect(index.get(ret.id)?.position).toMatchObject({ field: 'stmts', index: 0 });
  });

  it('indexTree keeps the first node when IDs repeat', () => {
    const b = createBuilder();
    const a = b.break(said(0));
    const dup = { ...b.continue(said(1)), id: a.id };
    const index = indexTree(b.program([a, dup]));
    expect(index.get(a.id)?.node).toBe(a);
  });

  it('findNode finds by ID', () => {
    expect(findNode(root, ret.id)).toBe(ret);
    expect(findNode(root, root.id)).toBe(root);
    expect(findNode(root, 'n999')).toBeUndefined();
  });

  it('pathTo returns the chain from the root', () => {
    expect(pathTo(root, ret.id)?.map((node) => node.kind)).toEqual([
      'Program',
      'ForEach',
      'Block',
      'If',
      'Block',
      'Return',
    ]);
    expect(pathTo(root, root.id)).toEqual([root]);
    expect(pathTo(root, 'n999')).toBeUndefined();
  });

  it('parentOf returns the direct parent', () => {
    expect(parentOf(root, ret.id)?.kind).toBe('Block');
    expect(parentOf(root, root.id)).toBeUndefined();
    expect(parentOf(root, 'n999')).toBeUndefined();
  });
});

describe('updateNode', () => {
  it('replaces one node and copies only its ancestors', () => {
    const root = program();
    const literal = first(root, (node) => node.kind === 'Literal');
    const assign = first(root, (node) => node.kind === 'Assign');

    const next = updateNode(root, literal.id, (node) => ({ ...node, label: 'answer' }));

    expect(findNode(next, literal.id)?.label).toBe('answer');
    expect(literal).not.toHaveProperty('label');
    // Untouched subtrees are shared; ancestors are new objects.
    expect(findNode(next, assign.id)).toBe(assign);
    for (const ancestor of pathTo(root, literal.id) ?? []) {
      expect(findNode(next, ancestor.id)).not.toBe(ancestor);
    }
  });

  it('returns nodes unchanged when the update returns the same node', () => {
    const root = program();
    const literal = first(root, (node) => node.kind === 'Literal');
    expect(updateNode(root, literal.id, (node) => node)).toBe(root);
  });

  it('works inside lists', () => {
    const b = createBuilder();
    const kept = b.break(said(0));
    const second = b.continue(said(1));
    const root = b.program([kept, second]);
    const replacement = b.return(undefined, said(2));

    const next = replaceNode(root, second.id, replacement);

    expect(next.body).toEqual([kept, replacement]);
    expect(next.body[0]).toBe(kept);
  });

  it('refuses to replace the root', () => {
    const root = program();
    expect(() => updateNode(root, root.id, (node) => node)).toThrow(/root/);
  });

  it('throws for an unknown ID', () => {
    expect(() => updateNode(program(), 'n999', (node) => node)).toThrow(/n999/);
  });
});
