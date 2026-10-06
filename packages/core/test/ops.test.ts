import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  EditOpSchema,
  HOLE_REASONS,
  OP_SCHEMAS,
  allNodes,
  editBatchJsonSchema,
  apply,
  serialize,
  type EditOp,
  type EditOpKind,
  type Name,
  type Stmt,
} from '../src';
import { at } from './fixtures';
import { S, applied, base, byId, kinds, nth, rejected } from './op-helpers';

type Equals<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const P = S.provenance ?? [];

function breakStmt(id = 't1'): Stmt {
  return { kind: 'Break', id, provenance: P };
}

/** A deep freeze, to prove `apply` never mutates its input. */
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

describe('op schemas', () => {
  it('match the op interfaces exactly, for every op', () => {
    type OpsThatDrift = {
      [K in EditOpKind]: Equals<
        z.output<(typeof OP_SCHEMAS)[K]>,
        Extract<EditOp, { op: K }>
      > extends true
        ? never
        : K;
    }[EditOpKind];
    expectTypeOf<OpsThatDrift>().toEqualTypeOf<never>();
    expectTypeOf<Equals<keyof typeof OP_SCHEMAS, EditOpKind>>().toEqualTypeOf<true>();
    expectTypeOf<Equals<z.output<typeof EditOpSchema>, EditOp>>().toEqualTypeOf<true>();
  });

  it('export a JSON Schema for the translator, recorded as a golden file', async () => {
    const text = JSON.stringify(editBatchJsonSchema(), null, 2) + '\n';
    await expect(text).toMatchFileSnapshot('./golden/edit-batch.schema.json');
  });

  it('cover 16 operations', () => {
    expect(Object.keys(OP_SCHEMAS)).toHaveLength(16);
  });
});

