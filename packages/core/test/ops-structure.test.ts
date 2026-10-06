// The structural operations the roadmap calls out as tricky: move_node and
// wrap_nodes. These specify their edge cases.

import { describe, expect, it } from 'vitest';
import { createBuilder, type Stmt, type While } from '../src';
import { S, applied, base, byId, kinds, nth, rejected } from './op-helpers';

/** A `while ⟨cond⟩:` wrapper whose body is the hole the wrapped statements fill. */
function wrapper(): While {
  return {
    kind: 'While',
    id: 't1',
    cond: { kind: 'Name', id: 't2', name: 'running', provenance: S.provenance ?? [] },
    body: {
      kind: 'Block',
      id: 't3',
      stmts: [
        { kind: 'BlockHole', id: 't4', reason: 'wrapped statements go here', provenance: [] },
      ],
      provenance: [],
    },
    provenance: S.provenance ?? [],
  };
}

describe('move_node', () => {
  it('reorders statements within a block', () => {
    const doc = base();
    const loopBody = nth(doc, 'Block', 0);
    const update = nth(doc, 'Update');
    const ifStmt = nth(doc, 'If');
    const next = applied(doc, {
      op: 'move_node',
      node: update.id,
      parent: loopBody.id,
      position: { before: ifStmt.id },
    });
    expect(kinds(nth(next, 'Block', 0).stmts)).toEqual(['Update', 'If']);
  });

  it('moves a statement into another block', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    const loopBody = nth(doc, 'Block', 0);
    const next = applied(doc, {
      op: 'move_node',
      node: assign.id,
      parent: loopBody.id,
      position: { at: 'start' },
    });
    expect(kinds(next.program.body)).toEqual(['ForEach', 'Return']);
    expect(kinds(nth(next, 'Block', 0).stmts)).toEqual(['Assign', 'If', 'Update']);
  });

  it("fills the target block's hole instead of sitting next to it", () => {
    const doc = base();
    const update = nth(doc, 'Update');
    const elseBlock = nth(doc, 'Block', 2);
    const next = applied(doc, {
      op: 'move_node',
      node: update.id,
      parent: elseBlock.id,
      position: { at: 'end' },
    });
    expect(byId(next, elseBlock.id)).toMatchObject({ stmts: [{ kind: 'Update', id: update.id }] });
  });

  it('leaves a BlockHole when it moves the only statement out of a block', () => {
    const doc = base();
    const ret = nth(doc, 'Return', 0);
    const thenBlock = nth(doc, 'Block', 1);
    const next = applied(doc, {
      op: 'move_node',
      node: ret.id,
      parent: doc.program.id,
      position: { at: 'end' },
      provenance: [{ utteranceId: 'u9', start: 0, end: 2 }],
    });
    expect(byId(next, thenBlock.id)).toMatchObject({
      stmts: [
        {
          kind: 'BlockHole',
          reason: 'body not described',
          provenance: [{ utteranceId: 'u9', start: 0, end: 2 }],
        },
      ],
    });
    expect(kinds(next.program.body)).toEqual(['Assign', 'ForEach', 'Return', 'Return']);
  });

  it('is a no-op in effect when a statement moves to where it already is', () => {
    const doc = base();
    const ret = nth(doc, 'Return', 0);
    const thenBlock = nth(doc, 'Block', 1);
    const next = applied(doc, {
      op: 'move_node',
      node: ret.id,
      parent: thenBlock.id,
      position: { at: 'start' },
    });
    expect(byId(next, thenBlock.id)).toMatchObject({ stmts: [{ id: ret.id }] });
  });

  it('refuses to move a statement into its own block or a block inside it', () => {
    const doc = base();
    const loop = nth(doc, 'ForEach');
    rejected(doc, 'move-into-self', [
      { op: 'move_node', node: loop.id, parent: nth(doc, 'Block', 0).id, position: { at: 'end' } },
    ]);
    rejected(doc, 'move-into-self', [
      { op: 'move_node', node: loop.id, parent: nth(doc, 'Block', 1).id, position: { at: 'end' } },
    ]);
  });

  it('refuses an anchor that is the moved statement itself', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    rejected(doc, 'invalid-anchor', [
      { op: 'move_node', node: assign.id, parent: doc.program.id, position: { after: assign.id } },
    ]);
  });

  it('refuses an anchor that is not in the target', () => {
    const doc = base();
    rejected(doc, 'invalid-anchor', [
      {
        op: 'move_node',
        node: nth(doc, 'Assign').id,
        parent: doc.program.id,
        position: { after: nth(doc, 'Update').id },
      },
    ]);
  });

  it('only moves statements, and not holes', () => {
    const doc = base();
    rejected(doc, 'not-a-statement', [
      {
        op: 'move_node',
        node: nth(doc, 'Membership').id,
        parent: doc.program.id,
        position: { at: 'end' },
      },
    ]);
    rejected(doc, 'not-a-statement', [
      {
        op: 'move_node',
        node: nth(doc, 'BlockHole').id,
        parent: doc.program.id,
        position: { at: 'end' },
      },
    ]);
    rejected(doc, 'root', [
      { op: 'move_node', node: doc.program.id, parent: doc.program.id, position: { at: 'end' } },
    ]);
  });

  it('only moves into a block or the program', () => {
    const doc = base();
    rejected(doc, 'invalid-parent', [
      {
        op: 'move_node',
        node: nth(doc, 'Assign').id,
        parent: nth(doc, 'If').id,
        position: { at: 'end' },
      },
    ]);
  });
});

