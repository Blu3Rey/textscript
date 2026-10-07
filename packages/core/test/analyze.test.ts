import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS,
  analyze,
  completesNormally,
  createBuilder,
  createUtterance,
  fallsThrough,
  type AnalyzeOptions,
  type Builder,
  type DiagnosticCode,
  type Expr,
  type Program,
  type Stmt,
} from '../src';
import { at, said } from './fixtures';

const S = said(0);

function program(build: (b: Builder) => Stmt[]): Program {
  const b = createBuilder();
  return b.program(build(b));
}

/** `[code, message]` pairs, in report order. */
function found(p: Program, options: AnalyzeOptions = {}): [DiagnosticCode, string][] {
  return analyze(p, options).diagnostics.map((d) => [d.code, d.message]);
}

function codes(p: Program, options: AnalyzeOptions = {}): DiagnosticCode[] {
  return analyze(p, options).diagnostics.map((d) => d.code);
}

function only(p: Program, code: DiagnosticCode, options: AnalyzeOptions = {}) {
  return analyze(p, options).diagnostics.filter((d) => d.code === code);
}

// Small constructors for compact programs.
function h(b: Builder) {
  return {
    n: (name: string) => b.name(name, S),
    lit: (value: number | boolean | string | null) => b.literal(value, S),
    blk: (...stmts: Stmt[]) => b.block(stmts),
    set: (name: string, value: Expr) => b.assign({ target: b.name(name, S), value }, S),
    ret: (value?: Expr) => b.return(value, S),
    show: (value: Expr) => b.exprStmt(value, S),
  };
}

describe('the catalog', () => {
  it('has 17 diagnostics, each with a unique name', () => {
    const entries = Object.values(DIAGNOSTICS);
    expect(entries).toHaveLength(17);
    expect(new Set(entries.map((e) => e.name)).size).toBe(17);
  });

  it('gives each code the severity its prefix says', () => {
    for (const [code, entry] of Object.entries(DIAGNOSTICS)) {
      const expected = code.startsWith('GAP')
        ? 'gap'
        : code.startsWith('WARN')
          ? 'warning'
          : 'info';
      expect(entry.severity).toBe(expected);
    }
  });
});

describe('an empty program', () => {
  it('has nothing to report', () => {
    expect(found(program(() => []))).toEqual([]);
  });
});

describe('GAP001 undeclared-name', () => {
  it('fires once per name, at its first use, listing the others', () => {
    const p = program((b) => {
      const x = h(b);
      return [x.set('total', b.binOp({ op: '+', left: x.n('seen'), right: x.n('seen') }, S))];
    });
    const [d] = only(p, 'GAP001');
    expect(d?.message).toBe('`seen` is used but never set up.');
    expect(d?.related).toHaveLength(1);
  });

  it('counts an update as a use', () => {
    const p = program((b) => [
      b.update({ target: b.name('count', S), op: '+=', value: b.literal(1, S) }, S),
    ]);
    expect(found(p)).toEqual([['GAP001', '`count` is used but never set up.']]);
  });

  it('stays quiet for set-up names, parameters, builtins and given inputs', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        x.set('limit', x.lit(3)),
        x.show(x.n('limit')),
        b.functionDef({ name: x.n('f'), params: [x.n('a')], body: x.blk(x.ret(x.n('a'))) }, S),
        x.show(b.call({ callee: x.n('len'), args: [x.n('nums')] }, S)),
      ];
    });
    expect(only(p, 'GAP001', { builtins: ['len'], inputs: ['nums'] })).toEqual([]);
    expect(only(p, 'GAP001').map((d) => d.message)).toEqual([
      '`len` is used but never set up.',
      '`nums` is used but never set up.',
    ]);
  });
});

