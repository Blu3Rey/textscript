import { allNodes, createBuilder, type IrNode, type Program, type Stmt } from '@textscript/core';
import { arbitraries } from '@textscript/core/testing';
import { render } from '@textscript/render-python';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SnippetError,
  parseCondition,
  parseExpression,
  parseStatements,
  type SnippetOptions,
} from '../src/snippet';

const SPAN = [{ utteranceId: 'u1', start: 0, end: 4 }];

function options(): SnippetOptions {
  let n = 0;
  return { nextId: () => `t${String(++n)}`, provenance: SPAN, utteranceId: 'u1' };
}

/** Parses statements and renders them, for compact assertions. */
function roundtrip(text: string, mode: 'export' | 'ui' = 'export'): string {
  const b = createBuilder();
  return render(b.program(parseStatements(text, options())), { mode }).text;
}

function kinds(stmts: readonly IrNode[]): string[] {
  return stmts.map((s) => s.kind);
}

describe('statements', () => {
  it('parse blocks by indentation and one-line bodies', () => {
    const text = [
      'for n in nums:',
      '    if n in seen: return True',
      '    seen.add(n)',
      'return False',
    ].join('\n');
    expect(roundtrip(text)).toBe(
      [
        'for n in nums:',
        '    if n in seen:',
        '        return True',
        '    seen.add(n)',
        'return False',
        '',
      ].join('\n'),
    );
  });

  it('attach elif and else to the if before them', () => {
    const stmts = parseStatements(
      ['if a: x = 1', 'elif b:', '    x = 2', 'else: x = 3'].join('\n'),
      options(),
    );
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      kind: 'If',
      elifs: [{ kind: 'Elif' }],
      orelse: { kind: 'Block' },
    });
  });

  it('turn an empty body or "..." into a block hole', () => {
    expect(roundtrip('while running:', 'ui')).toBe('while running:\n    ⟨body not described⟩\n');
    expect(roundtrip('while running: ...', 'ui')).toBe(
      'while running:\n    ⟨body not described⟩\n',
    );
  });

  it('read range() loops, updates and word-only steps', () => {
    const [loop, update, aug, intent] = parseStatements(
      [
        'for i in range(1, n, 2): ...',
        'items.append(x)',
        'count += 1',
        'intent process the element here',
      ].join('\n'),
      options(),
    );
    expect(loop).toMatchObject({
      kind: 'ForRange',
      start: { value: 1 },
      stop: { name: 'n' },
      step: { value: 2 },
    });
    expect(update).toMatchObject({
      kind: 'Update',
      op: 'append',
      target: { name: 'items' },
      value: { name: 'x' },
    });
    expect(aug).toMatchObject({ kind: 'Update', op: '+=' });
    expect(intent).toMatchObject({ kind: 'IntentStmt', text: 'process the element here' });
  });

  it('keep a variable named intent a variable', () => {
    expect(kinds(parseStatements('intent = 1\nintent', options()))).toEqual(['Assign', 'ExprStmt']);
  });

  it('read functions with named and unnamed inputs', () => {
    const [fn] = parseStatements('def solve(nums, ?"second input"):\n    return nums', options());
    expect(fn).toMatchObject({
      kind: 'FunctionDef',
      name: { name: 'solve' },
      params: [{ kind: 'Name' }, { kind: 'NameHole', reason: 'second input' }],
    });
  });
});

describe('holes', () => {
  it('take their kind from their position', () => {
    const [ifStmt, assign, loop] = parseStatements(
      ['if ?: break', 'x = ?', 'for ? in items: ...'].join('\n'),
      options(),
    );
    expect(ifStmt).toMatchObject({ cond: { kind: 'CondHole', reason: 'condition not described' } });
    expect(assign).toMatchObject({ value: { kind: 'ExprHole', reason: 'value not described' } });
    expect(loop).toMatchObject({ target: { kind: 'NameHole', reason: 'name not given' } });
  });

  it('can be given a kind, a reason and candidates', () => {
    expect(parseExpression('?name"which list?"', options())).toMatchObject({
      kind: 'NameHole',
      reason: 'which list?',
    });
    expect(parseExpression('?cond', options())).toMatchObject({ kind: 'CondHole' });
    expect(parseExpression('?ref(n3, n7)"nums or seen?"', options())).toMatchObject({
      kind: 'RefHole',
      candidates: ['n3', 'n7'],
      reason: 'nums or seen?',
    });
    expect(parseCondition('?"it is valid"', options())).toMatchObject({
      kind: 'CondHole',
      reason: 'it is valid',
    });
  });

  it('get no provenance unless given a span', () => {
    expect(parseExpression('?', options()).provenance).toEqual([]);
    expect(parseExpression('?@1:2', options()).provenance).toEqual([
      { utteranceId: 'u1', start: 1, end: 2 },
    ]);
  });
});