describe('wrap_nodes', () => {
  it('puts adjacent statements inside the wrapper, in order', () => {
    const doc = base();
    const loopBody = nth(doc, 'Block', 0);
    const ifStmt = nth(doc, 'If');
    const update = nth(doc, 'Update');
    const next = applied(doc, {
      op: 'wrap_nodes',
      nodes: [update.id, ifStmt.id],
      wrapper: wrapper(),
    });
    const loop = byId(next, loopBody.id);
    expect(loop).toMatchObject({ stmts: [{ kind: 'While' }] });
    expect(kinds(nth(next, 'While').body.stmts)).toEqual(['If', 'Update']);
  });

  it('wraps a single statement where it was', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    const next = applied(doc, { op: 'wrap_nodes', nodes: [assign.id], wrapper: wrapper() });
    expect(kinds(next.program.body)).toEqual(['While', 'ForEach', 'Return']);
    expect(nth(next, 'While').body.stmts.map((s) => s.id)).toEqual([assign.id]);
  });

  it('wraps every statement of the program', () => {
    const doc = base();
    const ids = doc.program.body.map((s) => s.id);
    const next = applied(doc, { op: 'wrap_nodes', nodes: ids, wrapper: wrapper() });
    expect(kinds(next.program.body)).toEqual(['While']);
    expect(nth(next, 'While').body.stmts.map((s) => s.id)).toEqual(ids);
  });

  it('refuses statements that are not next to each other', () => {
    const doc = base();
    const [first, , last] = doc.program.body;
    rejected(doc, 'not-adjacent', [
      { op: 'wrap_nodes', nodes: [first?.id ?? '', last?.id ?? ''], wrapper: wrapper() },
    ]);
  });

  it('refuses statements from different blocks', () => {
    const doc = base();
    rejected(doc, 'not-siblings', [
      {
        op: 'wrap_nodes',
        nodes: [nth(doc, 'Assign').id, nth(doc, 'Update').id],
        wrapper: wrapper(),
      },
    ]);
  });

  it('refuses expressions and listing a statement twice', () => {
    const doc = base();
    rejected(doc, 'not-a-statement', [
      { op: 'wrap_nodes', nodes: [nth(doc, 'Membership').id], wrapper: wrapper() },
    ]);
    const assign = nth(doc, 'Assign');
    rejected(doc, 'invalid-value', [
      { op: 'wrap_nodes', nodes: [assign.id, assign.id], wrapper: wrapper() },
    ]);
  });

  it('needs a compound wrapper whose body is a single BlockHole', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    const b = createBuilder();
    const notCompound: Stmt = b.break(S);
    rejected(doc, 'invalid-wrapper', [
      { op: 'wrap_nodes', nodes: [assign.id], wrapper: { ...notCompound, id: 't1' } },
    ]);
    const filled = wrapper();
    filled.body.stmts = [{ kind: 'Break', id: 't9', provenance: S.provenance ?? [] }];
    rejected(doc, 'invalid-wrapper', [{ op: 'wrap_nodes', nodes: [assign.id], wrapper: filled }]);
  });
});
