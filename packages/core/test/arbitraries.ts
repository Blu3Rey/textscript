// fast-check generators for random valid IR documents.
//
// Nodes are generated as drafts with placeholder IDs. `finalize` then walks
// the draft, hands out increasing IDs (with random gaps, like a document
// that had nodes deleted) and points RefHole candidates at real nodes, so
// every generated document satisfies the invariants by construction.

import fc from 'fast-check';
import {
  INFERENCE_RULE_IDS,
  IR_SCHEMA_VERSION,
  allNodes,
  type Block,
  type Expr,
  type IrDocument,
  type Name,
  type NameHole,
  type Note,
  type NodeMeta,
  type Program,
  type Span,
  type Stmt,
} from '../src';

const PENDING = 'n0';

const identifier = fc.stringMatching(/^[a-z_][a-z0-9_]{0,5}$/);
const text = fc.string({ minLength: 1, maxLength: 10 });

const span: fc.Arbitrary<Span> = fc
  .record({
    utteranceId: fc.constantFrom('u1', 'u2', 'u3'),
    start: fc.nat(30),
    length: fc.integer({ min: 1, max: 5 }),
  })
  .map(({ utteranceId, start, length }) => ({ utteranceId, start, end: start + length }));

const note: fc.Arbitrary<Note> = fc.record({
  id: fc.constant(PENDING),
  text,
  tag: fc.constantFrom('general', 'edge-case', 'complexity'),
  provenance: fc.array(span, { minLength: 1, maxLength: 2 }),
});

const optionalMeta = {
  inferred: fc.constantFrom(...INFERENCE_RULE_IDS),
  label: text,
  notes: fc.array(note, { minLength: 1, maxLength: 2 }),
};

/** Metadata for nodes that need a source: spans, or an inference rule. */
const sourcedMeta: fc.Arbitrary<NodeMeta> = fc.oneof(
  fc.record(
    { provenance: fc.array(span, { minLength: 1, maxLength: 2 }), ...optionalMeta },
    { requiredKeys: ['provenance'] },
  ),
  fc.record(
    { provenance: fc.array(span, { maxLength: 0 }), ...optionalMeta },
    { requiredKeys: ['provenance', 'inferred'] },
  ),
);

/** Metadata for holes and blocks, which may have no provenance. */
const anyMeta: fc.Arbitrary<NodeMeta> = fc.record(
  { provenance: fc.array(span, { maxLength: 2 }), ...optionalMeta },
  { requiredKeys: ['provenance'] },
);

const literalValue = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n)),
  fc.boolean(),
  fc.constant(null),
);

const name = fc
  .tuple(identifier, sourcedMeta)
  .map(([value, meta]): Name => ({ kind: 'Name', id: PENDING, name: value, ...meta }));
const nameHole = fc
  .tuple(text, anyMeta)
  .map(([reason, meta]): NameHole => ({ kind: 'NameHole', id: PENDING, reason, ...meta }));
const binding = fc.oneof(name, nameHole);

const leafExpr: fc.Arbitrary<Expr> = fc.oneof(
  name,
  fc
    .tuple(literalValue, sourcedMeta)
    .map(([value, meta]): Expr => ({ kind: 'Literal', id: PENDING, value, ...meta })),
  fc
    .tuple(fc.boolean(), sourcedMeta)
    .map(([negative, meta]): Expr => ({ kind: 'InfinityLiteral', id: PENDING, negative, ...meta })),
  fc
    .tuple(text, anyMeta)
    .map(([reason, meta]): Expr => ({ kind: 'ExprHole', id: PENDING, reason, ...meta })),
  fc
    .tuple(text, anyMeta)
    .map(([reason, meta]): Expr => ({ kind: 'CondHole', id: PENDING, reason, ...meta })),
  nameHole,
  fc.tuple(text, anyMeta).map(([reason, meta]): Expr => ({
    kind: 'RefHole',
    id: PENDING,
    reason,
    candidates: [PENDING, PENDING],
    ...meta,
  })),
);

const exprCache = new Map<number, fc.Arbitrary<Expr>>();