describe('annotations', () => {
  it('mark inferences and spans on nodes and statements', () => {
    const [loop] = parseStatements(
      'for num~loopvar in nums@2:6~plural:  # @0:6\n    seen.add(num)  # ~synonym',
      options(),
    );
    expect(loop).toMatchObject({
      kind: 'ForEach',
      provenance: [{ start: 0, end: 6 }],
      target: { inferred: 'INF-LOOPVAR', provenance: SPAN },
      iterable: { inferred: 'INF-PLURAL-NAME', provenance: [{ start: 2, end: 6 }] },
      body: { stmts: [{ kind: 'Update', inferred: 'INF-SYNONYM' }] },
    });
  });

  it('give nodes the default provenance and blocks none', () => {
    const [stmt] = parseStatements('while x: ...', options());
    expect(stmt).toMatchObject({
      provenance: SPAN,
      cond: { provenance: SPAN },
      body: { provenance: [] },
    });
  });

  it('allow several spans on one node', () => {
    expect(parseExpression('set()@1:2@4:5', options()).provenance).toEqual([
      { utteranceId: 'u1', start: 1, end: 2 },
      { utteranceId: 'u1', start: 4, end: 5 },
    ]);
  });
});

describe('expressions', () => {
  it.each([
    ['-5 ** 2', { kind: 'UnaryOp', op: '-', operand: { kind: 'BinOp', op: '**' } }],
    [
      '-0()',
      {
        kind: 'UnaryOp',
        op: '-',
        operand: { kind: 'Call', callee: { kind: 'Literal', value: 0 } },
      },
    ],
    ['-2[0]', { kind: 'UnaryOp', op: '-', operand: { kind: 'Index' } }],
    ['(-5) ** 2', { kind: 'BinOp', left: { kind: 'Literal', value: -5 } }],
    ['x is None', { kind: 'Compare', op: '==', right: { value: null } }],
    ['x is not None', { kind: 'Compare', op: '!=' }],
    ['x not in seen', { kind: 'Membership', negated: true }],
    ['a or b or c', { kind: 'BoolOp', op: 'or', operands: [{}, {}, {}] }],
    ['(a and b) and c', { kind: 'BoolOp', operands: [{ kind: 'BoolOp' }, { kind: 'Name' }] }],
    ['float("-inf")', { kind: 'InfinityLiteral', negative: true }],
    ['set()', { kind: 'CollectionLiteral', collection: 'set', elements: [] }],
    ['{1, 2}', { kind: 'CollectionLiteral', collection: 'set' }],
    ['{}', { kind: 'DictLiteral', entries: [] }],
    [
      '{"a": 1, k: []}',
      { kind: 'DictLiteral', entries: [{ key: { value: 'a' } }, { key: { name: 'k' } }] },
    ],
    ['(a,)', { kind: 'CollectionLiteral', collection: 'tuple', elements: [{}] }],
    ['s[1:]', { kind: 'Slice', start: { value: 1 } }],
    ['s[::2]', { kind: 'Slice', step: { value: 2 } }],
    ['grid[r][c]', { kind: 'Index', object: { kind: 'Index' } }],
    ['__hole__("vague")', { kind: 'ExprHole', reason: 'vague' }],
    ['"say \\"hi\\"\\n\\x00"', { kind: 'Literal', value: 'say "hi"\n\0' }],
  ])('%s', (text, shape) => {
    expect(parseExpression(text, options())).toMatchObject(shape);
  });
});

describe('errors', () => {
  it.each([
    ['a < b < c', /Chained comparisons/],
    ['pass', /Use "\.\.\."/],
    ['if x', /Expected ":"/],
    ['elif x: y', /needs an "if"/],
    ['  x = 1\ny = 2', /dedent/],
    ['x = 1\n    y = 2', /Unexpected indent/],
    ['if x: y\n    z', /same line or indented/],
    ['x~bogus', /Unknown inference/],
    ['x = "open', /Unterminated string/],
    ['x = $', /Unexpected character/],
    ['f(a, b', /Expected/],
    ['1 = x', /Can't assign/],
    ['for 1 in xs: ...', /Expected a name/],
  ])('%s', (text, message) => {
    expect(() => parseStatements(text, options())).toThrow(message);
  });

  it('name the line that failed', () => {
    expect(() => parseStatements('x = 1\ny = )', options())).toThrow(/^Line 2: /);
  });

  it('need an utterance for spans', () => {
    expect(() => parseExpression('x@1:2', { nextId: () => 't1' })).toThrow(SnippetError);
  });
});

/** Removes what export rendering can't carry back: notes. */
function withoutNotes(program: Program): Program {
  const copy = structuredClone(program);
  for (const node of allNodes(copy)) Reflect.deleteProperty(node, 'notes');
  return copy;
}

describe('reading exported code back', () => {
  it('gives the same code: render → parse → render is a fixpoint', () => {
    fc.assert(
      fc.property(arbitraries.document, ({ program }) => {
        const nodes = allNodes(program);
        fc.pre(program.body.length > 0);
        // Word-only steps render as a comment, which isn't read back.
        fc.pre(!nodes.some((n) => n.kind === 'IntentStmt'));
        // TODO comments join reasons with "; " and trim them.
        fc.pre(
          nodes.every(
            (n) => !('reason' in n) || (n.reason.trim() === n.reason && !n.reason.includes(';')),
          ),
        );
        const text = render(withoutNotes(program)).text;
        const reparsed: Stmt[] = parseStatements(text, options());
        // Placeholder names carry the hole's node ID, which differs after parsing.
        const anonymous = (code: string) => code.replaceAll(/__hole_[nt]\d+__/g, '__hole_id__');
        expect(anonymous(render(createBuilder().program(reparsed)).text)).toBe(anonymous(text));
      }),
      { numRuns: 300 },
    );
  });
});
