// How the console shows a program: code with node IDs in a gutter, then
// the analyzer's diagnostics.

import {
  allNodes,
  type Analysis,
  type Diagnostic,
  type NodeId,
  type NodeKind,
  type Program,
} from '@textscript/core';
import { render } from '@textscript/render-python';

const GUTTER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'FunctionDef',
  'ForEach',
  'ForRange',
  'While',
  'If',
  'Elif',
  'Assign',
  'Update',
  'Return',
  'Break',
  'Continue',
  'ExprStmt',
  'IntentStmt',
  'BlockHole',
]);

const HOLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'BlockHole',
  'CondHole',
  'ExprHole',
  'NameHole',
  'RefHole',
]);

/** Holes in document order; `h1` is the first. */
export function holes(program: Program): NodeId[] {
  return allNodes(program)
    .filter((node) => HOLE_KINDS.has(node.kind))
    .map((node) => node.id);
}

/** The program as UI-mode code, each line prefixed with the statement or note that starts on it. */
export function formatCode(program: Program): string[] {
  if (program.body.length === 0) return ['(nothing yet)'];
  const result = render(program, { mode: 'ui' });
  const starts = new Map<number, NodeId>();
  for (const node of allNodes(program)) {
    if (!GUTTER_KINDS.has(node.kind)) continue;
    const line = result.sourceMap.nodes.get(node.id)?.start.line;
    if (line !== undefined && !starts.has(line)) starts.set(line, node.id);
  }
  // Note comments get their note's ID, for `unnote`.
  for (const [id, range] of result.sourceMap.notes) starts.set(range.start.line, id);
  const width = Math.max(...[...starts.values()].map((id) => id.length), 2);
  return result.text
    .trimEnd()
    .split('\n')
    .map((line, i) => `${(starts.get(i) ?? '').padStart(width)} │ ${line}`.trimEnd());
}

export function formatDiagnostic(d: Diagnostic, holeRefs: ReadonlyMap<NodeId, string>): string {
  const ref = holeRefs.get(d.nodeId) ?? '';
  const unique = [...new Set(d.quotes)];
  const quotes = unique.length > 0 ? `  "${unique.join('" / "')}"` : '';
  return `${d.code.padEnd(7)} ${ref.padEnd(3)} ${d.nodeId.padEnd(4)} ${d.message}${quotes}`;
}

/** Diagnostics, one per line. Inferences are summarized unless `all`. */
export function formatDiagnostics(program: Program, analysis: Analysis, all = false): string[] {
  const holeRefs = new Map(holes(program).map((id, i) => [id, `h${String(i + 1)}`]));
  const shown = analysis.diagnostics.filter((d) => all || d.severity !== 'info');
  const lines = shown.map((d) => formatDiagnostic(d, holeRefs));
  const infos = analysis.diagnostics.filter((d) => d.severity === 'info');
  if (!all && infos.length > 0) {
    lines.push(
      `(${String(infos.length)} inferred: ${infos.map((d) => d.nodeId).join(' ')}; :diag all shows them)`,
    );
  }
  return lines.length > 0 ? lines : ['(no gaps)'];
}

export function formatCoverage(analysis: Analysis): string[] {
  const { coverage } = analysis;
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  return [
    `${mark(coverage.approach)} approach described`,
    `${mark(coverage.inputs === 'named')} inputs: ${coverage.inputs}${coverage.inputNames.length > 0 ? ` (${coverage.inputNames.join(', ')})` : ''}`,
    `${mark(coverage.returns === 'all-paths')} returns: ${coverage.returns}`,
    `${mark(coverage.edgeCases.length > 0)} edge cases noted: ${String(coverage.edgeCases.length)}`,
    `${mark(coverage.complexity.length > 0)} complexity noted: ${String(coverage.complexity.length)}`,
    `  open gaps: ${String(coverage.gaps)}`,
  ];
}