describe('GAP002 empty-block', () => {
  it.each([
    [
      'the loop over `nums`',
      (b: Builder, body: ReturnType<Builder['block']>) =>
        b.forEach({ target: b.name('n', S), iterable: b.name('nums', S), body }, S),
    ],
    [
      'the `i` loop',
      (b: Builder, body: ReturnType<Builder['block']>) =>
        b.forRange({ target: b.name('i', S), stop: b.literal(3, S), body }, S),
    ],
    [
      'the while loop',
      (b: Builder, body: ReturnType<Builder['block']>) =>
        b.while({ cond: b.literal(true, S), body }, S),
    ],
    [
      'the if branch',
      (b: Builder, body: ReturnType<Builder['block']>) =>
        b.if({ cond: b.literal(true, S), body }, S),
    ],
    [
      'the function `f`',
      (b: Builder, body: ReturnType<Builder['block']>) =>
        b.functionDef({ name: b.name('f', S), params: [], body }, S),
    ],
  ])('names the owner: %s', (owner, make) => {
    const p = program((b) => [make(b, b.block([b.blockHole('not described')]))]);
    expect(only(p, 'GAP002').map((d) => d.message)).toEqual([
      `Nothing is described inside ${owner}.`,
    ]);
  });

  it('names else and elif branches', () => {
    const p = program((b) => [
      b.if(
        {
          cond: b.literal(true, S),
          body: b.block([b.break(S)]),
          elifs: [b.elif({ cond: b.literal(false, S), body: b.block([b.blockHole('x')]) }, S)],
          orelse: b.block([b.blockHole('y')]),
        },
        S,
      ),
    ]);
    expect(only(p, 'GAP002').map((d) => d.message)).toEqual([
      'Nothing is described inside the elif branch.',
      'Nothing is described inside the else branch.',
    ]);
  });

  it("quotes the owner's words when the hole has none", () => {
    const b = createBuilder();
    const p = b.program([
      b.while(
        { cond: b.literal(true, S), body: b.block([b.blockHole('x')]) },
        { provenance: [at(0, 2)] },
      ),
    ]);
    const [d] = only(p, 'GAP002', { utterances: [createUtterance('u1', 'keep going forever')] });
    expect(d?.quotes).toEqual(['keep going']);
  });

  it('stays quiet when blocks have steps', () => {
    expect(
      only(
        program((b) => [b.while({ cond: b.literal(true, S), body: b.block([b.break(S)]) }, S)]),
        'GAP002',
      ),
    ).toEqual([]);
  });
});

describe('GAP003 missing-return', () => {
  it('fires when a function returns something on some paths only', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.functionDef(
          {
            name: x.n('f'),
            params: [x.n('a')],
            body: x.blk(b.if({ cond: x.n('a'), body: x.blk(x.ret(x.lit(1))) }, S)),
          },
          S,
        ),
      ];
    });
    expect(only(p, 'GAP003').map((d) => d.message)).toEqual([
      "The function `f` doesn't say what it returns when it reaches the end.",
    ]);
  });

  it('fires for top-level code that returns something', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.forEach({ target: x.n('n'), iterable: x.n('nums'), body: x.blk(x.ret(x.lit(true))) }, S),
      ];
    });
    expect(only(p, 'GAP003', { inputs: ['nums'] }).map((d) => d.message)).toEqual([
      "The solution doesn't say what it returns when it reaches the end.",
    ]);
  });

  it('stays quiet when every path returns', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.functionDef(
          {
            name: x.n('f'),
            params: [x.n('a')],
            body: x.blk(
              b.if(
                { cond: x.n('a'), body: x.blk(x.ret(x.lit(1))), orelse: x.blk(x.ret(x.lit(0))) },
                S,
              ),
            ),
          },
          S,
        ),
        b.functionDef(
          {
            name: x.n('g'),
            params: [],
            body: x.blk(b.while({ cond: x.lit(true), body: x.blk(x.ret(x.lit(1))) }, S)),
          },
          S,
        ),
      ];
    });
    expect(only(p, 'GAP003')).toEqual([]);
  });

  it('stays quiet for functions that return nothing, such as in-place updates', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.functionDef(
          {
            name: x.n('f'),
            params: [x.n('a')],
            body: x.blk(b.update({ target: x.n('a'), op: 'append', value: x.lit(1) }, S), x.ret()),
          },
          S,
        ),
      ];
    });
    expect(only(p, 'GAP003')).toEqual([]);
  });
});

