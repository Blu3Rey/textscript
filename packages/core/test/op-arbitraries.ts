// fast-check generators for random edit batches aimed at a given document.
//
// Every operation kind is generated, targeting real nodes of the document
// (or, for later ops in a batch, nodes an earlier op may have removed). Many
// batches therefore fail, which is fine: properties check what happens when
// a batch applies, and that failures change nothing.

import fc from 'fast-check';
import {
  allNodes,
  indexTree,
  type EditBatch,
  type EditOp,
  type InsertPosition,
  type IrDocument,
  type IrNode,
  type JsonValue,
  type NodeId,
  type Span,
  type Stmt,
  type While,
} from '../src';
import { expr, stmt } from './arbitraries';

const span: fc.Arbitrary<Span> = fc
  .tuple(fc.nat(20), fc.integer({ min: 1, max: 4 }))
  .map(([start, length]) => ({ utteranceId: 'u1', start, end: start + length }));
const provenance = fc.array(span, { minLength: 1, maxLength: 2 });
const identifier = fc.stringMatching(/^[a-z_][a-z0-9_]{0,5}$/);
const text = fc.string({ minLength: 1, maxLength: 8 });

/**
 * Gives a generated subtree temporary IDs (unique within the batch via
 * `counter`) and points RefHole candidates at real nodes.
 */