describe('apply', () => {
  it('never mutates the input document', () => {
    const doc = freeze(base());
    const before = serialize(doc);
    applied(doc, { op: 'remove_node', node: nth(doc, 'Assign').id });
    rejected(doc, 'unknown-node', [{ op: 'remove_node', node: 'n999' }]);
    expect(serialize(doc)).toBe(before);
  });

  it('is atomic: a failing op discards the whole batch', () => {
    const doc = base();
    const result = rejected(
      doc,
      'unknown-node',
      [
        { op: 'remove_node', node: nth(doc, 'Assign').id },
        { op: 'remove_node', node: 'n999' },
      ],
      1,
    );
    expect(result.ok).toBe(false);
  });

  it('applies an empty batch as a no-op with an empty inverse', () => {
    const doc = base();
    const result = apply(doc, { utteranceId: 'u1', ops: [] });
    expect(result).toEqual({
      ok: true,
      document: doc,
      inverse: { utteranceId: 'u1', ops: [] },
      clarifications: [],
    });
  });

  it('rejects malformed batches with the schema issues', () => {
    const doc = base();
    const result = apply(doc, {
      utteranceId: 'u1',
      ops: [{ op: 'remove_node' } as unknown as EditOp],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-batch', issues: [expect.stringContaining('ops[0]')] },
    });
  });

  it('pins a malformed result to the op that caused it', () => {
    const doc = base();
    rejected(
      doc,
      'invalid-result',
      [
        {
          op: 'replace_node',
          node: nth(doc, 'Membership').id,
          replacement: { kind: 'Break', id: 't1', provenance: P },
        },
        {
          op: 'replace_node',
          node: nth(doc, 'If').id,
          replacement: { kind: 'Continue', id: 't2', provenance: P },
        },
      ],
      0,
    );
  });

  it('lets primitives pass through malformed states, as inverse batches need', () => {
    const doc = base();
    const block = nth(doc, 'Block', 1);
    const ret = nth(doc, 'Return', 0);
    // Emptying a block is malformed for a moment; re-inserting fixes it.
    const next = applied(
      doc,
      { op: 'delete_child', node: ret.id },
      { op: 'insert_at', parent: block.id, field: 'stmts', index: 0, node: ret },
    );
    expect(next.program).toEqual(doc.program);
  });

  it('rejects a batch that leaves the document invalid, with the reasons', () => {
    const doc = base();
    const result = apply(doc, {
      utteranceId: 'u1',
      ops: [
        {
          op: 'replace_node',
          node: nth(doc, 'Assign').id,
          replacement: { kind: 'Break', id: 't1', provenance: [] },
        },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-result', issues: [expect.stringMatching(/^missing-provenance/)] },
    });
  });

  describe('temporary IDs', () => {
    it('get permanent IDs from nextId, in the order they appear in the batch', () => {
      const doc = base();
      const next = applied(doc, {
        op: 'add_stmt',
        parent: doc.program.id,
        position: { at: 'end' },
        stmt: {
          kind: 'Return',
          id: 't2',
          value: { kind: 'Name', id: 't1', name: 't1', provenance: P },
          provenance: P,
        },
      });
      const ret = next.program.body.at(-1);
      // The Return (t2) appears before its value (t1), so it's numbered first.
      expect(ret).toMatchObject({
        id: `n${String(doc.nextId)}`,
        value: { id: `n${String(doc.nextId + 1)}`, name: 't1' },
      });
      expect(next.nextId).toBe(doc.nextId + 2);
    });

    it('let later ops in the batch refer to nodes created earlier', () => {
      const doc = base();
      const next = applied(
        doc,
        {
          op: 'add_stmt',
          parent: doc.program.id,
          position: { at: 'end' },
          stmt: {
            kind: 'While',
            id: 't1',
            cond: { kind: 'Name', id: 't2', name: 'busy', provenance: P },
            body: {
              kind: 'Block',
              id: 't3',
              stmts: [{ kind: 'BlockHole', id: 't4', reason: 'later', provenance: [] }],
              provenance: [],
            },
            provenance: P,
          },
        },
        { op: 'add_stmt', parent: 't3', position: { at: 'end' }, stmt: breakStmt('t5') },
        { op: 'set_label', node: 't1', label: 'main loop' },
      );
      const loop = nth(next, 'While');
      expect(loop.label).toBe('main loop');
      expect(kinds(loop.body.stmts)).toEqual(['Break']);
    });

    it('must be given to exactly one node before use', () => {
      const doc = base();
      rejected(doc, 'invalid-temp-id', [{ op: 'remove_node', node: 't7' }]);
      rejected(doc, 'invalid-temp-id', [
        { op: 'add_stmt', parent: doc.program.id, position: { at: 'end' }, stmt: breakStmt('t1') },
        { op: 'add_stmt', parent: doc.program.id, position: { at: 'end' }, stmt: breakStmt('t1') },
      ]);
    });

    it('may not survive into the document', () => {
      const doc = base();
      // A RefHole candidate list is rewritten too, but a bare temp ID in a
      // label is just text.
      const next = applied(doc, { op: 'set_label', node: nth(doc, 'Assign').id, label: 't1' });
      expect(nth(next, 'Assign').label).toBe('t1');
    });
  });
});

describe('add_stmt', () => {
  it.each([
    [{ at: 'start' as const }, ['Break', 'Assign', 'ForEach', 'Return']],
    [{ at: 'end' as const }, ['Assign', 'ForEach', 'Return', 'Break']],
  ])('inserts at %j', (position, expected) => {
    const doc = base();
    expect(
      kinds(
        applied(doc, { op: 'add_stmt', parent: doc.program.id, position, stmt: breakStmt() })
          .program.body,
      ),
    ).toEqual(expected);
  });

  it('inserts before or after an anchor', () => {
    const doc = base();
    const loop = nth(doc, 'ForEach');
    const before = applied(doc, {
      op: 'add_stmt',
      parent: doc.program.id,
      position: { before: loop.id },
      stmt: breakStmt(),
    });
    expect(kinds(before.program.body)).toEqual(['Assign', 'Break', 'ForEach', 'Return']);
    const after = applied(doc, {
      op: 'add_stmt',
      parent: doc.program.id,
      position: { after: loop.id },
      stmt: breakStmt(),
    });
    expect(kinds(after.program.body)).toEqual(['Assign', 'ForEach', 'Break', 'Return']);
  });

  it("fills a block's lone BlockHole", () => {
    const doc = base();
    const elseBlock = nth(doc, 'Block', 2);
    const next = applied(doc, {
      op: 'add_stmt',
      parent: elseBlock.id,
      position: { at: 'start' },
      stmt: breakStmt(),
    });
    expect(kinds(nth(next, 'Block', 2).stmts)).toEqual(['Break']);
  });

  it('fails for an unknown parent, a non-block parent or a stray anchor', () => {
    const doc = base();
    rejected(doc, 'unknown-node', [
      { op: 'add_stmt', parent: 'n999', position: { at: 'end' }, stmt: breakStmt() },
    ]);
    rejected(doc, 'invalid-parent', [
      { op: 'add_stmt', parent: nth(doc, 'If').id, position: { at: 'end' }, stmt: breakStmt() },
    ]);
    rejected(doc, 'invalid-anchor', [
      {
        op: 'add_stmt',
        parent: doc.program.id,
        position: { after: nth(doc, 'Update').id },
        stmt: breakStmt(),
      },
    ]);
  });
});

describe('fill_hole', () => {
  it('fills a BlockHole with statements, in order', () => {
    const doc = base();
    const next = applied(doc, {
      op: 'fill_hole',
      hole: nth(doc, 'BlockHole').id,
      value: [breakStmt('t1'), { kind: 'Continue', id: 't2', provenance: P }],
    });
    expect(kinds(nth(next, 'Block', 2).stmts)).toEqual(['Break', 'Continue']);
  });

  it('fills an expression hole with an expression', () => {
    const doc = applied(base(), {
      op: 'update_field',
      node: nth(base(), 'Return', 1).id,
      field: 'value',
      value: { kind: 'CondHole', id: 't1', reason: 'unstated', provenance: [] },
    });
    const hole = nth(doc, 'CondHole');
    const next = applied(doc, {
      op: 'fill_hole',
      hole: hole.id,
      value: { kind: 'Literal', id: 't1', value: 0, provenance: P },
    });
    expect(nth(next, 'Return', 1).value).toMatchObject({ kind: 'Literal', value: 0 });
  });

  it('fails on a non-hole or a value of the wrong shape', () => {
    const doc = base();
    const literal = { kind: 'Literal' as const, id: 't1', value: 1, provenance: P };
    rejected(doc, 'not-a-hole', [{ op: 'fill_hole', hole: nth(doc, 'Assign').id, value: literal }]);
    rejected(doc, 'invalid-value', [
      { op: 'fill_hole', hole: nth(doc, 'BlockHole').id, value: literal },
    ]);
    rejected(doc, 'unknown-node', [{ op: 'fill_hole', hole: 'n999', value: literal }]);
  });

  it('fails when an expression is put where a name is needed', () => {
    const doc = applied(base(), {
      op: 'update_field',
      node: nth(base(), 'ForEach').id,
      field: 'target',
      value: { kind: 'NameHole', id: 't1', reason: 'unnamed', provenance: [] },
    });
    const hole = nth(doc, 'NameHole');
    rejected(doc, 'invalid-result', [
      {
        op: 'fill_hole',
        hole: hole.id,
        value: { kind: 'Literal', id: 't1', value: 1, provenance: P },
      },
    ]);
    applied(doc, {
      op: 'fill_hole',
      hole: hole.id,
      value: { kind: 'Name', id: 't1', name: 'item', provenance: P },
    });
  });

  it('fails on a statement list for an expression hole', () => {
    const doc = applied(base(), {
      op: 'update_field',
      node: nth(base(), 'Return', 1).id,
      field: 'value',
      value: { kind: 'ExprHole', id: 't1', reason: 'unstated', provenance: [] },
    });
    rejected(doc, 'invalid-value', [
      { op: 'fill_hole', hole: nth(doc, 'ExprHole').id, value: [breakStmt()] },
    ]);
  });
});

describe('update_field', () => {
  it('changes a plain field and adds the op provenance to the node', () => {
    const doc = base();
    const update = nth(doc, 'Update');
    const next = applied(doc, {
      op: 'update_field',
      node: update.id,
      field: 'op',
      value: 'discard',
      provenance: [at(4, 6, 'u7')],
    });
    expect(byId(next, update.id)).toMatchObject({
      op: 'discard',
      provenance: [...P, at(4, 6, 'u7')],
    });
  });

  it("doesn't duplicate provenance the node already has", () => {
    const doc = base();
    const literal = nth(doc, 'Literal');
    const next = applied(doc, {
      op: 'update_field',
      node: literal.id,
      field: 'value',
      value: null,
      provenance: P,
    });
    expect(byId(next, literal.id)).toMatchObject({ value: null, provenance: P });
  });

  it('replaces a required child', () => {
    const doc = base();
    const loop = nth(doc, 'ForEach');
    const next = applied(doc, {
      op: 'update_field',
      node: loop.id,
      field: 'iterable',
      value: { kind: 'Name', id: 't1', name: 'items', provenance: P },
    });
    expect(nth(next, 'ForEach').iterable).toMatchObject({ name: 'items' });
  });

  it('sets an optional child that was absent', () => {
    const doc = applied(base(), {
      op: 'add_stmt',
      parent: base().program.id,
      position: { at: 'end' },
      stmt: { kind: 'Return', id: 't1', provenance: P },
    });
    const ret = nth(doc, 'Return', 2);
    const next = applied(doc, {
      op: 'update_field',
      node: ret.id,
      field: 'value',
      value: { kind: 'Literal', id: 't1', value: 1, provenance: P },
    });
    expect(nth(next, 'Return', 2).value).toMatchObject({ value: 1 });
  });

  it.each(['label', 'notes', 'provenance', 'inferred', 'kind', 'id', 'bogus'])(
    'refuses the field %s',
    (field) => {
      const doc = base();
      rejected(doc, 'invalid-field', [
        { op: 'update_field', node: nth(doc, 'Assign').id, field, value: 'x' },
      ]);
    },
  );

  it('refuses list fields and non-node values for child fields', () => {
    const doc = base();
    rejected(doc, 'invalid-field', [
      { op: 'update_field', node: nth(doc, 'Block').id, field: 'stmts', value: [] },
    ]);
    rejected(doc, 'invalid-value', [
      { op: 'update_field', node: nth(doc, 'Assign').id, field: 'value', value: 3 },
    ]);
    rejected(doc, 'unknown-node', [{ op: 'update_field', node: 'n999', field: 'op', value: '+=' }]);
  });

  it('leaves type errors to validation', () => {
    const doc = base();
    rejected(doc, 'invalid-result', [
      { op: 'update_field', node: nth(doc, 'Update').id, field: 'op', value: 'bogus' },
    ]);
  });
});

describe('replace_node', () => {
  it('replaces expressions and statements', () => {
    const doc = base();
    const next = applied(
      doc,
      {
        op: 'replace_node',
        node: nth(doc, 'CollectionLiteral').id,
        replacement: { kind: 'DictLiteral', id: 't1', entries: [], provenance: P },
      },
      { op: 'replace_node', node: nth(doc, 'Return', 1).id, replacement: breakStmt('t2') },
    );
    expect(nth(next, 'Assign').value.kind).toBe('DictLiteral');
    expect(kinds(next.program.body)).toEqual(['Assign', 'ForEach', 'Break']);
  });

  it('refuses the program and unknown nodes', () => {
    const doc = base();
    rejected(doc, 'root', [{ op: 'replace_node', node: doc.program.id, replacement: breakStmt() }]);
    rejected(doc, 'unknown-node', [{ op: 'replace_node', node: 'n999', replacement: breakStmt() }]);
  });
});

describe('remove_node', () => {
  it('removes a statement', () => {
    const doc = base();
    expect(
      kinds(applied(doc, { op: 'remove_node', node: nth(doc, 'Assign').id }).program.body),
    ).toEqual(['ForEach', 'Return']);
  });

  it("leaves a BlockHole when a block's last statement goes", () => {
    const doc = base();
    const next = applied(doc, {
      op: 'remove_node',
      node: nth(doc, 'Return', 0).id,
      provenance: [at(0, 3, 'u5')],
    });
    expect(nth(next, 'Block', 1).stmts).toEqual([
      {
        kind: 'BlockHole',
        id: `n${String(doc.nextId)}`,
        reason: HOLE_REASONS.block,
        provenance: [at(0, 3, 'u5')],
      },
    ]);
  });

  it('empties the program without adding a hole', () => {
    let doc = base();
    for (const stmt of base().program.body)
      doc = applied(doc, { op: 'remove_node', node: stmt.id });
    expect(doc.program.body).toEqual([]);
  });

  it('clears an optional field', () => {
    const doc = base();
    const next = applied(doc, { op: 'remove_node', node: nth(doc, 'Block', 2).id });
    expect(nth(next, 'If')).not.toHaveProperty('orelse');
  });

  it.each([
    ['cond of an if', 'Membership', 'CondHole', HOLE_REASONS.condition],
    ['assignment target', 'Name', 'NameHole', HOLE_REASONS.name],
    ['assigned value', 'CollectionLiteral', 'ExprHole', HOLE_REASONS.value],
  ] as const)('leaves a hole in a required field (%s)', (_, kind, hole, reason) => {
    const doc = base();
    const next = applied(doc, { op: 'remove_node', node: nth(doc, kind).id });
    expect(nth(next, hole)).toMatchObject({ reason });
  });

  it('replaces a required block with a block holding a hole', () => {
    const doc = base();
    const next = applied(doc, { op: 'remove_node', node: nth(doc, 'Block', 0).id });
    expect(kinds(nth(next, 'ForEach').body.stmts)).toEqual(['BlockHole']);
  });

  it('deletes items from other lists', () => {
    const doc = applied(base(), {
      op: 'add_stmt',
      parent: base().program.id,
      position: { at: 'end' },
      stmt: {
        kind: 'ExprStmt',
        id: 't1',
        expr: {
          kind: 'Call',
          id: 't2',
          callee: { kind: 'Name', id: 't3', name: 'print', provenance: P },
          args: [{ kind: 'Name', id: 't4', name: 'a', provenance: P }],
          provenance: P,
        },
        provenance: P,
      },
    });
    const arg = allNodes(doc.program).find((n) => n.kind === 'Name' && n.name === 'a');
    const next = applied(doc, { op: 'remove_node', node: arg?.id ?? '' });
    expect(nth(next, 'Call').args).toEqual([]);
  });

  it('refuses removals that leave the document invalid, and the program', () => {
    const doc = applied(base(), {
      op: 'update_field',
      node: nth(base(), 'If').id,
      field: 'cond',
      value: {
        kind: 'BoolOp',
        id: 't1',
        op: 'and',
        operands: [
          { kind: 'Name', id: 't2', name: 'a', provenance: P },
          { kind: 'Name', id: 't3', name: 'b', provenance: P },
        ],
        provenance: P,
      },
    });
    const operand = nth(doc, 'BoolOp').operands[0];
    rejected(doc, 'invalid-result', [{ op: 'remove_node', node: operand?.id ?? '' }]);
    rejected(doc, 'root', [{ op: 'remove_node', node: doc.program.id }]);
  });
});

describe('rename_symbol', () => {
  it('renames every definition and use of a symbol', () => {
    const doc = base();
    const firstSeen = nth(doc, 'Name', 0);
    const next = applied(doc, {
      op: 'rename_symbol',
      node: firstSeen.id,
      name: 'visited',
      provenance: [at(2, 3, 'u4')],
    });
    const names = allNodes(next.program)
      .filter((n): n is Name => n.kind === 'Name')
      .map((n) => n.name);
    expect(names).toEqual(['visited', 'num', 'nums', 'num', 'visited', 'visited', 'num']);
    expect(byId(next, firstSeen.id)?.provenance).toContainEqual(at(2, 3, 'u4'));
  });

  it('renames an undefined name everywhere it appears', () => {
    const doc = base();
    const nums = allNodes(doc.program).find((n) => n.kind === 'Name' && n.name === 'nums');
    const next = applied(doc, { op: 'rename_symbol', node: nums?.id ?? '', name: 'values' });
    expect(nth(next, 'ForEach').iterable).toMatchObject({ name: 'values' });
  });

  it('is never reached after an op that left the program malformed', () => {
    const doc = base();
    rejected(
      doc,
      'invalid-result',
      [
        {
          op: 'replace_node',
          node: nth(doc, 'Block', 0).id,
          replacement: { kind: 'Name', id: 't1', name: 'x', provenance: P },
        },
        { op: 'rename_symbol', node: nth(doc, 'Name').id, name: 'visited' },
      ],
      0,
    );
  });

  it('refuses non-names and invalid names', () => {
    const doc = base();
    rejected(doc, 'not-a-name', [{ op: 'rename_symbol', node: nth(doc, 'Assign').id, name: 'x' }]);
    rejected(doc, 'invalid-name', [
      { op: 'rename_symbol', node: nth(doc, 'Name').id, name: 'two words' },
    ]);
  });
});

describe('labels and notes', () => {
  it('sets, changes and removes a label', () => {
    const doc = base();
    const loop = nth(doc, 'ForEach');
    const labeled = applied(doc, { op: 'set_label', node: loop.id, label: 'main loop' });
    expect(nth(labeled, 'ForEach').label).toBe('main loop');
    expect(nth(applied(labeled, { op: 'set_label', node: loop.id }), 'ForEach')).not.toHaveProperty(
      'label',
    );
  });

  it('keeps labels unique', () => {
    const doc = applied(base(), {
      op: 'set_label',
      node: nth(base(), 'ForEach').id,
      label: 'main',
    });
    rejected(doc, 'duplicate-label', [{ op: 'set_label', node: nth(doc, 'If').id, label: 'main' }]);
    applied(doc, { op: 'set_label', node: nth(doc, 'ForEach').id, label: 'main' });
    rejected(doc, 'unknown-node', [{ op: 'set_label', node: 'n999', label: 'x' }]);
  });

  it('adds notes with fresh IDs and the op provenance', () => {
    const doc = base();
    const loop = nth(doc, 'ForEach');
    const next = applied(
      doc,
      {
        op: 'add_note',
        node: loop.id,
        text: 'one pass',
        tag: 'complexity',
        provenance: [at(0, 2, 'u3')],
      },
      {
        op: 'add_note',
        node: loop.id,
        text: 'empty input skips it',
        tag: 'edge-case',
        provenance: [at(3, 6, 'u3')],
      },
    );
    expect(nth(next, 'ForEach').notes).toEqual([
      {
        id: `n${String(doc.nextId)}`,
        text: 'one pass',
        tag: 'complexity',
        provenance: [at(0, 2, 'u3')],
      },
      {
        id: `n${String(doc.nextId + 1)}`,
        text: 'empty input skips it',
        tag: 'edge-case',
        provenance: [at(3, 6, 'u3')],
      },
    ]);
  });

  it('needs provenance for a note', () => {
    const doc = base();
    rejected(doc, 'missing-provenance', [
      { op: 'add_note', node: nth(doc, 'ForEach').id, text: 'x', tag: 'general' },
    ]);
  });

  it('removes one note, and the field with the last one', () => {
    const doc = applied(
      base(),
      { op: 'add_note', node: nth(base(), 'ForEach').id, text: 'a', tag: 'general', provenance: P },
      { op: 'add_note', node: nth(base(), 'ForEach').id, text: 'b', tag: 'general', provenance: P },
    );
    const [first, second] = nth(doc, 'ForEach').notes ?? [];
    const once = applied(doc, { op: 'remove_note', note: first?.id ?? '' });
    expect(nth(once, 'ForEach').notes?.map((n) => n.text)).toEqual(['b']);
    const twice = applied(once, { op: 'remove_note', note: second?.id ?? '' });
    expect(nth(twice, 'ForEach')).not.toHaveProperty('notes');
    rejected(doc, 'unknown-note', [{ op: 'remove_note', note: 'n999' }]);
  });
});

describe('ask_clarification', () => {
  it('returns the question without changing anything', () => {
    const doc = base();
    const candidates = [nth(doc, 'ForEach').id, nth(doc, 'If').id];
    const result = apply(doc, {
      utteranceId: 'u1',
      ops: [{ op: 'ask_clarification', question: 'Which check?', candidates }],
    });
    expect(result).toMatchObject({
      ok: true,
      clarifications: [{ question: 'Which check?', candidates }],
    });
    if (result.ok) expect(result.document).toEqual(doc);
  });

  it('refuses unknown candidates', () => {
    rejected(base(), 'unknown-node', [
      { op: 'ask_clarification', question: 'Which?', candidates: ['n999'] },
    ]);
  });
});

describe('primitives', () => {
  it('insert_at and delete_child work on any list', () => {
    const doc = base();
    const block = nth(doc, 'Block', 0);
    const next = applied(doc, {
      op: 'insert_at',
      parent: block.id,
      field: 'stmts',
      index: 1,
      node: breakStmt(),
    });
    expect(kinds(nth(next, 'Block', 0).stmts)).toEqual(['If', 'Break', 'Update']);
    const back = applied(next, { op: 'delete_child', node: nth(next, 'Break').id });
    expect(back.program).toEqual(doc.program);
  });

  it('insert_at checks the field and index', () => {
    const doc = base();
    const block = nth(doc, 'Block', 0);
    rejected(doc, 'invalid-index', [
      { op: 'insert_at', parent: block.id, field: 'stmts', index: 3, node: breakStmt() },
    ]);
    rejected(doc, 'invalid-field', [
      { op: 'insert_at', parent: nth(doc, 'If').id, field: 'cond', index: 0, node: breakStmt() },
    ]);
  });

  it('delete_child only deletes from lists', () => {
    const doc = base();
    rejected(doc, 'not-in-list', [{ op: 'delete_child', node: nth(doc, 'Membership').id }]);
    rejected(doc, 'root', [{ op: 'delete_child', node: doc.program.id }]);
  });

  it('set_field sets and clears fields but not lists, kinds or IDs', () => {
    const doc = base();
    const assign = nth(doc, 'Assign');
    const labeled = applied(doc, {
      op: 'set_field',
      node: assign.id,
      field: 'label',
      value: 'init',
    });
    expect(nth(labeled, 'Assign').label).toBe('init');
    expect(
      nth(applied(labeled, { op: 'set_field', node: assign.id, field: 'label' }), 'Assign'),
    ).not.toHaveProperty('label');
    for (const field of ['kind', 'id'])
      rejected(doc, 'invalid-field', [{ op: 'set_field', node: assign.id, field, value: 'x' }]);
    rejected(doc, 'invalid-field', [
      { op: 'set_field', node: doc.program.id, field: 'body', value: [] },
    ]);
  });
});

describe('inverse batches', () => {
  it('consist only of primitives and are valid batches themselves', () => {
    const doc = base();
    const result = apply(doc, {
      utteranceId: 'u3',
      ops: [
        {
          op: 'wrap_nodes',
          nodes: [nth(doc, 'Assign').id],
          wrapper: {
            kind: 'If',
            id: 't1',
            cond: { kind: 'Name', id: 't2', name: 'ok', provenance: P },
            body: {
              kind: 'Block',
              id: 't3',
              stmts: [{ kind: 'BlockHole', id: 't4', reason: 'r', provenance: [] }],
              provenance: [],
            },
            elifs: [],
            provenance: P,
          },
        },
        { op: 'rename_symbol', node: nth(doc, 'Name').id, name: 'visited' },
        { op: 'add_note', node: doc.program.id, text: 'x', tag: 'general', provenance: P },
      ],
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.inverse.utteranceId).toBe('u3');
    expect(new Set(result.inverse.ops.map((op) => op.op))).toEqual(
      new Set(['insert_at', 'delete_child', 'swap_node', 'set_field']),
    );
    const restored = apply(result.document, result.inverse);
    expect(restored.ok && restored.document.program).toEqual(doc.program);
  });
});
