import { describe, expect, it } from 'vitest';
import { agreement } from '../src/agreement';
import { baselineOf, checkGate } from '../src/gate';
import { diffLines } from '../src/report/diff';
import { explain } from '../src/report/explain';
import { failingSteps, htmlReport, markdownReport } from '../src/report/report';
import { oracleTranslator, runEval } from '../src/run';
import {
  corpusOf,
  fixture,
  INCOMPLETE,
  PROBLEM,
  scriptedTranslator,
  TERSE,
  TERSE_GOLD,
} from './helpers';

const clock = () => {
  let t = 0;
  return () => (t += 1500);
};

/** Fills the missing return, uses a list, asks needlessly and misplaces an edit. */
const careless = scriptedTranslator('careless', {
  u1: ['add root: for num in nums:\n  print(num)'],
  u3: ['add root start: seen = []', 'ask Is it a set?'],
  u4: ['add root: seen.add(num)', 'add root: return False'],
});

async function carelessRun() {
  return runEval(fixture(), { translator: careless, now: clock() });
}

describe('markdownReport', () => {
  it('explains every failing step', async () => {
    await expect(markdownReport(await carelessRun())).toMatchFileSnapshot(
      'golden/careless-report.md',
    );
  });

  it('says so when nothing fails', async () => {
    const result = await runEval(fixture(), { translator: oracleTranslator, now: clock() });
    expect(markdownReport(result)).toContain("## Steps that don't match (0)\n\nNone.");
  });
});

describe('htmlReport', () => {
  it('is a self-contained page with the same content, escaped', async () => {
    const result = await carelessRun();
    const html = htmlReport(result, 'Report <draft>');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Report &lt;draft&gt;</title>');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('<span class="added">+ return False</span>');
    expect(html.match(/<details>/g)).toHaveLength(failingSteps(result).length);
    expect(html).not.toContain('<script');
  });

  it('says so when nothing fails', async () => {
    const result = await runEval(fixture(), { translator: oracleTranslator, now: clock() });
    expect(htmlReport(result)).toContain('<p>None.</p>');
  });
});

describe('explain', () => {
  it('gives a reason for every non-exact step', async () => {
    const result = await carelessRun();
    for (const step of result.steps) {
      const reasons = explain(step);
      expect(reasons.length > 0).toBe(
        step.comparison.missing.length + step.comparison.unsupported.length > 0 ||
          reasons.length > 0,
      );
    }
    const kinds = new Set(result.steps.flatMap((s) => explain(s).map((r) => r.kind)));
    expect([...kinds].sort()).toEqual(['asked', 'filled', 'missing', 'placement', 'unsupported']);
  });

  it('describes rejections and missed questions', async () => {
    const corpus = corpusOf({
      problems: { dup: PROBLEM },
      walkthroughs: { 'dup.incomplete': INCOMPLETE, 'dup.terse': TERSE },
      gold: {
        'dup.incomplete': 'step 1\nask Which list?\nstep 2\nstep 3\nstep 4\n',
        'dup.terse': TERSE_GOLD,
      },
    });
    const result = await runEval(corpus, {
      translator: {
        name: 'x',
        translate: (context) =>
          Promise.resolve({
            batch: {
              utteranceId: context.utterance.id,
              ops: [{ op: 'remove_node', node: 'n42', provenance: [] }],
            },
            unparsedSpans: [],
          }),
      },
      filter: { walkthroughs: ['dup.incomplete'] },
    });
    const reasons = explain(result.steps[0] ?? (undefined as never)).map((r) => r.kind);
    expect(reasons).toEqual(['rejected', 'not-asked']);
  });
});

describe('diffLines', () => {
  it('marks removed and added lines', () => {
    expect(diffLines('a\nb\nc\n', 'a\nx\nc\n')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'x' },
      { type: 'same', text: 'c' },
    ]);
    expect(diffLines('', 'a\n')).toEqual([{ type: 'added', text: 'a' }]);
    expect(diffLines('a\n', '')).toEqual([{ type: 'removed', text: 'a' }]);
  });
});

describe('the gate', () => {
  it('passes at the baseline and fails when faithfulness or gap preservation drops', async () => {
    const oracle = await runEval(fixture(), { translator: oracleTranslator });
    const baseline = baselineOf(oracle);
    expect(baseline).toEqual({
      translator: 'oracle',
      faithfulness: 1,
      gapPreservation: 1,
      gapPreservationIncomplete: 1,
      coverage: 1,
    });
    expect(checkGate(oracle, baseline).passed).toBe(true);
    const gate = checkGate(await carelessRun(), baseline);
    expect(gate.passed).toBe(false);
    expect(gate.lines[0]).toMatch(/^✗ Faithfulness: \d+\.\d\d% \(baseline 100\.00%\)$/);
    expect(gate.lines.at(-1)).toMatch(/^ {2}Coverage: .* points\), not gated$/);
  });

  it('ignores metrics the baseline has no value for', async () => {
    const result = await carelessRun();
    const gate = checkGate(result, {
      translator: 'none',
      faithfulness: null,
      gapPreservation: null,
      gapPreservationIncomplete: null,
      coverage: null,
    });
    expect(gate.passed).toBe(true);
    expect(gate.lines.at(-1)).toMatch(/Coverage: .*%, not gated$/);
  });
});

describe('agreement', () => {
  it('is perfect for the same annotation and lower for a different one', () => {
    const corpus = fixture();
    const mine = corpus.gold.get('dup.terse');
    if (mine === undefined) throw new Error('fixture');
    expect(agreement(mine, mine)).toMatchObject({ exact: { value: 1 }, f1: 1 });
    const other = corpusOf({
      problems: { dup: PROBLEM },
      walkthroughs: { 'dup.incomplete': INCOMPLETE, 'dup.terse': TERSE },
      gold: {
        'dup.incomplete': 'step 1\nstep 2\nstep 3\nstep 4\n',
        'dup.terse':
          'step 1\nadd root: seen = []\nstep 2\nstep 3\nadd root:\n  for num in nums:\n    if ?cond:\n      return True\n',
      },
    }).gold.get('dup.terse');
    if (other === undefined) throw new Error('fixture');
    const result = agreement(mine, other);
    expect(result.exact.value).toBeCloseTo(1 / 3);
    expect(result.f1).toBeGreaterThan(0.5);
    expect(result.f1).toBeLessThan(1);
    expect(result.holes).toEqual({ numerator: 0, denominator: 1, value: 0 });
  });
});
