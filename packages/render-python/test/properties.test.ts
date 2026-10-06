import { spawnSync } from 'node:child_process';
import {
  allNodes,
  children,
  indexTree,
  updateNode,
  type Expr,
  type IrNode,
  type NodeKind,
  type Program,
  type Stmt,
} from '@textscript/core';
import { arbitraries } from '@textscript/core/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { render, textOf, type RenderResult } from '../src';
import { CASES, buildCase } from './cases';

const EXPR_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'Name',
  'Literal',
  'InfinityLiteral',
  'UnaryOp',
  'BinOp',
  'Compare',
  'BoolOp',
  'Membership',
  'Call',
  'Index',
  'Slice',
  'Attribute',
  'CollectionLiteral',
  'DictLiteral',
  'ExprHole',
  'CondHole',
  'NameHole',
  'RefHole',
]);

/** Fields whose node is rendered as a name binding rather than an expression. */
const BINDING_FIELDS: ReadonlySet<string> = new Set(['target', 'name', 'params']);

function isExpr(node: IrNode): node is Expr {
  return EXPR_KINDS.has(node.kind);
}

function lines(result: RenderResult): string[] {
  return result.text.split('\n');
}

function hasNotes(root: IrNode): boolean {
  return allNodes(root).some((node) => (node.notes ?? []).length > 0);
}

/** Gives a generated subtree fresh IDs from `next` and strips its notes. */
function prepareReplacement<N extends IrNode>(node: N, next: number): N {
  let counter = next;
  for (const child of allNodes(node)) {
    Object.assign(child, { id: `n${String(counter++)}` });
    Reflect.deleteProperty(child, 'notes');
  }
  return node;
}

// Python ---------------------------------------------------------------------

const PYTHON = ['python3', 'python'].find(
  (command) => spawnSync(command, ['--version']).status === 0,
);

const PARSE_SCRIPT = `
import ast, json, sys
failures = []
for index, source in enumerate(json.load(sys.stdin)):
    try:
        ast.parse(source)
    except (SyntaxError, ValueError) as error:
        failures.append({"index": index, "error": str(error)})
print(json.dumps(failures))
`;

const SAME_AST_SCRIPT = `
import ast, json, sys
mismatches = []
for index, (minimal, explicit) in enumerate(json.load(sys.stdin)):
    if ast.dump(ast.parse(minimal)) != ast.dump(ast.parse(explicit)):
        mismatches.append(index)
print(json.dumps(mismatches))
`;

