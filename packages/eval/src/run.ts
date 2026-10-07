// Plays walkthroughs through a translator and scores every step against
// gold (docs/adr/011).
//
// Each step starts from the canonical gold state before it ("teacher
// forcing"), so a mistake in one step doesn't lower the score of the next,
// and a step's score says how well that one utterance was translated.

import { apply, type EditBatch } from '@textscript/core';
import { render } from '@textscript/render-python';
import type { Translation, Translator } from '@textscript/translator';
import { compareStep, type StepComparison } from './compare/step';
import type { Problem, Split, Style } from './corpus/corpus';
import type { CompiledGold } from './corpus/gold';
import type { Corpus } from './corpus/load';
import { computeMetrics, type Metrics, type ScoredStep } from './metrics';

export interface StepResult extends ScoredStep {
  problem: string;
  style: Style;
  split: Split;
  /** 0-based. */
  index: number;
  utterance: string;
  batch: EditBatch;
  unparsed: number;
  comparison: StepComparison;
  /** Export-mode code before the step, from the chosen gold answer, and from the translator. */
  code: { before: string; expected: string; produced: string };
}

export interface RunResult {
  translator: string;
  steps: StepResult[];
  metrics: Metrics;
}

export interface RunFilter {
  split?: Split;
  problems?: readonly string[];
  styles?: readonly Style[];
  walkthroughs?: readonly string[];
  /** Leave these problems out, such as the ones the few-shot examples come from. */
  excludeProblems?: readonly string[];
}

export interface RunOptions {
  /** One translator for every walkthrough, or one made per walkthrough from its gold. */
  translator: Translator | ((gold: CompiledGold) => Translator);
  filter?: RunFilter;
  /** Walkthroughs translated at once (default 1); steps within one stay in order. */
  concurrency?: number;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
}

export function selectWalkthroughs(corpus: Corpus, filter: RunFilter = {}): CompiledGold[] {
  return [...corpus.gold.values()]
    .filter(({ walkthrough: w }) => {
      const problem = corpus.problems.get(w.problem);
      return (
        (filter.split === undefined || problem?.split === filter.split) &&
        (filter.problems === undefined || filter.problems.includes(w.problem)) &&
        (filter.styles === undefined || filter.styles.includes(w.style)) &&
        (filter.walkthroughs === undefined || filter.walkthroughs.includes(w.id)) &&
        !(filter.excludeProblems ?? []).includes(w.problem)
      );
    })
    .sort((a, b) => a.walkthrough.id.localeCompare(b.walkthrough.id));
}

function problemContext(problem: Problem | undefined, id: string) {
  return problem
    ? { id: problem.id, title: problem.title, statement: problem.statement, inputs: problem.inputs }
    : { id, title: id, statement: '', inputs: [] };
}

export async function runEval(corpus: Corpus, options: RunOptions): Promise<RunResult> {
  const now = options.now ?? (() => performance.now());
  const selected = selectWalkthroughs(corpus, options.filter);
  const results: StepResult[][] = [];
  let name: string | undefined;

  const play = async (gold: CompiledGold): Promise<StepResult[]> => {
    const steps: StepResult[] = [];
    const { walkthrough } = gold;
    const problem = corpus.problems.get(walkthrough.problem);
    const translator =
      typeof options.translator === 'function' ? options.translator(gold) : options.translator;
    name ??= translator.name;

    for (const step of gold.steps) {
      const started = now();
      let translation: Translation | undefined;
      let rejected: { code: string; message: string } | undefined;
      try {
        translation = await translator.translate({
          utterance: step.utterance,
          document: step.before,
          recent: step.recent,
          problem: problemContext(problem, walkthrough.problem),
        });
      } catch (error) {
        rejected = {
          code: 'translator-error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const latencyMs = now() - started;
      const batch = translation?.batch ?? { utteranceId: step.utterance.id, ops: [] };

      let document = step.before;
      if (rejected === undefined && batch.utteranceId !== step.utterance.id) {
        rejected = {
          code: 'wrong-utterance',
          message: `The batch is for ${batch.utteranceId}, not ${step.utterance.id}`,
        };
      } else if (rejected === undefined) {
        const result = apply(step.before, batch);
        if (result.ok) document = result.document;
        else rejected = { code: result.error.code, message: result.error.message };
      }

      const comparison = compareStep(
        step.before,
        step.alternatives,
        { document, batch },
        { inputs: problem?.inputs ?? [] },
      );
      const expected = step.alternatives[comparison.alternative] ?? step.alternatives[0];
      steps.push({
        walkthrough: walkthrough.id,
        problem: walkthrough.problem,
        style: walkthrough.style,
        split: problem?.split ?? 'train',
        index: step.index,
        utterance: step.utterance.text,
        batch,
        ...(rejected ? { rejected } : {}),
        unparsed: translation?.unparsedSpans.length ?? 0,
        latencyMs,
        ...(translation?.usage ? { usage: translation.usage } : {}),
        comparison,
        code: {
          before: render(step.before.program).text,
          expected: expected ? render(expected.after.program).text : '',
          produced: render(document.program).text,
        },
      });
    }
    return steps;
  };

  // A small pool: each worker takes the next walkthrough until none are left.
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      const gold = selected[index];
      if (gold !== undefined) results[index] = await play(gold);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(options.concurrency ?? 1, selected.length)) },
      worker,
    ),
  );
  const steps = results.flat();
  return {
    translator:
      name ?? (typeof options.translator === 'function' ? 'unknown' : options.translator.name),
    steps,
    metrics: computeMetrics(steps),
  };
}

/** Metrics for each value of `key`, in sorted order. */
export function breakdown(
  steps: readonly StepResult[],
  key: (step: StepResult) => string,
): Map<string, Metrics> {
  const groups = new Map<string, StepResult[]>();
  for (const step of steps) {
    const value = key(step);
    groups.set(value, [...(groups.get(value) ?? []), step]);
  }
  return new Map(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, computeMetrics(v)]),
  );
}

/** Replays the canonical gold answer: every metric should be perfect. */
export function oracleTranslator(gold: CompiledGold): Translator {
  return {
    name: 'oracle',
    translate: (context) => {
      const step = gold.steps.find((s) => s.utterance.id === context.utterance.id);
      const batch = step?.alternatives[0]?.batch ?? { utteranceId: context.utterance.id, ops: [] };
      return Promise.resolve({ batch, unparsedSpans: [] });
    },
  };
}
