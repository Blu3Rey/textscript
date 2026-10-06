import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  CHILD_FIELDS,
  ExprSchema,
  IrDocumentSchema,
  NODE_KINDS,
  NODE_SCHEMAS,
  StmtSchema,
  allNodes,
  createBuilder,
  irDocumentJsonSchema,
  type ChildFieldOf,
  type Expr,
  type IrDocument,
  type IrNode,
  type NodeKind,
  type NodeOfKind,
  type Stmt,
} from '../src';
import { kitchenSink, said, workedExample } from './fixtures';

const sampleNodes = new Map<NodeKind, IrNode>();
for (const node of allNodes(kitchenSink().program)) {
  if (!sampleNodes.has(node.kind)) sampleNodes.set(node.kind, node);
}

function sample(kind: NodeKind): IrNode {
  const node = sampleNodes.get(kind);
  if (node === undefined) throw new Error(`kitchenSink has no ${kind}`);
  return node;
}

/**
 * Exact type equality. Unlike `toEqualTypeOf`, this compares types without
 * expanding them, so it works on the IR's recursive unions. The trick needs
 * its `T` parameters even though each appears only once.
 */
type Equals<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('schema types', () => {
  // These run at compile time: `pnpm typecheck` fails if a schema drifts
  // from its interface, or if a kind is missing from NODE_SCHEMAS.
  it('match the hand-written interfaces exactly, for every kind', () => {
    type KindsThatDrift = {
      [K in NodeKind]: Equals<z.output<(typeof NODE_SCHEMAS)[K]>, NodeOfKind<K>> extends true
        ? never
        : K;
    }[NodeKind];
    expectTypeOf<KindsThatDrift>().toEqualTypeOf<never>();
    expectTypeOf<Equals<keyof typeof NODE_SCHEMAS, NodeKind>>().toEqualTypeOf<true>();
    expectTypeOf<Equals<z.output<typeof IrDocumentSchema>, IrDocument>>().toEqualTypeOf<true>();
    expectTypeOf<Equals<z.output<typeof ExprSchema>, Expr>>().toEqualTypeOf<true>();
    expectTypeOf<Equals<z.output<typeof StmtSchema>, Stmt>>().toEqualTypeOf<true>();
  });

  it('CHILD_FIELDS lists every node-valued field of every kind', () => {
    type Missing = {
      [K in NodeKind]: Exclude<ChildFieldOf<NodeOfKind<K>>, (typeof CHILD_FIELDS)[K][number]>;
    }[NodeKind];
    expectTypeOf<Missing>().toEqualTypeOf<never>();
  });
});

describe('node schemas', () => {
  it('cover exactly the node kinds', () => {
    expect(Object.keys(NODE_SCHEMAS).sort()).toEqual([...NODE_KINDS].sort());
    expect(NODE_KINDS).toHaveLength(35);
  });

  describe.each(NODE_KINDS)('%s', (kind) => {
    const schema = NODE_SCHEMAS[kind];

    it('accepts a valid node', () => {
      expect(schema.safeParse(sample(kind)).success).toBe(true);
    });

    it('rejects a node without an id', () => {
      const { id: _id, ...rest } = sample(kind);
      expect(schema.safeParse(rest).success).toBe(false);
    });

    it('rejects unknown keys', () => {
      expect(schema.safeParse({ ...sample(kind), extra: true }).success).toBe(false);
    });

    it('rejects another kind', () => {
      const other = kind === 'Name' ? 'Literal' : 'Name';
      expect(schema.safeParse({ ...sample(kind), kind: other }).success).toBe(false);
    });

    it('rejects an explicit undefined for an optional field', () => {
      expect(schema.safeParse({ ...sample(kind), label: undefined }).success).toBe(false);
    });
  });
});

describe('shape rules', () => {
  const b = createBuilder();
  const ok = (node: unknown) => ExprSchema.safeParse(node).success;

  it('requires identifiers for names and attributes', () => {
    expect(ok(b.name('nums_2', said(0)))).toBe(true);
    expect(ok(b.name('2nums', said(0)))).toBe(false);
    expect(ok(b.name('my list', said(0)))).toBe(false);
    expect(ok(b.attribute({ object: b.name('s', said(0)), name: 'add-1' }, said(0)))).toBe(false);
  });

  it('requires well-formed node IDs', () => {
    for (const id of ['n0', 'n01', 'x1', 'n', '1', 't0', 'tn1']) {
      expect(ok({ ...b.name('x', said(0)), id })).toBe(false);
    }
  });

  it('requires finite numbers', () => {
    expect(ok(b.literal(1.5, said(0)))).toBe(true);
    expect(ok(b.literal(Number.POSITIVE_INFINITY, said(0)))).toBe(false);
    expect(ok(b.literal(Number.NaN, said(0)))).toBe(false);
  });

  it('requires at least two BoolOp operands and RefHole candidates', () => {
    const x = b.name('x', said(0));
    expect(ok(b.boolOp({ op: 'and', operands: [x] }, said(0)))).toBe(false);
    expect(ok(b.refHole('which?', ['n1']))).toBe(false);
  });

  it('requires non-empty blocks and text', () => {
    expect(NODE_SCHEMAS.Block.safeParse(b.block([])).success).toBe(false);
    expect(ok(b.exprHole(''))).toBe(false);
  });

  it('requires integer, non-negative span indices', () => {
    const span = (start: number, end: number) => ({
      provenance: [{ utteranceId: 'u1', start, end }],
    });
    expect(ok(b.name('x', span(0, 1)))).toBe(true);
    expect(ok(b.name('x', span(-1, 1)))).toBe(false);
    expect(ok(b.name('x', span(0.5, 1)))).toBe(false);
  });
});

describe('irDocumentJsonSchema', () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  const validate = ajv.compile(irDocumentJsonSchema());

  it('matches the golden file', async () => {
    const text = JSON.stringify(irDocumentJsonSchema(), null, 2) + '\n';
    await expect(text).toMatchFileSnapshot('./golden/ir-document.schema.json');
  });

  it('accepts valid documents', () => {
    expect(validate(kitchenSink())).toBe(true);
    expect(validate(workedExample())).toBe(true);
  });

  it('rejects what the Zod schema rejects', () => {
    const doc = workedExample();
    const broken = [
      { ...doc, extra: 1 },
      { ...doc, schemaVersion: 2 },
      { ...doc, nextId: 0 },
      { ...doc, program: { ...doc.program, kind: 'Block' } },
    ];
    for (const candidate of broken) {
      expect(IrDocumentSchema.safeParse(candidate).success).toBe(false);
      expect(validate(candidate)).toBe(false);
    }
  });
});