function runPython(script: string, input: unknown): unknown {
  if (PYTHON === undefined) throw new Error('Python is not installed');
  const result = spawnSync(PYTHON, ['-c', script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

/** Parses every source with Python's own parser and returns the failures. */
function pythonParseFailures(sources: string[]): { source: string; error: string }[] {
  const failures = runPython(PARSE_SCRIPT, sources) as { index: number; error: string }[];
  return failures.map(({ index, error }) => ({ source: sources[index] ?? '', error }));
}

// CI always has Python (see .github/workflows/ci.yml); locally the test is
// skipped if it's missing rather than failing for an unrelated reason.
describe.runIf(PYTHON !== undefined || process.env['CI'] !== undefined)('export mode', () => {
  it('always parses as Python, for random programs', () => {
    const seed = Date.now();
    const docs = fc.sample(arbitraries.document, { numRuns: 500, seed });
    const failures = pythonParseFailures(docs.map((doc) => render(doc.program).text));
    expect(failures, `fast-check seed ${String(seed)}`).toEqual([]);
  });

  it('means what the IR says: minimal parentheses give the same Python AST as full ones', () => {
    const seed = Date.now();
    const programs = [
      ...fc.sample(arbitraries.document, { numRuns: 500, seed }).map((doc) => doc.program),
      ...CASES.map(buildCase),
    ];
    const pairs = programs.map((program) => [
      render(program).text,
      render(program, { parentheses: 'all' }).text,
    ]);
    const mismatches = runPython(SAME_AST_SCRIPT, pairs) as number[];
    expect(
      mismatches.map((i) => pairs[i]),
      `fast-check seed ${String(seed)}`,
    ).toEqual([]);
  });

  it('parses for every golden case', () => {
    expect(pythonParseFailures(CASES.map((c) => render(buildCase(c)).text))).toEqual([]);
  });
});

// Source map -------------------------------------------------------------------

describe.each(['export', 'ui'] as const)('source map in %s mode', (mode) => {
  it('covers every node, with children inside their parent in source order', () => {
    fc.assert(
      fc.property(arbitraries.document, ({ program }) => {
        const result = render(program, { mode });
        for (const node of allNodes(program)) {
          const range = result.sourceMap.nodes.get(node.id);
          expect(range, `${node.kind} ${node.id} has no range`).toBeDefined();
          if (range === undefined) return;
          let previousEnd = range.start.offset;
          for (const { node: child } of children(node)) {
            const childRange = result.sourceMap.nodes.get(child.id);
            expect(childRange?.start.offset).toBeGreaterThanOrEqual(previousEnd);
            expect(childRange?.end.offset).toBeLessThanOrEqual(range.end.offset);
            previousEnd = childRange?.end.offset ?? previousEnd;
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('maps each expression to exactly the text it renders to on its own', () => {
    fc.assert(
      fc.property(arbitraries.document, ({ program }) => {
        const result = render(program, { mode });
        const index = indexTree(program);
        for (const node of allNodes(program)) {
          if (!isExpr(node) || BINDING_FIELDS.has(index.get(node.id)?.position?.field ?? ''))
            continue;
          const alone: Program = {
            kind: 'Program',
            id: 'n999998',
            body: [{ kind: 'ExprStmt', id: 'n999999', expr: node, provenance: [] }],
            provenance: [],
          };
          expect(textOf(result, node.id)).toBe(textOf(render(alone, { mode }), node.id));
        }
      }),
      { numRuns: 100 },
    );
  });

  it('attributes every token except indentation to a node', () => {
    fc.assert(
      fc.property(arbitraries.document, ({ program }) => {
        for (const token of render(program, { mode }).lines.flat()) {
          if (token.kind !== 'indent') expect(token.nodeId).toBeDefined();
        }
      }),
      { numRuns: 50 },
    );
  });
});

// Locality ---------------------------------------------------------------------

/**
 * Replaces one node and checks that every line outside the node's old and
 * new line ranges is byte-identical: the renderer never reflows unrelated
 * code. Notes and functions are excluded, because a note adds a comment line
 * above its statement and a function changes the blank lines around it, both
 * by design.
 */
function expectLocalChange(program: Program, targetId: string, replacement: IrNode) {
  const before = render(program);
  const after = render(updateNode(program, targetId, () => replacement));
  const oldRange = before.sourceMap.nodes.get(targetId);
  const newRange = after.sourceMap.nodes.get(replacement.id);
  if (oldRange === undefined || newRange === undefined) throw new Error('missing range');

  const oldLines = lines(before);
  const newLines = lines(after);
  expect(newRange.start.line).toBe(oldRange.start.line);
  expect(newLines.slice(0, newRange.start.line)).toEqual(oldLines.slice(0, oldRange.start.line));
  expect(newLines.slice(newRange.end.line + 1)).toEqual(oldLines.slice(oldRange.end.line + 1));
}

describe('a one-node change', () => {
  it('only changes the lines of an expression it replaces', () => {
    fc.assert(
      fc.property(arbitraries.document, fc.nat(), arbitraries.expr(2), (doc, seed, generated) => {
        const index = indexTree(doc.program);
        const candidates = allNodes(doc.program).filter(
          (node) =>
            isExpr(node) &&
            !hasNotes(node) &&
            !BINDING_FIELDS.has(index.get(node.id)?.position?.field ?? ''),
        );
        fc.pre(candidates.length > 0);
        const target = candidates[seed % candidates.length] as Expr;
        expectLocalChange(doc.program, target.id, prepareReplacement(generated, doc.nextId));
      }),
      { numRuns: 200 },
    );
  });

  it('only changes the lines of a statement it replaces', () => {
    fc.assert(
      fc.property(arbitraries.document, fc.nat(), arbitraries.stmt(2), (doc, seed, generated) => {
        fc.pre(generated.kind !== 'FunctionDef');
        const index = indexTree(doc.program);
        const candidates = allNodes(doc.program).filter((node) => {
          const field = index.get(node.id)?.position?.field;
          return (
            (field === 'body' || field === 'stmts') &&
            node.kind !== 'Block' &&
            node.kind !== 'FunctionDef' &&
            !hasNotes(node)
          );
        });
        fc.pre(candidates.length > 0);
        const target = candidates[seed % candidates.length] as Stmt;
        expectLocalChange(doc.program, target.id, prepareReplacement(generated, doc.nextId));
      }),
      { numRuns: 200 },
    );
  });
});
