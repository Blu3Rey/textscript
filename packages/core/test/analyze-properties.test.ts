import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allNodes, analyze, indexTree, type DiagnosticCode, type NodeKind } from '../src';
import { document } from './arbitraries';

const HOLE_CODES: Partial<Record<NodeKind, readonly DiagnosticCode[]>> = {
  BlockHole: ['GAP002'],
  CondHole: ['GAP004'],
  ExprHole: ['GAP005'],
  RefHole: ['GAP007'],
  NameHole: ['GAP006', 'GAP008'],
  IntentStmt: ['GAP009'],
};

describe('analyze on random programs', () => {
  it('is deterministic and never throws', () => {
    fc.assert(
      fc.property(document, ({ program }) => {
        expect(analyze(program)).toEqual(analyze(program));
      }),
      { numRuns: 200 },
    );
  });

  it('reports every hole and word-only step exactly once, with the right code', () => {
    fc.assert(
      fc.property(document, ({ program }) => {
        const { diagnostics } = analyze(program);
        for (const node of allNodes(program)) {
          const expected = HOLE_CODES[node.kind];
          if (expected === undefined) continue;
          const about = diagnostics.filter((d) => d.nodeId === node.id && d.code.startsWith('GAP'));
          expect(about.map((d) => d.code).filter((c) => expected.includes(c))).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('reports every inferred node exactly once, as fitting or not', () => {
    fc.assert(
      fc.property(document, ({ program }) => {
        const { diagnostics } = analyze(program);
        for (const node of allNodes(program)) {
          const about = diagnostics.filter(
            (d) => d.nodeId === node.id && (d.code === 'INFO001' || d.code === 'WARN004'),
          );
          expect(about).toHaveLength(node.inferred === undefined ? 0 : 1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('only points at nodes in the program, in document order', () => {
    fc.assert(
      fc.property(document, ({ program }) => {
        const index = indexTree(program);
        const order = new Map(allNodes(program).map((node, i) => [node.id, i]));
        const { diagnostics, coverage } = analyze(program);
        for (const d of diagnostics) {
          expect(index.has(d.nodeId)).toBe(true);
          for (const id of d.related) expect(index.has(id)).toBe(true);
        }
        const positions = diagnostics.map((d) => order.get(d.nodeId) ?? -1);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(coverage.gaps).toBe(diagnostics.filter((d) => d.severity === 'gap').length);
      }),
      { numRuns: 200 },
    );
  });
});
