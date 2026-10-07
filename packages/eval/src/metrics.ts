// Aggregate metrics (ROADMAP.md §6.1). Counts are summed over steps before
// dividing, so a step with many nodes weighs more than one with few.

import type { TranslationUsage } from '@textscript/translator';
import type { StepComparison } from './compare/step';

export interface Ratio {
  numerator: number;
  denominator: number;
  /** `null` when there's nothing to measure. */
  value: number | null;
}

export interface Metrics {
  steps: number;
  walkthroughs: number;
  /** Produced units (not holes) that a gold answer supports. */
  faithfulness: Ratio;
  /** Gaps in the gold states (holes, missing returns, …) the translator left open. */
  gapPreservation: Ratio;
  /** Gold units the translator produced. */
  coverage: Ratio;
  /** Refinement steps that changed exactly the nodes the gold answer changes. */
  placement: Ratio;
  clarificationPrecision: Ratio;
  clarificationRecall: Ratio;
  /** Lines of untouched statements that stayed byte-identical. */
  stability: Ratio;
  /** Steps whose result matches a gold answer completely. */
  exact: Ratio;
  /** Steps whose batch `apply` rejected. */
  rejected: number;
  latencyMs: { p50: number | null; p95: number | null };
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    costPer20: number | null;
  };
}

/** What metrics need from one step. */
export interface ScoredStep {
  walkthrough: string;
  comparison: StepComparison;
  rejected?: { code: string; message: string };
  latencyMs: number;
  usage?: TranslationUsage;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function isExact(step: ScoredStep): boolean {
  const c = step.comparison;
  return (
    step.rejected === undefined &&
    c.covered === c.goldUnits &&
    c.supported === c.producedUnits &&
    c.filled.length === 0 &&
    (c.placement?.correct ?? true) &&
    !(c.asked.actual && c.asked.expected === 'no') &&
    !(!c.asked.actual && c.asked.expected === 'yes')
  );
}

export function computeMetrics(steps: readonly ScoredStep[]): Metrics {
  const sum = (f: (c: StepComparison) => number) =>
    steps.reduce((total, s) => total + f(s.comparison), 0);
  const refinements = steps.filter((s) => s.comparison.placement !== undefined);
  const truePositives = steps.filter(
    (s) => s.comparison.asked.actual && s.comparison.asked.expected !== 'no',
  ).length;
  const falsePositives = steps.filter(
    (s) => s.comparison.asked.actual && s.comparison.asked.expected === 'no',
  ).length;
  const falseNegatives = steps.filter(
    (s) => !s.comparison.asked.actual && s.comparison.asked.expected === 'yes',
  ).length;
  const latencies = steps.map((s) => s.latencyMs).sort((a, b) => a - b);
  const costs = steps.flatMap((s) => (s.usage?.costUsd === undefined ? [] : [s.usage.costUsd]));
  // Cost is known only if every step reported it.
  const costUsd =
    costs.length > 0 && costs.length === steps.length ? costs.reduce((a, b) => a + b, 0) : null;
  const gaps = sum((c) => c.gaps);
  return {
    steps: steps.length,
    walkthroughs: new Set(steps.map((s) => s.walkthrough)).size,
    faithfulness: ratio(
      sum((c) => c.supported),
      sum((c) => c.producedUnits),
    ),
    gapPreservation: ratio(gaps - sum((c) => c.filled.length), gaps),
    coverage: ratio(
      sum((c) => c.covered),
      sum((c) => c.goldUnits),
    ),
    placement: ratio(
      refinements.filter((s) => s.comparison.placement?.correct === true).length,
      refinements.length,
    ),
    clarificationPrecision: ratio(truePositives, truePositives + falsePositives),
    clarificationRecall: ratio(truePositives, truePositives + falseNegatives),
    stability: ratio(
      sum((c) => c.stability.kept),
      sum((c) => c.stability.lines),
    ),
    exact: ratio(steps.filter(isExact).length, steps.length),
    rejected: steps.filter((s) => s.rejected !== undefined).length,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    usage: {
      inputTokens: steps.reduce((total, s) => total + (s.usage?.inputTokens ?? 0), 0),
      outputTokens: steps.reduce((total, s) => total + (s.usage?.outputTokens ?? 0), 0),
      costUsd,
      costPer20: costUsd === null || steps.length === 0 ? null : (costUsd / steps.length) * 20,
    },
  };
}