/** Expressions nested at most `depth` levels. */
export function expr(depth: number): fc.Arbitrary<Expr> {
  const cached = exprCache.get(depth);
  if (cached !== undefined) return cached;
  if (depth === 0) return leafExpr;
  const sub = expr(depth - 1);
  const optionalSub = fc.option(sub, { nil: undefined });
  const arb = fc.oneof(
    { weight: 3, arbitrary: leafExpr },
    fc
      .tuple(fc.constantFrom('not' as const, '-' as const), sub, sourcedMeta)
      .map(([op, operand, meta]): Expr => ({ kind: 'UnaryOp', id: PENDING, op, operand, ...meta })),
    fc
      .tuple(fc.constantFrom('+', '-', '*', '/', '//', '%', '**' as const), sub, sub, sourcedMeta)
      .map(([op, left, right, meta]): Expr => ({
        kind: 'BinOp',
        id: PENDING,
        op,
        left,
        right,
        ...meta,
      })),
    fc
      .tuple(fc.constantFrom('==', '!=', '<', '<=', '>', '>=' as const), sub, sub, sourcedMeta)
      .map(([op, left, right, meta]): Expr => ({
        kind: 'Compare',
        id: PENDING,
        op,
        left,
        right,
        ...meta,
      })),
    fc
      .tuple(
        fc.constantFrom('and' as const, 'or' as const),
        fc.array(sub, { minLength: 2, maxLength: 3 }),
        sourcedMeta,
      )
      .map(([op, operands, meta]): Expr => ({
        kind: 'BoolOp',
        id: PENDING,
        op,
        operands,
        ...meta,
      })),
    fc
      .tuple(fc.boolean(), sub, sub, sourcedMeta)
      .map(([negated, element, container, meta]): Expr => ({
        kind: 'Membership',
        id: PENDING,
        negated,
        element,
        container,
        ...meta,
      })),
    fc
      .tuple(sub, fc.array(sub, { maxLength: 2 }), sourcedMeta)
      .map(([callee, args, meta]): Expr => ({ kind: 'Call', id: PENDING, callee, args, ...meta })),
    fc.tuple(sub, sub, sourcedMeta).map(([object, index, meta]): Expr => ({
      kind: 'Index',
      id: PENDING,
      object,
      index,
      ...meta,
    })),
    fc
      .tuple(sub, optionalSub, optionalSub, optionalSub, sourcedMeta)
      .map(([object, start, stop, step, meta]): Expr => ({
        kind: 'Slice',
        id: PENDING,
        object,
        ...(start === undefined ? {} : { start }),
        ...(stop === undefined ? {} : { stop }),
        ...(step === undefined ? {} : { step }),
        ...meta,
      })),
    fc.tuple(sub, identifier, sourcedMeta).map(([object, attr, meta]): Expr => ({
      kind: 'Attribute',
      id: PENDING,
      object,
      name: attr,
      ...meta,
    })),
    fc
      .tuple(
        fc.constantFrom('list' as const, 'set' as const, 'tuple' as const),
        fc.array(sub, { maxLength: 3 }),
        sourcedMeta,
      )
      .map(([collection, elements, meta]): Expr => ({
        kind: 'CollectionLiteral',
        id: PENDING,
        collection,
        elements,
        ...meta,
      })),
    fc
      .tuple(fc.array(fc.tuple(sub, sub, sourcedMeta), { maxLength: 2 }), sourcedMeta)
      .map(([entries, meta]): Expr => ({
        kind: 'DictLiteral',
        id: PENDING,
        entries: entries.map(([key, value, entryMeta]) => ({
          kind: 'DictEntry',
          id: PENDING,
          key,
          value,
          ...entryMeta,
        })),
        ...meta,
      })),
  );
  exprCache.set(depth, arb);
  return arb;
}

const target = fc.oneof(
  name,
  nameHole,
  fc.tuple(expr(1), expr(1), sourcedMeta).map(([object, index, meta]) => ({
    kind: 'Index' as const,
    id: PENDING,
    object,
    index,
    ...meta,
  })),
  fc.tuple(expr(1), identifier, sourcedMeta).map(([object, attr, meta]) => ({
    kind: 'Attribute' as const,
    id: PENDING,
    object,
    name: attr,
    ...meta,
  })),
);

const leafStmt: fc.Arbitrary<Stmt> = fc.oneof(
  fc
    .tuple(target, expr(2), sourcedMeta)
    .map(([t, value, meta]): Stmt => ({ kind: 'Assign', id: PENDING, target: t, value, ...meta })),
  fc
    .tuple(
      target,
      fc.constantFrom(
        '+=',
        '-=',
        '*=',
        '/=',
        '//=',
        '%=',
        'append',
        'extend',
        'add',
        'remove',
        'discard' as const,
      ),
      expr(2),
      sourcedMeta,
    )
    .map(([t, op, value, meta]): Stmt => ({
      kind: 'Update',
      id: PENDING,
      target: t,
      op,
      value,
      ...meta,
    })),
  fc.tuple(fc.option(expr(2), { nil: undefined }), sourcedMeta).map(([value, meta]): Stmt => ({
    kind: 'Return',
    id: PENDING,
    ...(value === undefined ? {} : { value }),
    ...meta,
  })),
  sourcedMeta.map((meta): Stmt => ({ kind: 'Break', id: PENDING, ...meta })),
  sourcedMeta.map((meta): Stmt => ({ kind: 'Continue', id: PENDING, ...meta })),
  fc
    .tuple(expr(2), sourcedMeta)
    .map(([e, meta]): Stmt => ({ kind: 'ExprStmt', id: PENDING, expr: e, ...meta })),
  fc
    .tuple(text, sourcedMeta)
    .map(([t, meta]): Stmt => ({ kind: 'IntentStmt', id: PENDING, text: t, ...meta })),
);

