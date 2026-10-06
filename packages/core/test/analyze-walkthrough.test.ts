// The worked example from ROADMAP.md §3.6, played through a real session:
// four utterances, each an edit batch, analyzed after every step. The
// problem gives `nums` as its input.

import { describe, expect, it } from 'vitest';
import {
  allNodes,
  analyze,
  applyEvent,
  createUtterance,
  emptySession,
  type DiagnosticCode,
  type EditOp,
  type IrNode,
  type SessionState,
  type Span,
} from '../src';

const sp = (utteranceId: string, start: number, end: number): Span[] => [
  { utteranceId, start, end },
];

function find(state: SessionState, predicate: (node: IrNode) => boolean): IrNode {
  const node = allNodes(state.document.program).find(predicate);
  if (node === undefined) throw new Error('node not found');
  return node;
}

function say(
  state: SessionState,
  id: string,
  text: string,
  ops: (state: SessionState) => EditOp[],
): SessionState {
  const utterance = createUtterance(id, text);
  const result = applyEvent(state, {
    type: 'edit',
    utterance,
    batch: { utteranceId: id, ops: ops(state) },
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state;
}

function report(
  state: SessionState,
): { code: DiagnosticCode; message: string; quotes: string[] }[] {
  return analyze(state.document.program, {
    inputs: ['nums'],
    utterances: state.utterances,
  }).diagnostics.map(({ code, message, quotes }) => ({ code, message, quotes }));
}

const LOOPVAR = {
  code: 'INFO001',
  message: "Inferred (INF-LOOPVAR): the loop variable is named after the collection's name.",
  quotes: [],
} as const;
const PLURAL = {
  code: 'INFO001',
  message:
    'Inferred (INF-PLURAL-NAME): a collection is named in the plural from the item the user named.',
  quotes: ['the list of numbers'],
} as const;
const NO_RETURN = {
  code: 'GAP003',
  message: "The solution doesn't say what it returns when it reaches the end.",
  quotes: [],
} as const;

describe('the worked example', () => {
  // u1: "Loop through the list of numbers."
  const step1 = say(emptySession(), 'u1', 'Loop through the list of numbers.', (s) => [
    {
      op: 'add_stmt',
      parent: s.document.program.id,
      position: { at: 'end' },
      stmt: {
        kind: 'ForEach',
        id: 't1',
        target: { kind: 'Name', id: 't2', name: 'num', provenance: [], inferred: 'INF-LOOPVAR' },
        iterable: {
          kind: 'Name',
          id: 't3',
          name: 'nums',
          provenance: sp('u1', 2, 6),
          inferred: 'INF-PLURAL-NAME',
        },
        body: {
          kind: 'Block',
          id: 't4',
          stmts: [{ kind: 'BlockHole', id: 't5', reason: 'body not described', provenance: [] }],
          provenance: [],
        },
        provenance: sp('u1', 0, 6),
      },
    },
  ]);

  // u2: "If we've already seen the number, return true."
  const step2 = say(step1, 'u2', "If we've already seen the number, return true.", (s) => [
    {
      op: 'fill_hole',
      hole: find(s, (n) => n.kind === 'BlockHole').id,
      value: [
        {
          kind: 'If',
          id: 't1',
          cond: {
            kind: 'Membership',
            id: 't2',
            negated: false,
            element: { kind: 'Name', id: 't3', name: 'num', provenance: sp('u2', 4, 6) },
            container: { kind: 'Name', id: 't4', name: 'seen', provenance: sp('u2', 3, 4) },
            provenance: sp('u2', 1, 6),
          },
          body: {
            kind: 'Block',
            id: 't5',
            stmts: [
              {
                kind: 'Return',
                id: 't6',
                value: { kind: 'Literal', id: 't7', value: true, provenance: sp('u2', 8, 9) },
                provenance: sp('u2', 7, 9),
              },
            ],
            provenance: [],
          },
          elifs: [],
          provenance: sp('u2', 0, 9),
        },
      ],
    },
  ]);

  // u3: "Oh, we keep a set called seen, empty at the start."
  const step3 = say(step2, 'u3', 'Oh, we keep a set called seen, empty at the start.', (s) => [
    {
      op: 'add_stmt',
      parent: s.document.program.id,
      position: { at: 'start' },
      stmt: {
        kind: 'Assign',
        id: 't1',
        target: { kind: 'Name', id: 't2', name: 'seen', provenance: sp('u3', 7, 8) },
        value: {
          kind: 'CollectionLiteral',
          id: 't3',
          collection: 'set',
          elements: [],
          provenance: [...sp('u3', 4, 6), ...sp('u3', 9, 10)],
        },
        provenance: sp('u3', 2, 13),
      },
    },
  ]);

  // u4: "Otherwise add it to the set."
  const step4 = say(step3, 'u4', 'Otherwise add it to the set.', (s) => [
    {
      op: 'update_field',
      node: find(s, (n) => n.kind === 'If').id,
      field: 'orelse',
      value: {
        kind: 'Block',
        id: 't1',
        stmts: [
          {
            kind: 'Update',
            id: 't2',
            target: { kind: 'Name', id: 't3', name: 'seen', provenance: sp('u4', 4, 6) },
            op: 'add',
            value: { kind: 'Name', id: 't4', name: 'num', provenance: sp('u4', 2, 3) },
            provenance: sp('u4', 1, 6),
            inferred: 'INF-SYNONYM',
          },
        ],
        provenance: sp('u4', 0, 1),
      },
      provenance: sp('u4', 0, 1),
    },
  ]);

  it('step 1: the loop body is a gap, and two names were inferred', () => {
    expect(report(step1)).toEqual([
      LOOPVAR,
      PLURAL,
      {
        code: 'GAP002',
        message: 'Nothing is described inside the loop over `nums`.',
        quotes: ['Loop through the list of numbers'],
      },
    ]);
  });

  it('step 2: `seen` was never set up, and nothing is returned at the end', () => {
    expect(report(step2)).toEqual([
      NO_RETURN,
      LOOPVAR,
      PLURAL,
      { code: 'GAP001', message: '`seen` is used but never set up.', quotes: ['seen'] },
    ]);
  });

  it('step 3: setting up `seen` closes that gap', () => {
    expect(report(step3)).toEqual([NO_RETURN, LOOPVAR, PLURAL]);
  });

  it('step 4: the else branch is a synonym inference; the missing return remains', () => {
    expect(report(step4)).toEqual([
      NO_RETURN,
      LOOPVAR,
      PLURAL,
      {
        code: 'INFO001',
        message: 'Inferred (INF-SYNONYM): a common synonym is mapped to one operation.',
        quotes: ['add it to the set'],
      },
    ]);
  });

  it('ends with the coverage the walkthrough earned', () => {
    expect(analyze(step4.document.program, { inputs: ['nums'] }).coverage).toEqual({
      approach: true,
      inputs: 'named',
      inputNames: ['nums'],
      returns: 'some-paths',
      edgeCases: [],
      complexity: [],
      gaps: 1,
    });
  });

  it('flags `nums` too when the problem’s inputs are not given', () => {
    const codes = analyze(step4.document.program).diagnostics.map((d) => d.code);
    expect(codes).toContain('GAP001');
  });
});
