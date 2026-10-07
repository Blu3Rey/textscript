// Plain-language reasons a step isn't a full match. Every failing step in a
// report gets at least one.

import type { NodeRef } from '../compare/step';
import { isExact } from '../metrics';
import type { StepResult } from '../run';

export type ReasonKind =
  | 'rejected'
  | 'filled'
  | 'unsupported'
  | 'missing'
  | 'placement'
  | 'asked'
  | 'not-asked'
  | 'unstable'
  | 'held-back'
  | 'retried';

export interface Reason {
  kind: ReasonKind;
  text: string;
}

function code(ref: NodeRef): string {
  return ref.text === '' ? ref.kind : `\`${ref.text}\` (${ref.kind})`;
}

export function explain(step: StepResult): Reason[] {
  const c = step.comparison;
  const reasons: Reason[] = [];
  if (step.rejected) {
    reasons.push({
      kind: 'rejected',
      text: `The batch was rejected (${step.rejected.code}): ${step.rejected.message}`,
    });
  }
  for (const gap of c.filled) {
    reasons.push({
      kind: 'filled',
      text: gap.filledWith
        ? `Filled a gap: the gold answer leaves ${code(gap.node)} open (${gap.code}), but the translator wrote ${code(gap.filledWith)}.`
        : `Closed a gap the user left open: ${gap.code}, "${gap.message}"`,
    });
  }
  for (const ref of c.unsupported) {
    reasons.push({
      kind: 'unsupported',
      text: `Produced, but not in any gold answer: ${code(ref)}.`,
    });
  }
  if (step.trace && step.trace.errors.length > 0) {
    const outcome = step.trace.salvaged
      ? 'neither answer worked, so only the commands that did were kept'
      : 'the second answer worked';
    reasons.push({
      kind: 'retried',
      text: `The translator's answer failed (${step.trace.errors.join(' / ')}); ${outcome}.`,
    });
  }
  for (const held of step.validation?.heldBack ?? []) {
    reasons.push({
      kind: 'held-back',
      text: `Held back (${held.code}${held.falseRejection ? ', which a gold answer supports' : ''}): ${held.message}.`,
    });
  }
  for (const ref of c.missing) {
    reasons.push({ kind: 'missing', text: `In the gold answer, but not produced: ${code(ref)}.` });
  }
  if (c.placement && !c.placement.correct) {
    const list = (ids: readonly string[]) => (ids.length > 0 ? ids.join(', ') : 'nothing');
    reasons.push({
      kind: 'placement',
      text: `Changed ${list(c.placement.actual)}; the gold answer changes ${list(c.placement.expected)}.`,
    });
  }
  if (c.asked.actual && c.asked.expected === 'no') {
    reasons.push({ kind: 'asked', text: 'Asked a question, but the meaning was clear.' });
  }
  if (!c.asked.actual && c.asked.expected === 'yes') {
    reasons.push({
      kind: 'not-asked',
      text: "Didn't ask, but the gold answer asks which one was meant.",
    });
  }
  for (const ref of c.stability.changed) {
    reasons.push({
      kind: 'unstable',
      text: `Changed code the utterance didn't touch: ${code(ref)}.`,
    });
  }
  if (reasons.length === 0 && !isExact(step)) {
    reasons.push({ kind: 'missing', text: "Doesn't match any gold answer." });
  }
  return reasons;
}
