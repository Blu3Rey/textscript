import { describe, expect, it } from 'vitest';
import { diffPrograms, isEmptyDiff, type Stmt } from '../src';
import { S, applied, base, nth } from './op-helpers';

const P = S.provenance ?? [];
const breakStmt = (id = 't1'): Stmt => ({ kind: 'Break', id, provenance: P });

describe('diffPrograms', () => {
  it('finds nothing between a program and itself', () => {
    const doc = base();
    const diff = diffPrograms(doc.program, doc.program);
    expect(diff).toEqual({ added: [], removed: [], changed: [], moved: [] });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('reports added and removed nodes, whole subtrees included', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    const next = applied(doc, { op: 'replace_node', node: assign.id, replacement: breakStmt() });
    expect(diffPrograms(doc.program, next.program)).toEqual({
      added: [`n${String(doc.nextId)}`],
      removed: [assign.id, assign.target.id, assign.value.id],
      changed: [],
      moved: [],
    });
  });

  it('reports a node whose own fields changed, not its ancestors', () => {
    const doc = base();
    const update = nth(doc, 'Update');
    const next = applied(doc, {
      op: 'update_field',
      node: update.id,
      field: 'op',
      value: 'discard',
    });
    expect(diffPrograms(doc.program, next.program)).toEqual({
      added: [],
      removed: [],
      changed: [update.id],
      moved: [],
    });
  });

  it('counts labels and notes as changes', () => {
    const doc = base();
    const loop = nth(doc, 'ForEach');
    const next = applied(doc, { op: 'set_label', node: loop.id, label: 'main loop' });
    expect(diffPrograms(doc.program, next.program).changed).toEqual([loop.id]);
  });

  it('reports a statement moved to another block', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    const next = applied(doc, {
      op: 'move_node',
      node: assign.id,
      parent: nth(doc, 'Block', 0).id,
      position: { at: 'end' },
    });
    expect(diffPrograms(doc.program, next.program).moved).toEqual([assign.id]);
  });

  it('reports only the statement that changed places in a reorder', () => {
    const doc = base();
    const [first, loop, last] = doc.program.body;
    const next = applied(doc, {
      op: 'move_node',
      node: last?.id ?? '',
      parent: doc.program.id,
      position: { at: 'start' },
    });
    const diff = diffPrograms(doc.program, next.program);
    expect(diff.moved).toEqual([last?.id]);
    expect(diff.moved).not.toContain(first?.id);
    expect(diff.moved).not.toContain(loop?.id);
  });

  it('reports the fewest moves that explain a shuffle', () => {
    // Five statements reordered from [a, b, c, d, e] to [c, a, b, e, d]: the
    // longest run still in order is a, b, d (or a, b, e), so two moved.
    let doc = base();
    for (const id of ['t1', 't2']) {
      doc = applied(doc, {
        op: 'add_stmt',
        parent: doc.program.id,
        position: { at: 'end' },
        stmt: breakStmt(id),
      });
    }
    const [a, b, c, d, e] = doc.program.body.map((stmt) => stmt.id);
    const moveTo = (
      node: string | undefined,
      position: { before: string } | { at: 'start' | 'end' },
    ) => applied(doc, { op: 'move_node', node: node ?? '', parent: doc.program.id, position });
    const original = doc;
    doc = moveTo(c, { at: 'start' });
    doc = moveTo(e, { before: d ?? '' });
    expect(doc.program.body.map((stmt) => stmt.id)).toEqual([c, a, b, e, d]);

    const diff = diffPrograms(original.program, doc.program);
    expect(diff.moved).toHaveLength(2);
    expect(diff.moved).toContain(c);
    expect(diff.added).toEqual([]);
  });

  it("doesn't count siblings shifted by an insertion as moved", () => {
    const doc = base();
    const next = applied(doc, {
      op: 'add_stmt',
      parent: doc.program.id,
      position: { at: 'start' },
      stmt: breakStmt(),
    });
    expect(diffPrograms(doc.program, next.program)).toMatchObject({
      added: [`n${String(doc.nextId)}`],
      moved: [],
    });
  });
});
