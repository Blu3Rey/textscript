import { describe, expect, it } from 'vitest';
import {
  IR_SCHEMA_VERSION,
  allNodes,
  createBuilder,
  createIdAllocator,
  nodeIdNumber,
  serialize,
} from '../src';
import { at, kitchenSink, said } from './fixtures';

describe('createIdAllocator', () => {
  it('counts up from 1 by default', () => {
    const ids = createIdAllocator();
    expect([ids.allocate(), ids.allocate(), ids.allocate()]).toEqual(['n1', 'n2', 'n3']);
    expect(ids.next).toBe(4);
  });

  it('continues from a saved position', () => {
    const ids = createIdAllocator(42);
    expect(ids.allocate()).toBe('n42');
    expect(ids.next).toBe(43);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a starting point of %s', (next) => {
    expect(() => createIdAllocator(next)).toThrow(RangeError);
  });
});

describe('nodeIdNumber', () => {
  it('reads the number from an ID', () => {
    expect(nodeIdNumber('n1')).toBe(1);
    expect(nodeIdNumber('n907')).toBe(907);
  });

  it.each(['n0', 'n01', 'x1', 'n', ''])('returns undefined for %j', (id) => {
    expect(nodeIdNumber(id)).toBeUndefined();
  });
});

describe('createBuilder', () => {
  it('gives every node and note a fresh, increasing ID', () => {
    const doc = kitchenSink();
    const ids = allNodes(doc.program).flatMap((node) => [
      node.id,
      ...(node.notes ?? []).map((note) => note.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = ids.map((id) => nodeIdNumber(id) ?? 0);
    expect(Math.max(...numbers)).toBe(doc.nextId - 1);
  });

  it('builds nodes with keys in canonical order, for every kind', () => {
    // serialize() re-parses through the schema, which emits keys in schema
    // order. Plain JSON.stringify keeps construction order. They must match.
    const doc = kitchenSink();
    expect(JSON.stringify(doc)).toBe(serialize(doc));
  });

  it('records where ID allocation stopped', () => {
    const b = createBuilder(createIdAllocator(10));
    const doc = b.document(b.program([b.break(said(0))]));
    expect(doc).toMatchObject({ schemaVersion: IR_SCHEMA_VERSION, nextId: 12 });
  });

  it('omits optional fields that were not given', () => {
    const b = createBuilder();
    const object = b.name('xs', said(0));
    expect(b.return()).not.toHaveProperty('value');
    expect(b.slice({ object })).not.toHaveProperty('start');
    expect(b.name('x')).toEqual({ kind: 'Name', id: 'n4', name: 'x', provenance: [] });
  });

  it('applies defaults for negation and elifs', () => {
    const b = createBuilder();
    const x = b.name('x', said(0));
    expect(b.membership({ element: x, container: x }).negated).toBe(false);
    const ifNode = b.if({ cond: x, body: b.block([b.break(said(1))]) });
    expect(ifNode.elifs).toEqual([]);
    expect(ifNode).not.toHaveProperty('orelse');
  });

  it('includes metadata only when given', () => {
    const b = createBuilder();
    const note = b.note('handles empty input', 'edge-case', [at(0, 3)]);
    const node = b.break({
      provenance: [at(0)],
      inferred: 'INF-BLOCK-END',
      label: 'exit',
      notes: [note],
    });
    expect(node).toEqual({
      kind: 'Break',
      id: 'n2',
      provenance: [at(0)],
      inferred: 'INF-BLOCK-END',
      label: 'exit',
      notes: [{ id: 'n1', text: 'handles empty input', tag: 'edge-case', provenance: [at(0, 3)] }],
    });
  });
});