describe('holes', () => {
  it('GAP004, GAP005, GAP007, GAP008 report each hole with its reason', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.if({ cond: b.condHole('it is valid'), body: x.blk(b.break(S)) }, S),
        x.set('total', b.exprHole('the starting total')),
        x.show(b.refHole('nums or seen?', [])),
        b.update({ target: b.nameHole('which list?'), op: 'append', value: x.lit(1) }, S),
      ];
    });
    expect(found(p).filter(([c]) => c.startsWith('GAP'))).toEqual([
      ['GAP004', "This condition isn't stated: it is valid."],
      ['GAP005', "This value isn't described: the starting total."],
      ['GAP007', "It's unclear which is meant: nums or seen?"],
      ['GAP008', "This isn't named: which list?"],
    ]);
  });

  it('GAP006 reports an unnamed function input instead of GAP008', () => {
    const p = program((b) => [
      b.functionDef(
        {
          name: b.name('solve', S),
          params: [b.name('nums', S), b.nameHole('second input')],
          body: b.block([b.return(b.name('nums', S), S)]),
        },
        S,
      ),
    ]);
    expect(found(p)).toEqual([
      ['GAP006', "An input of the function `solve` isn't named: second input."],
    ]);
  });

  it('GAP009 reports a step described only in words', () => {
    const p = program((b) => [b.intent('process the element here', S)]);
    expect(found(p)).toEqual([
      [
        'GAP009',
        'This step is described in words but not how it works: "process the element here".',
      ],
    ]);
  });

  it('stay quiet when nothing is a hole', () => {
    const p = program((b) => [
      b.assign({ target: b.name('x', S), value: b.literal(1, S) }, S),
      b.exprStmt(b.name('x', S), S),
    ]);
    expect(found(p)).toEqual([]);
  });
});

describe('WARN001 unused-name', () => {
  it('fires for set-up names and inputs that are never used', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        x.set('unused', x.lit(1)),
        b.functionDef({ name: x.n('f'), params: [x.n('target')], body: x.blk(x.ret(x.lit(0))) }, S),
      ];
    });
    expect(only(p, 'WARN001').map((d) => d.message)).toEqual([
      '`unused` is set up but never used.',
      'The input `target` is never used.',
    ]);
  });

  it('stays quiet for used names, function names, loop variables and _names', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        x.set('count', x.lit(0)),
        b.forEach(
          {
            target: x.n('item'),
            iterable: x.n('items'),
            body: x.blk(b.update({ target: x.n('count'), op: '+=', value: x.lit(1) }, S)),
          },
          S,
        ),
        b.functionDef({ name: x.n('helper'), params: [], body: x.blk(x.ret(x.lit(1))) }, S),
        x.set('_ignored', x.lit(1)),
      ];
    });
    expect(only(p, 'WARN001', { inputs: ['items'] })).toEqual([]);
  });
});

describe('WARN002 unreachable', () => {
  it('fires for the first step after a return, break or ending if', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.forEach(
          {
            target: x.n('n'),
            iterable: x.n('nums'),
            body: x.blk(b.break(S), x.show(x.n('n')), x.show(x.n('n'))),
          },
          S,
        ),
        b.if(
          { cond: x.n('nums'), body: x.blk(x.ret(x.lit(1))), orelse: x.blk(x.ret(x.lit(0))) },
          S,
        ),
        x.show(x.n('nums')),
      ];
    });
    expect(only(p, 'WARN002', { inputs: ['nums'] }).map((d) => d.message)).toEqual([
      'This step comes after `break` and can never run.',
      'This step comes after an `if` whose every branch ends early and can never run.',
    ]);
  });

  it('names continue and endless loops as the reason', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.forEach(
          { target: x.n('n'), iterable: x.n('nums'), body: x.blk(b.continue(S), x.show(x.n('n'))) },
          S,
        ),
        b.while({ cond: x.lit(true), body: x.blk(x.show(x.n('nums'))) }, S),
        x.show(x.n('nums')),
      ];
    });
    expect(only(p, 'WARN002', { inputs: ['nums'] }).map((d) => d.message)).toEqual([
      'This step comes after `continue` and can never run.',
      'This step comes after a loop that never ends and can never run.',
    ]);
  });

  it('stays quiet after an if without else, and for a final return', () => {
    const p = program((b) => {
      const x = h(b);
      return [b.if({ cond: x.n('nums'), body: x.blk(x.ret(x.lit(1))) }, S), x.ret(x.lit(0))];
    });
    expect(only(p, 'WARN002', { inputs: ['nums'] })).toEqual([]);
  });
});

