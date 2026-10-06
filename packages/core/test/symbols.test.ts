import { describe, expect, it } from 'vitest';
import {
  allNodes,
  buildSymbolTable,
  createBuilder,
  symbolAt,
  type Name,
  type Program,
  type Stmt,
  type SymbolTable,
} from '../src';
import { said, workedExample } from './fixtures';

function programOf(build: (b: ReturnType<typeof createBuilder>) => Stmt[]): Program {
  const b = createBuilder();
  return b.program(build(b));
}

/** Symbol names with their definition and use counts, for compact assertions. */
function summary(table: SymbolTable) {
  return table.symbols.map((s) => ({
    id: s.id,
    defs: s.definitions.length,
    uses: s.uses.length,
  }));
}

/** Like `summary`, keyed by name, for tests that don't track scope IDs. */
function byName(table: SymbolTable) {
  return table.symbols.map((s) => ({
    name: s.name,
    defs: s.definitions.length,
    uses: s.uses.length,
  }));
}

function resolutionOf(table: SymbolTable, name: string) {
  return table.references.filter((ref) => ref.name === name).map((ref) => ref.resolution.kind);
}

describe('buildSymbolTable', () => {
  describe('the worked example', () => {
    const program = workedExample().program;
    const table = buildSymbolTable(program);

    it('has one module scope', () => {
      expect(table.scopes).toEqual([{ id: program.id, kind: 'module' }]);
    });

    it('finds the definitions and uses of each name', () => {
      expect(summary(table)).toEqual([
        { id: `${program.id}:seen`, defs: 1, uses: 2 },
        { id: `${program.id}:num`, defs: 1, uses: 2 },
      ]);
    });

    it('leaves names that were never introduced unresolved', () => {
      // `nums` is the gap the analyzer will report: it's never set up.
      expect(resolutionOf(table, 'nums')).toEqual(['unresolved']);
    });

    it('orders occurrences by evaluation', () => {
      const seen = table.symbols[0];
      const definition = seen?.definitions[0]?.order ?? Infinity;
      expect(seen?.uses.every((use) => use.order > definition)).toBe(true);
    });
  });

  it('evaluates an assignment value before binding its target', () => {
    const table = buildSymbolTable(
      programOf((b) => [
        b.assign(
          {
            target: b.name('x', said(0)),
            value: b.binOp(
              { op: '+', left: b.name('x', said(2)), right: b.literal(1, said(4)) },
              said(2, 5),
            ),
          },
          said(0, 5),
        ),
      ]),
    );
    const [symbol] = table.symbols;
    expect(symbol?.uses[0]?.order).toBeLessThan(symbol?.definitions[0]?.order ?? -1);
  });

  it('treats an update of a name as a use, not a definition', () => {
    const table = buildSymbolTable(
      programOf((b) => [
        b.update(
          { target: b.name('count', said(0)), op: '+=', value: b.literal(1, said(2)) },
          said(0, 3),
        ),
      ]),
    );
    expect(table.symbols).toEqual([]);
    expect(resolutionOf(table, 'count')).toEqual(['unresolved']);
  });

  it('treats the object of an indexed target as a use', () => {
    const table = buildSymbolTable(
      programOf((b) => [
        b.assign({ target: b.name('counts', said(0)), value: b.dict([], said(2)) }, said(0, 3)),
        b.assign(
          {
            target: b.index(
              { object: b.name('counts', said(4)), index: b.name('key', said(5)) },
              said(4, 6),
            ),
            value: b.literal(0, said(7)),
          },
          said(4, 8),
        ),
      ]),
    );
    expect(byName(table)).toEqual([{ name: 'counts', defs: 1, uses: 1 }]);
    expect(resolutionOf(table, 'key')).toEqual(['unresolved']);
  });

  describe('functions', () => {
    const b = createBuilder();
    const limit = b.name('limit', said(0));
    const fn = b.functionDef(
      {
        name: b.name('solve', said(1)),
        params: [b.name('nums', said(2)), b.nameHole('second input not described')],
        body: b.block([
          b.exprStmt(b.name('total', said(3)), said(3)),
          b.assign(
            { target: b.name('total', said(4)), value: b.name('limit', said(5)) },
            said(4, 6),
          ),
          b.return(b.name('nums', said(7)), said(6, 8)),
        ]),
      },
      said(1, 8),
    );
    const program = b.program([
      b.assign({ target: limit, value: b.literal(10, said(9)) }, said(0, 10)),
      fn,
    ]);
    const table = buildSymbolTable(program);

    it('create a scope nested in the module', () => {
      expect(table.scopes).toEqual([
        { id: program.id, kind: 'module' },
        { id: fn.id, kind: 'function', parent: program.id },
      ]);
    });

    it('define their name outside and their parameters inside', () => {
      expect(summary(table)).toEqual([
        { id: `${program.id}:limit`, defs: 1, uses: 1 },
        { id: `${program.id}:solve`, defs: 1, uses: 0 },
        { id: `${fn.id}:nums`, defs: 1, uses: 1 },
        { id: `${fn.id}:total`, defs: 1, uses: 1 },
      ]);
    });

    it('resolve outer names through the enclosing scope', () => {
      const ref = table.references.find((r) => r.name === 'limit');
      expect(ref?.resolution).toEqual({ kind: 'symbol', symbolId: `${program.id}:limit` });
    });

    it('make a name local if it is assigned anywhere in the function', () => {
      // Python rule: `total` is local even where it's used before assignment.
      const ref = table.references.find((r) => r.name === 'total');
      expect(ref?.resolution).toEqual({ kind: 'symbol', symbolId: `${fn.id}:total` });
    });
  });

  it('resolves builtins only when they are supplied', () => {
    const program = programOf((b) => [
      b.exprStmt(b.call({ callee: b.name('len', said(0)), args: [] }, said(0, 2)), said(0, 2)),
    ]);
    expect(resolutionOf(buildSymbolTable(program), 'len')).toEqual(['unresolved']);
    expect(resolutionOf(buildSymbolTable(program, { builtins: ['len'] }), 'len')).toEqual([
      'builtin',
    ]);
  });

  it('ignores holes in name positions', () => {
    const table = buildSymbolTable(
      programOf((b) => [
        b.forEach(
          {
            target: b.nameHole('loop variable not named'),
            iterable: b.nameHole('which list?'),
            body: b.block([b.blockHole('body not described')]),
          },
          said(0, 3),
        ),
      ]),
    );
    expect(table.symbols).toEqual([]);
    expect(table.references).toEqual([]);
  });

  it('records loop and range variables as definitions', () => {
    const table = buildSymbolTable(
      programOf((b) => [
        b.forRange(
          {
            target: b.name('i', { inferred: 'INF-INDEXVAR' }),
            stop: b.name('n', said(2)),
            body: b.block([b.exprStmt(b.name('i', said(4)), said(4))]),
          },
          said(0, 5),
        ),
      ]),
    );
    expect(byName(table)).toEqual([{ name: 'i', defs: 1, uses: 1 }]);
  });

  it('accounts for every Name node exactly once', () => {
    const program = workedExample().program;
    const table = buildSymbolTable(program);
    const names = allNodes(program).filter((node): node is Name => node.kind === 'Name');
    const recorded = [
      ...table.references.map((ref) => ref.nodeId),
      ...table.symbols.flatMap((s) => s.definitions.map((d) => d.nodeId)),
    ];
    expect(recorded.sort()).toEqual(names.map((n) => n.id).sort());
  });
});

describe('symbolAt', () => {
  const program = workedExample().program;
  const table = buildSymbolTable(program);
  const names = allNodes(program).filter((node): node is Name => node.kind === 'Name');

  it('finds the symbol for a definition and for each use', () => {
    const seenNodes = names.filter((n) => n.name === 'seen');
    expect(seenNodes).toHaveLength(3);
    for (const node of seenNodes) {
      expect(symbolAt(table, node.id)?.id).toBe(`${program.id}:seen`);
    }
  });

  it('returns undefined for unresolved names and non-names', () => {
    const nums = names.find((n) => n.name === 'nums');
    expect(symbolAt(table, nums?.id ?? '')).toBeUndefined();
    expect(symbolAt(table, program.id)).toBeUndefined();
  });
});
