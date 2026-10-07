// How closely two annotators agree on the same walkthrough (ROADMAP.md S6,
// "have two people annotate a sample"). Each step is compared on what it
// produced: the nodes, notes and labels it added or changed in each
// annotator's own state. The two states are aligned to see which of those
// match, so an early disagreement doesn't count again at every later step.

import type { Program } from '@textscript/core';
import { align, isPlaceholder } from './compare/align';
import { changes, type Changes } from './compare/step';
import type { CompiledGold } from './corpus/gold';
import { ratio, type Ratio } from './metrics';

export interface StepAgreement {
  /** 0-based. */
  index: number;
  /** Both produced the same things. */
  exact: boolean;
  /** Matching units over all units, F1-style: 2·matched / (a + b). 1 when neither produced anything. */
  f1: number;
  /** Holes either annotator produced in this step, and those both produced in the same place. */
  holes: { either: number; both: number };
}

export interface Agreement {
  steps: StepAgreement[];
  /** Steps where both produced the same things. */
  exact: Ratio;
  /** Mean of the steps' F1. */
  f1: number;
  /** Holes both annotations put in the same place, over holes either has. */
  holes: Ratio;
}

function size(p: Changes): number {
  return p.nodes.size + p.notes.size + p.labels.size;
}

export function compareSteps(
  a: { before: Program; after: Program },
  b: { before: Program; after: Program },
): Omit<StepAgreement, 'index'> {
  const mine = changes(a.before, a.after);
  const theirs = changes(b.before, b.after);
  const alignment = align(a.after, b.after);
  let matched = 0;
  for (const node of mine.nodes) {
    const pair = alignment.pairs.get(node);
    if (pair !== undefined && theirs.nodes.has(pair) && alignment.equal.has(node)) matched++;
  }
  for (const node of mine.labels) {
    const pair = alignment.pairs.get(node);
    if (pair !== undefined && theirs.labels.has(pair) && alignment.labels.has(node)) matched++;
  }
  matched += alignment.notes.filter(
    (n) => mine.notes.has(n.gold.id) && theirs.notes.has(n.produced.id),
  ).length;

  const holesA = [...mine.nodes].filter(isPlaceholder);
  const holesB = [...theirs.nodes].filter(isPlaceholder).length;
  const both = holesA.filter((hole) => {
    const pair = alignment.pairs.get(hole);
    return pair !== undefined && theirs.nodes.has(pair) && isPlaceholder(pair);
  }).length;
  const total = size(mine) + size(theirs);
  return {
    exact: matched * 2 === total,
    f1: total === 0 ? 1 : (2 * matched) / total,
    holes: { either: holesA.length + holesB - both, both },
  };
}

export function agreement(a: CompiledGold, b: CompiledGold): Agreement {
  const steps: StepAgreement[] = a.steps.map((step, index) => {
    const other = b.steps[index];
    const mine = step.alternatives[0]?.after.program;
    const theirs = other?.alternatives[0]?.after.program;
    if (mine === undefined || other === undefined || theirs === undefined) {
      return { index, exact: false, f1: 0, holes: { either: 0, both: 0 } };
    }
    return {
      index,
      ...compareSteps(
        { before: step.before.program, after: mine },
        { before: other.before.program, after: theirs },
      ),
    };
  });
  const either = steps.reduce((total, s) => total + s.holes.either, 0);
  const both = steps.reduce((total, s) => total + s.holes.both, 0);
  return {
    steps,
    exact: ratio(steps.filter((s) => s.exact).length, steps.length),
    f1: steps.length === 0 ? 1 : steps.reduce((total, s) => total + s.f1, 0) / steps.length,
    holes: ratio(both, either),
  };
}