describe('WARN003 shadowing', () => {
  it('fires when a function sets up a name that hides an outer one', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        x.set('count', x.lit(0)),
        x.show(x.n('count')),
        b.functionDef(
          {
            name: x.n('f'),
            params: [],
            body: x.blk(x.set('count', x.lit(1)), x.ret(x.n('count'))),
          },
          S,
        ),
      ];
    });
    expect(only(p, 'WARN003').map((d) => d.message)).toEqual([
      '`count` is set up inside the function `f`, hiding the `count` outside it.',
    ]);
  });

  it('stays quiet for parameters and for setting a name again in the same scope', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        x.set('nums', x.lit(0)),
        x.set('nums', x.lit(1)),
        x.show(x.n('nums')),
        b.functionDef(
          { name: x.n('f'), params: [x.n('nums')], body: x.blk(x.ret(x.n('nums'))) },
          S,
        ),
      ];
    });
    expect(only(p, 'WARN003')).toEqual([]);
  });
});

describe('INFO001 inferred and WARN004 unsupported-inference', () => {
  it('reports each inference that fits its rule', () => {
    const p = program((b) => [
      b.forEach(
        {
          target: b.name('num', { inferred: 'INF-LOOPVAR' }),
          iterable: b.name('nums', { ...S, inferred: 'INF-PLURAL-NAME' }),
          body: b.block([
            b.update(
              { target: b.name('seen', S), op: 'add', value: b.name('num', S) },
              { ...S, inferred: 'INF-SYNONYM' },
            ),
          ]),
        },
        S,
      ),
      b.forRange(
        {
          target: b.name('i', { inferred: 'INF-INDEXVAR' }),
          stop: b.call(
            { callee: b.name('len', S), args: [b.name('nums', S)] },
            { inferred: 'INF-RANGE-BOUNDS' },
          ),
          body: b.block([b.break(S)]),
        },
        S,
      ),
      b.return(undefined, { ...S, inferred: 'INF-BLOCK-END' }),
    ]);
    const infos = only(p, 'INFO001', { inputs: ['nums', 'seen'], builtins: ['len'] });
    expect(infos.map((d) => d.message.slice(0, d.message.indexOf(')') + 1))).toEqual([
      'Inferred (INF-LOOPVAR)',
      'Inferred (INF-PLURAL-NAME)',
      'Inferred (INF-SYNONYM)',
      'Inferred (INF-INDEXVAR)',
      'Inferred (INF-RANGE-BOUNDS)',
      'Inferred (INF-BLOCK-END)',
    ]);
    expect(only(p, 'WARN004')).toEqual([]);
  });

  it('warns about inferences that do not fit', () => {
    const p = program((b) => [
      // A loop variable rule on an assignment, an index name that isn't i/j/k,
      // and a synonym with no words behind it.
      b.assign({ target: b.name('x', { inferred: 'INF-LOOPVAR' }), value: b.literal(1, S) }, S),
      b.forRange(
        {
          target: b.name('idx', { inferred: 'INF-INDEXVAR' }),
          stop: b.literal(3, S),
          body: b.block([b.break(S)]),
        },
        S,
      ),
      b.update(
        { target: b.name('s', S), op: 'add', value: b.name('x', S) },
        { inferred: 'INF-SYNONYM' },
      ),
    ]);
    expect(only(p, 'WARN004', { inputs: ['s'] }).map((d) => d.message)).toEqual([
      "Marked as inferred by INF-LOOPVAR, but it doesn't fit that rule.",
      "Marked as inferred by INF-INDEXVAR, but it doesn't fit that rule.",
      "Marked as inferred by INF-SYNONYM, but it doesn't fit that rule.",
    ]);
  });

  it('warns when a loop variable is not named after its collection', () => {
    const p = program((b) => [
      b.forEach(
        {
          target: b.name('item', { inferred: 'INF-LOOPVAR' }),
          iterable: b.name('nums', S),
          body: b.block([b.break(S)]),
        },
        S,
      ),
    ]);
    expect(codes(p, { inputs: ['nums'] })).toContain('WARN004');
  });
});

