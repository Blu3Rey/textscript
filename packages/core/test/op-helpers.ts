import { expect } from 'vitest';
import {
  allNodes,
  apply,
  createBuilder,
  type ApplyErrorCode,
  type EditOp,
  type IrDocument,
  type IrNode,
  type NodeKind,
  type NodeOfKind,
} from '../src';
import { said } from './fixtures';

export const S = said(0);

/**
 * A small program to edit:
 *
 *   seen = set()
 *   for num in nums:
 *       if num in seen:
 *           return True
 *       else:
 *           ⟨else not described⟩
 *       seen.add(num)
 *   return False
 *
 * Tests find nodes by kind with `nth`, not by ID.
 */
export function base(): IrDocument {
  const b = createBuilder();
  return b.document(
    b.program([
      b.assign(
        { target: b.name('seen', S), value: b.collection({ collection: 'set', elements: [] }, S) },
        S,
      ),
      b.forEach(
        {
          target: b.name('num', S),
          iterable: b.name('nums', S),
          body: b.block([
            b.if(
              {
                cond: b.membership({ element: b.name('num', S), container: b.name('seen', S) }, S),
                body: b.block([b.return(b.literal(true, S), S)]),
                orelse: b.block([b.blockHole('else not described')]),
              },
              S,
            ),
            b.update({ target: b.name('seen', S), op: 'add', value: b.name('num', S) }, S),
          ]),
        },
        S,
      ),
      b.return(b.literal(false, S), S),
    ]),
  );
}

/** The `index`-th node of a kind, in document order. */
export function nth<K extends NodeKind>(doc: IrDocument, kind: K, index = 0): NodeOfKind<K> {
  const node = allNodes(doc.program).filter((n): n is NodeOfKind<K> => n.kind === kind)[index];
  if (node === undefined) throw new Error(`no ${kind} #${String(index)}`);
  return node;
}

export function byId(doc: IrDocument, id: string): IrNode | undefined {
  return allNodes(doc.program).find((node) => node.id === id);
}

/**
 * Applies ops that must succeed, checks the inverse restores the original
 * program, and returns the new document.
 */
export function applied(doc: IrDocument, ...ops: EditOp[]): IrDocument {
  const result = apply(doc, { utteranceId: 'u1', ops });
  if (!result.ok)
    throw new Error(
      `${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.issues ?? [])}`,
    );
  const undone = apply(result.document, result.inverse);
  if (!undone.ok) throw new Error(`inverse failed: ${undone.error.code}: ${undone.error.message}`);
  expect(undone.document.program).toEqual(doc.program);
  expect(result.document.nextId).toBeGreaterThanOrEqual(doc.nextId);
  return result.document;
}

/** Applies ops that must fail with `code` (at `opIndex`, when given). */
export function rejected(doc: IrDocument, code: ApplyErrorCode, ops: EditOp[], opIndex?: number) {
  const result = apply(doc, { utteranceId: 'u1', ops });
  expect(result.ok ? 'ok' : result.error.code).toBe(code);
  if (!result.ok && opIndex !== undefined) expect(result.error.opIndex).toBe(opIndex);
  return result;
}

/** Statement kinds of a block or the program body, for compact assertions. */
export function kinds(nodes: readonly IrNode[]): string[] {
  return nodes.map((node) => node.kind);
}
