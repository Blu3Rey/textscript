// The merge gate (ROADMAP.md §6.1): faithfulness and gap preservation must
// not drop below a recorded baseline. Coverage changes are reported but
// don't fail it. S7 turns the gate on in CI.

import type { RunResult } from './run';
import { gapPreservationOn } from './report/report';

export interface Baseline {
  translator: string;
  faithfulness: number | null;
  gapPreservation: number | null;
  /** On the "deliberately incomplete" walkthroughs, where the M2 target is 100%. */
  gapPreservationIncomplete: number | null;
  coverage: number | null;
}

export function baselineOf(result: RunResult): Baseline {
  return {
    translator: result.translator,
    faithfulness: result.metrics.faithfulness.value,
    gapPreservation: result.metrics.gapPreservation.value,
    gapPreservationIncomplete: gapPreservationOn(result, 'incomplete')?.value ?? null,
    coverage: result.metrics.coverage.value,
  };
}

/** Rounded so floating-point noise doesn't fail the gate. */
function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

function show(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(2)}%`;
}

export interface GateResult {
  passed: boolean;
  lines: string[];
}

export function checkGate(result: RunResult, baseline: Baseline): GateResult {
  const current = baselineOf(result);
  const lines: string[] = [];
  let passed = true;
  const gated: ['faithfulness' | 'gapPreservation' | 'gapPreservationIncomplete', string][] = [
    ['faithfulness', 'Faithfulness'],
    ['gapPreservation', 'Gap preservation'],
    ['gapPreservationIncomplete', 'Gap preservation (incomplete walkthroughs)'],
  ];
  for (const [key, name] of gated) {
    const was = round(baseline[key]);
    const now = round(current[key]);
    const regressed = was !== null && (now === null || now < was);
    if (regressed) passed = false;
    lines.push(`${regressed ? '✗' : '✓'} ${name}: ${show(now)} (baseline ${show(was)})`);
  }
  const was = round(baseline.coverage);
  const now = round(current.coverage);
  const change =
    was === null || now === null
      ? ''
      : ` (${now >= was ? '+' : ''}${((now - was) * 100).toFixed(2)} points)`;
  lines.push(`  Coverage: ${show(now)}${change}, not gated`);
  return { passed, lines };
}