describe('WARN005 used-before-set', () => {
  it('fires when a name is used before it is first set up, in the same scope', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.forEach(
          {
            target: x.n('n'),
            iterable: x.n('nums'),
            body: x.blk(
              x.show(b.binOp({ op: '-', left: x.n('n'), right: x.n('prev') }, S)),
              x.set('prev', x.n('n')),
            ),
          },
          S,
        ),
      ];
    });
    expect(only(p, 'WARN005', { inputs: ['nums'] }).map((d) => d.message)).toEqual([
      '`prev` is used before it is set up.',
    ]);
  });

  it('stays quiet when a problem input is reassigned after being used', () => {
    const p = program((b) => {
      const x = h(b);
      return [x.set('nums', b.call({ callee: x.n('sorted'), args: [x.n('nums')] }, S))];
    });
    expect(only(p, 'WARN005', { inputs: ['nums'] })).toEqual([]);
    expect(only(p, 'WARN005').map((d) => d.message)).toEqual([
      '`nums` is used before it is set up.',
    ]);
  });

  it('stays quiet when a function uses a name set up later outside it', () => {
    const p = program((b) => {
      const x = h(b);
      return [
        b.functionDef({ name: x.n('f'), params: [], body: x.blk(x.ret(x.n('limit'))) }, S),
        x.set('limit', x.lit(3)),
      ];
    });
    expect(only(p, 'WARN005')).toEqual([]);
  });
});

describe('WARN006 jump-outside-loop', () => {
  it('fires for break and continue outside a loop, including in a function inside one', () => {
    const p = program((b) => [
      b.break(S),
      b.forEach(
        {
          target: b.name('n', S),
          iterable: b.name('nums', S),
          body: b.block([
            b.functionDef({ name: b.name('f', S), params: [], body: b.block([b.continue(S)]) }, S),
          ]),
        },
        S,
      ),
    ]);
    expect(only(p, 'WARN006', { inputs: ['nums'] }).map((d) => d.message)).toEqual([
      '`break` is not inside a loop.',
      '`continue` is not inside a loop.',
    ]);
  });

  it('stays quiet for jumps inside loops, nested in ifs', () => {
    const p = program((b) => [
      b.while(
        {
          cond: b.literal(true, S),
          body: b.block([b.if({ cond: b.literal(true, S), body: b.block([b.break(S)]) }, S)]),
        },
        S,
      ),
    ]);
    expect(only(p, 'WARN006')).toEqual([]);
  });
});

describe('WARN007 duplicate-parameter', () => {
  it('fires for the second input with the same name', () => {
    const p = program((b) => [
      b.functionDef(
        {
          name: b.name('f', S),
          params: [b.name('a', S), b.name('a', S)],
          body: b.block([b.return(b.name('a', S), S)]),
        },
        S,
      ),
    ]);
    expect(only(p, 'WARN007').map((d) => d.message)).toEqual([
      'The function `f` has two inputs named `a`.',
    ]);
  });

  it('stays quiet for distinct inputs', () => {
    const p = program((b) => [
      b.functionDef(
        {
          name: b.name('f', S),
          params: [b.name('a', S), b.name('b', S)],
          body: b.block([
            b.return(b.binOp({ op: '+', left: b.name('a', S), right: b.name('b', S) }, S), S),
          ]),
        },
        S,
      ),
    ]);
    expect(only(p, 'WARN007')).toEqual([]);
  });
});

describe('diagnostics', () => {
  it('come in document order', () => {
    const p = program((b) => [
      b.exprStmt(b.exprHole('first'), S),
      b.exprStmt(b.name('undeclared', S), S),
      b.exprStmt(b.exprHole('last'), S),
    ]);
    expect(codes(p)).toEqual(['GAP005', 'GAP001', 'GAP005']);
  });

  it('quote the words of their spans when given utterances', () => {
    const b = createBuilder();
    const p = b.program([b.exprStmt(b.name('seen', { provenance: [at(3, 4)] }), S)]);
    const utterances = [createUtterance('u1', "If we've already seen it")];
    expect(analyze(p, { utterances }).diagnostics[0]).toMatchObject({
      spans: [at(3, 4)],
      quotes: ['seen'],
    });
    expect(analyze(p).diagnostics[0]?.quotes).toEqual([]);
  });

  it('never suggest a fix', () => {
    const p = program((b) => [
      b.exprStmt(b.name('x', S), S),
      b.if({ cond: b.condHole('c'), body: b.block([b.blockHole('b')]) }, S),
      b.return(b.literal(1, S), S),
      b.break(S),
    ]);
    for (const d of analyze(p).diagnostics) {
      expect(d.message).not.toMatch(/\b(add|should|try|consider|use `|set up `)/i);
    }
  });
});

