// What a translator is shown for each utterance (ROADMAP.md S7, "context
// packing"): the problem, earlier utterances, the code with its node IDs,
// the open gaps with their hole numbers, the names in scope, and the
// utterance itself with every word numbered, so provenance can cite word
// ranges instead of character offsets.

import { formatCode, formatDiagnostics } from '@textscript/commands';
import { analyze, allNodes, type Utterance } from '@textscript/core';
import { PYTHON_BUILTINS } from '@textscript/render-python';
import type { ProblemContext, TranslationContext } from './translator';

/** `[0]Loop [1]through [2]the …` */
export function numberedWords(utterance: Utterance): string {
  return utterance.tokens.map((token, i) => `[${String(i)}]${token.text}`).join(' ');
}

/** The problem, which stays the same for a whole session. */
export function packProblem(problem: ProblemContext): string {
  return [
    `Problem: ${problem.title}`,
    `Inputs the problem gives: ${problem.inputs.join(', ') || '(none)'}`,
    '',
    problem.statement,
  ].join('\n');
}

/** Everything that changes from one utterance to the next. */
export function packTurn(context: TranslationContext): string {
  const { program } = context.document;
  const analysis = analyze(program, {
    builtins: PYTHON_BUILTINS,
    inputs: context.problem.inputs,
    utterances: [...context.recent, context.utterance],
  });
  const names = [...new Set(analysis.symbols.symbols.map((symbol) => symbol.name))].sort();
  const labels = allNodes(program)
    .filter((node) => node.label !== undefined)
    .map(
      (node) => `@${(node.label ?? '').trim().toLowerCase().replaceAll(/\s+/g, '-')} = ${node.id}`,
    );
  const earlier = context.recent.map((u) => `${u.id}: ${u.text}`);
  const gaps = formatDiagnostics(program, analysis).filter((line) => !line.startsWith('('));
  return [
    'Earlier utterances:',
    ...(earlier.length > 0 ? earlier : ['(none)']),
    '',
    'Code so far (statement and note IDs on the left):',
    ...formatCode(program),
    '',
    'Open gaps (code, hole number, node, what is missing):',
    ...(gaps.length > 0 ? gaps : ['(none)']),
    '',
    `Names set up so far: ${names.join(', ') || '(none)'}`,
    ...(labels.length > 0 ? [`Labels: ${labels.join(', ')}`] : []),
    '',
    `Utterance ${context.utterance.id}, word by word:`,
    numberedWords(context.utterance),
  ].join('\n');
}