function withTempIds<N extends object>(
  node: N,
  counter: { next: number },
  realIds: readonly NodeId[],
): N {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    if ('id' in value) Object.assign(value, { id: `t${String(counter.next++)}` });
    if ('kind' in value && value.kind === 'RefHole') {
      Object.assign(value, { candidates: [realIds[0] ?? 'n1', realIds[1] ?? realIds[0] ?? 'n1'] });
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(node);
  return node;
}

const BINDING_FIELDS = new Set(['target', 'name', 'params']);

/** Facts about a document that op generators pick targets from. */
function survey(doc: IrDocument) {
  const index = indexTree(doc.program);
  const nodes = allNodes(doc.program);
  const nonRoot = nodes.filter((node) => node.id !== doc.program.id);
  const containers = nodes.filter((node) => node.kind === 'Program' || node.kind === 'Block');
  const statements = nonRoot.filter((node) => {
    const field = index.get(node.id)?.position?.field;
    return field === 'body' || field === 'stmts';
  });
  const expressions = nonRoot.filter((node) => {
    const field = index.get(node.id)?.position?.field ?? '';
    return (
      !statements.includes(node) &&
      node.kind !== 'Block' &&
      node.kind !== 'Elif' &&
      node.kind !== 'DictEntry' &&
      !BINDING_FIELDS.has(field)
    );
  });
  const notes = nodes.flatMap((node) => node.notes ?? []);
  return { nodes, nonRoot, containers, statements, expressions, notes, index };
}

function statementsIn(container: IrNode): readonly Stmt[] {
  if (container.kind === 'Program') return container.body;
  if (container.kind === 'Block') return container.stmts;
  return [];
}

function positionIn(container: IrNode): fc.Arbitrary<InsertPosition> {
  const ids = statementsIn(container).map((s) => s.id);
  const options: fc.Arbitrary<InsertPosition>[] = [
    fc.constantFrom<InsertPosition>({ at: 'start' }, { at: 'end' }),
  ];
  if (ids.length > 0) {
    options.push(fc.constantFrom(...ids).map((id): InsertPosition => ({ before: id })));
    options.push(fc.constantFrom(...ids).map((id): InsertPosition => ({ after: id })));
  }
  return fc.oneof(...options);
}

function whileWrapper(counter: { next: number }): While {
  return {
    kind: 'While',
    id: `t${String(counter.next++)}`,
    cond: {
      kind: 'Name',
      id: `t${String(counter.next++)}`,
      name: 'cond',
      provenance: [{ utteranceId: 'u1', start: 0, end: 1 }],
    },
    body: {
      kind: 'Block',
      id: `t${String(counter.next++)}`,
      stmts: [
        { kind: 'BlockHole', id: `t${String(counter.next++)}`, reason: 'wrapped', provenance: [] },
      ],
      provenance: [],
    },
    provenance: [{ utteranceId: 'u1', start: 0, end: 1 }],
  };
}

/** One random operation against `doc`. Node payloads still carry placeholder IDs. */
function op(doc: IrDocument, counter: { next: number }): fc.Arbitrary<EditOp> {
  const facts = survey(doc);
  const realIds = facts.nodes.map((node) => node.id);
  const fresh = <N extends object>(arb: fc.Arbitrary<N>) =>
    arb.map((node) => withTempIds(structuredClone(node), counter, realIds));
  const options: fc.Arbitrary<EditOp>[] = [];

  if (facts.containers.length > 0) {
    options.push(
      fc.constantFrom(...facts.containers).chain((container) =>
        fc.tuple(positionIn(container), fresh(stmt(1))).map(([position, s]): EditOp => ({
          op: 'add_stmt',
          parent: container.id,
          position,
          stmt: s,
        })),
      ),
    );
  }

  const holes = facts.nonRoot.filter((node) => node.kind.endsWith('Hole'));
  if (holes.length > 0) {
    options.push(
      fc
        .constantFrom(...holes)
        .chain((hole) =>
          hole.kind === 'BlockHole'
            ? fc
                .array(fresh(stmt(1)), { minLength: 1, maxLength: 2 })
                .map((value): EditOp => ({ op: 'fill_hole', hole: hole.id, value }))
            : fresh(expr(1)).map((value): EditOp => ({ op: 'fill_hole', hole: hole.id, value })),
        ),
    );
  }

  const updatable = facts.nonRoot.filter((node) =>
    ['BinOp', 'Compare', 'Name', 'Literal', 'Membership', 'Update', 'ExprHole'].includes(node.kind),
  );
  if (updatable.length > 0) {
    options.push(
      fc.constantFrom(...updatable).chain((node): fc.Arbitrary<EditOp> => {
        const update = (field: string, value: fc.Arbitrary<JsonValue>) =>
          fc.tuple(value, provenance).map(([v, p]): EditOp => ({
            op: 'update_field',
            node: node.id,
            field,
            value: v,
            provenance: p,
          }));
        switch (node.kind) {
          case 'BinOp':
            return update('op', fc.constantFrom('+', '-', '*', '//'));
          case 'Compare':
            return update('op', fc.constantFrom('<', '==', '>='));
          case 'Name':
            return update('name', identifier);
          case 'Literal':
            return update(
              'value',
              fc.oneof(fc.integer(), fc.string({ maxLength: 4 }), fc.boolean(), fc.constant(null)),
            );
          case 'Membership':
            return update('negated', fc.boolean());
          case 'Update':
            return update('op', fc.constantFrom('+=', 'append', 'add'));
          default:
            return update('reason', text);
        }
      }),
    );
  }

  if (facts.expressions.length > 0) {
    options.push(
      fc
        .tuple(fc.constantFrom(...facts.expressions), fresh(expr(1)))
        .map(([node, replacement]): EditOp => ({ op: 'replace_node', node: node.id, replacement })),
    );
  }
  if (facts.statements.length > 0) {
    options.push(
      fc
        .tuple(fc.constantFrom(...facts.statements), fresh(stmt(1)))
        .map(([node, replacement]): EditOp => ({ op: 'replace_node', node: node.id, replacement })),
    );
  }

  if (facts.nonRoot.length > 0) {
    options.push(
      fc
        .tuple(fc.constantFrom(...facts.nonRoot), fc.option(provenance, { nil: undefined }))
        .map(([node, p]): EditOp => ({
          op: 'remove_node',
          node: node.id,
          ...(p === undefined ? {} : { provenance: p }),
        })),
    );
    options.push(
      fc
        .tuple(fc.constantFrom(...facts.nonRoot), fc.option(text, { nil: undefined }))
        .map(([node, label]): EditOp => ({
          op: 'set_label',
          node: node.id,
          ...(label === undefined ? {} : { label }),
        })),
    );
    options.push(
      fc
        .tuple(
          fc.constantFrom(...facts.nodes),
          text,
          fc.constantFrom('general' as const, 'edge-case' as const, 'complexity' as const),
          provenance,
        )
        .map(([node, t, tag, p]): EditOp => ({
          op: 'add_note',
          node: node.id,
          text: t,
          tag,
          provenance: p,
        })),
    );
    options.push(
      fc
        .subarray(realIds, { maxLength: Math.min(3, realIds.length) })
        .map((candidates): EditOp => ({ op: 'ask_clarification', question: 'Which?', candidates })),
    );
  }

  if (facts.statements.length > 0 && facts.containers.length > 0) {
    options.push(
      fc
        .tuple(fc.constantFrom(...facts.statements), fc.constantFrom(...facts.containers))
        .chain(([node, container]) =>
          positionIn(container).map((position): EditOp => ({
            op: 'move_node',
            node: node.id,
            parent: container.id,
            position,
          })),
        ),
    );
  }

  const wrappable = facts.containers.filter((c) => statementsIn(c).length > 0);
  if (wrappable.length > 0) {
    options.push(
      fc.constantFrom(...wrappable).chain((container) => {
        const ids = statementsIn(container).map((s) => s.id);
        return fc.tuple(fc.nat(ids.length - 1), fc.nat(ids.length - 1)).map(([a, b]): EditOp => ({
          op: 'wrap_nodes',
          nodes: ids.slice(Math.min(a, b), Math.max(a, b) + 1),
          wrapper: whileWrapper(counter),
        }));
      }),
    );
  }

  const names = facts.nonRoot.filter((node) => node.kind === 'Name');
  if (names.length > 0) {
    options.push(
      fc
        .tuple(fc.constantFrom(...names), identifier)
        .map(([node, name]): EditOp => ({ op: 'rename_symbol', node: node.id, name })),
    );
  }
  if (facts.notes.length > 0) {
    options.push(
      fc.constantFrom(...facts.notes).map((note): EditOp => ({ op: 'remove_note', note: note.id })),
    );
  }

  return fc.oneof(...options);
}

/** Random batches of one to four operations against `doc`. */
export function batchFor(doc: IrDocument): fc.Arbitrary<EditBatch> {
  // One counter for the whole batch keeps temporary IDs unique within it.
  const counter = { next: 1 };
  return fc
    .array(op(doc, counter), { minLength: 1, maxLength: 4 })
    .map((ops) => ({ utteranceId: 'u1', ops }));
}