describe('flow', () => {
  const b = createBuilder();
  const blk = (...stmts: Stmt[]) => b.block(stmts);

  it('knows which statements end a path', () => {
    expect(completesNormally(b.return(undefined, S))).toBe(false);
    expect(completesNormally(b.break(S))).toBe(false);
    expect(
      completesNormally(b.if({ cond: b.literal(true, S), body: blk(b.return(undefined, S)) }, S)),
    ).toBe(true);
    expect(
      completesNormally(
        b.if(
          {
            cond: b.literal(true, S),
            body: blk(b.return(undefined, S)),
            orelse: blk(b.continue(S)),
          },
          S,
        ),
      ),
    ).toBe(false);
    expect(
      completesNormally(
        b.while({ cond: b.literal(true, S), body: blk(b.exprStmt(b.name('x', S), S)) }, S),
      ),
    ).toBe(false);
    expect(
      completesNormally(
        b.while(
          {
            cond: b.literal(true, S),
            body: blk(b.if({ cond: b.name('x', S), body: blk(b.break(S)) }, S)),
          },
          S,
        ),
      ),
    ).toBe(true);
    // A break in a nested loop leaves that loop, not the outer `while True`.
    const nested = b.forEach(
      { target: b.name('n', S), iterable: b.name('xs', S), body: blk(b.break(S)) },
      S,
    );
    expect(completesNormally(b.while({ cond: b.literal(true, S), body: blk(nested) }, S))).toBe(
      false,
    );
    expect(
      completesNormally(
        b.while({ cond: b.name('going', S), body: blk(b.exprStmt(b.name('x', S), S)) }, S),
      ),
    ).toBe(true);
    expect(fallsThrough([b.exprStmt(b.name('x', S), S)])).toBe(true);
    expect(fallsThrough(blk(b.return(undefined, S)))).toBe(false);
  });
});

describe('coverage', () => {
  it('reports what an explanation has covered', () => {
    const b = createBuilder();
    const complexity = b.note('linear', 'complexity', [at(0)]);
    const edgeCase = b.note('empty list returns it', 'edge-case', [at(1)]);
    const p = b.program([
      b.functionDef(
        {
          name: b.name('f', S),
          params: [b.name('nums', S)],
          body: b.block([b.return(b.name('nums', S), S)]),
        },
        { ...S, notes: [complexity, edgeCase] },
      ),
    ]);
    const { coverage } = analyze(p);
    expect(coverage).toEqual({
      approach: true,
      inputs: 'named',
      inputNames: ['nums'],
      returns: 'all-paths',
      edgeCases: [edgeCase.id],
      complexity: [complexity.id],
      gaps: 0,
    });
  });

  it('starts empty', () => {
    expect(analyze(program(() => [])).coverage).toEqual({
      approach: false,
      inputs: 'unknown',
      inputNames: [],
      returns: 'none',
      edgeCases: [],
      complexity: [],
      gaps: 0,
    });
  });

  it('uses given inputs when there is no function, and flags unnamed ones', () => {
    expect(
      analyze(
        program((b) => [b.exprStmt(b.name('nums', S), S)]),
        { inputs: ['nums'] },
      ).coverage.inputs,
    ).toBe('named');
    const unnamed = program((b) => [
      b.functionDef(
        {
          name: b.name('f', S),
          params: [b.nameHole('input')],
          body: b.block([b.return(undefined, S)]),
        },
        S,
      ),
    ]);
    expect(analyze(unnamed).coverage).toMatchObject({
      inputs: 'unnamed',
      returns: 'none',
      gaps: 1,
    });
  });

  it('says when only some paths return', () => {
    const p = program((b) => [
      b.if({ cond: b.literal(true, S), body: b.block([b.return(b.literal(1, S), S)]) }, S),
    ]);
    expect(analyze(p).coverage.returns).toBe('some-paths');
  });
});