const blockCache = new Map<number, fc.Arbitrary<Block>>();

/** A block: either a lone BlockHole or one to three statements. */
function block(depth: number): fc.Arbitrary<Block> {
  const cached = blockCache.get(depth);
  if (cached !== undefined) return cached;
  const hole = fc
    .tuple(text, anyMeta)
    .map(([reason, meta]): Stmt => ({ kind: 'BlockHole', id: PENDING, reason, ...meta }));
  const arb = fc
    .tuple(
      fc.oneof(
        hole.map((h) => [h]),
        fc.array(stmt(depth), { minLength: 1, maxLength: 3 }),
      ),
      anyMeta,
    )
    .map(([stmts, meta]): Block => ({ kind: 'Block', id: PENDING, stmts, ...meta }));
  blockCache.set(depth, arb);
  return arb;
}

const stmtCache = new Map<number, fc.Arbitrary<Stmt>>();

/** Statements whose blocks nest at most `depth` levels. */
export function stmt(depth: number): fc.Arbitrary<Stmt> {
  const cached = stmtCache.get(depth);
  if (cached !== undefined) return cached;
  if (depth === 0) return leafStmt;
  const body = block(depth - 1);
  const cond = expr(2);
  const arb = fc.oneof(
    { weight: 3, arbitrary: leafStmt },
    fc
      .tuple(binding, fc.array(binding, { maxLength: 3 }), body, sourcedMeta)
      .map(([fnName, params, b, meta]): Stmt => ({
        kind: 'FunctionDef',
        id: PENDING,
        name: fnName,
        params,
        body: b,
        ...meta,
      })),
    fc.tuple(binding, expr(2), body, sourcedMeta).map(([t, iterable, b, meta]): Stmt => ({
      kind: 'ForEach',
      id: PENDING,
      target: t,
      iterable,
      body: b,
      ...meta,
    })),
    fc
      .tuple(
        binding,
        fc.option(expr(1), { nil: undefined }),
        expr(1),
        fc.option(expr(1), { nil: undefined }),
        body,
        sourcedMeta,
      )
      .map(([t, start, stop, step, b, meta]): Stmt => ({
        kind: 'ForRange',
        id: PENDING,
        target: t,
        ...(start === undefined ? {} : { start }),
        stop,
        ...(step === undefined ? {} : { step }),
        body: b,
        ...meta,
      })),
    fc
      .tuple(cond, body, sourcedMeta)
      .map(([c, b, meta]): Stmt => ({ kind: 'While', id: PENDING, cond: c, body: b, ...meta })),
    fc
      .tuple(
        cond,
        body,
        fc.array(fc.tuple(cond, body, sourcedMeta), { maxLength: 2 }),
        fc.option(body, { nil: undefined }),
        sourcedMeta,
      )
      .map(([c, b, elifs, orelse, meta]): Stmt => ({
        kind: 'If',
        id: PENDING,
        cond: c,
        body: b,
        elifs: elifs.map(([ec, eb, em]) => ({
          kind: 'Elif',
          id: PENDING,
          cond: ec,
          body: eb,
          ...em,
        })),
        ...(orelse === undefined ? {} : { orelse }),
        ...meta,
      })),
  );
  stmtCache.set(depth, arb);
  return arb;
}

/** Hands out IDs in document order and fills in RefHole candidates. */
function finalize(program: Program, stride: number, extra: number, picks: number[]): IrDocument {
  let counter = 0;
  const nextId = () => {
    counter += stride;
    return `n${String(counter)}`;
  };
  const nodes = allNodes(program);
  for (const node of nodes) {
    Object.assign(node, { id: nextId() });
    for (const n of node.notes ?? []) Object.assign(n, { id: nextId() });
  }
  const nodeIds = nodes.map((node) => node.id);
  let pick = 0;
  for (const node of nodes) {
    if (node.kind === 'RefHole') {
      node.candidates = node.candidates.map(
        () => nodeIds[(picks[pick++ % picks.length] ?? 0) % nodeIds.length] ?? nodeIds[0] ?? 'n1',
      );
    }
  }
  return { schemaVersion: IR_SCHEMA_VERSION, nextId: counter + 1 + extra, program };
}

/** Random valid documents. */
export const document: fc.Arbitrary<IrDocument> = fc
  .tuple(
    fc.array(stmt(2), { maxLength: 4 }),
    anyMeta,
    fc.integer({ min: 1, max: 3 }),
    fc.nat(5),
    fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
  )
  .map(([body, meta, stride, extra, picks]) =>
    finalize({ kind: 'Program', id: PENDING, body, ...meta }, stride, extra, picks),
  );
