import { createUtterance } from '@textscript/core';
import { emptyTranslator, type Translator } from '@textscript/translator';
import { validate, type ValidationInput } from '@textscript/validator';
import { describe, expect, it } from 'vitest';
import { isExact } from '../src/metrics';
import { markdownReport } from '../src/report/report';
import {
  fillerTranslator,
  oracleTranslator,
  runEval,
  selectWalkthroughs,
  type StepResult,
} from '../src/run';
import { corpusOf, fixture, INCOMPLETE, PROBLEM, scriptedTranslator, TERSE } from './helpers';

const clock = () => {
  let t = 0;
  return () => (t += 10);
};

async function run(
  translator: Translator | Parameters<typeof runEval>[1]['translator'],
  walkthrough?: string,
) {
  return runEval(fixture(), {
    translator,
    now: clock(),
    ...(walkthrough ? { filter: { walkthroughs: [walkthrough] } } : {}),
  });
}

function step(steps: StepResult[], walkthrough: string, index: number): StepResult {
  const found = steps.find((s) => s.walkthrough === walkthrough && s.index === index);
  if (found === undefined) throw new Error(`no step ${walkthrough} ${String(index)}`);
  return found;
}

describe('the oracle', () => {
  it('scores 100% on everything it can be measured on', async () => {
    const { metrics, translator, steps } = await run(oracleTranslator);
    expect(translator).toBe('oracle');
    expect(metrics.steps).toBe(7);
    expect(metrics.walkthroughs).toBe(2);
    for (const key of [
      'faithfulness',
      'gapPreservation',
      'coverage',
      'placement',
      'stability',
      'exact',
    ] as const) {
      expect(metrics[key].value, key).toBe(1);
    }
    expect(metrics.clarificationPrecision.value).toBeNull();
    expect(metrics.rejected).toBe(0);
    expect(steps.every(isExact)).toBe(true);
    expect(metrics.latencyMs).toEqual({ p50: 10, p95: 10 });
  });
});

describe('the empty translator', () => {
  it('is faithful by default and covers nothing', async () => {
    const { metrics } = await run(emptyTranslator);
    expect(metrics.faithfulness.value).toBeNull();
    expect(metrics.coverage.value).toBe(0);
    expect(metrics.gapPreservation.value).toBe(1);
    expect(metrics.placement.value).toBe(0);
    // Steps with nothing to produce (filler) still match.
    expect(metrics.exact.numerator).toBe(1);
  });
});

describe('step comparison', () => {
  it('reports a closed missing-return gap and the unsupported return', async () => {
    const { steps, metrics } = await run(
      scriptedTranslator('helpful', {
        u4: ['set n7.orelse = seen.add(num)', 'add root: return False'],
      }),
      'dup.incomplete',
    );
    const last = step(steps, 'dup.incomplete', 3);
    expect(last.comparison.filled.map((f) => f.code)).toEqual(['GAP003']);
    expect(last.comparison.unsupported.map((u) => u.text)).toEqual(['return False']);
    expect(last.comparison.missing).toEqual([]);
    expect(metrics.gapPreservation.value).toBeLessThan(1);
  });

  it('reports a hole filled with code, and what filled it', async () => {
    const { steps } = await run(
      scriptedTranslator('filler', { u1: ['add root: for num in nums:\n  print(num)'] }),
      'dup.incomplete',
    );
    const [filled, ...rest] = step(steps, 'dup.incomplete', 0).comparison.filled;
    expect(rest).toEqual([]);
    expect(filled?.code).toBe('GAP002');
    expect(filled?.filledWith?.kind).toBe('ExprStmt');
  });

  it('counts a name set up that the user never set up as a closed gap', async () => {
    const { steps } = await run(
      scriptedTranslator('declares', {
        u2: ['fill h1:\n  if num in seen:\n    return True', 'add root start: seen = set()'],
      }),
      'dup.incomplete',
    );
    expect(step(steps, 'dup.incomplete', 1).comparison.filled.map((f) => f.code)).toEqual([
      'GAP001',
    ]);
  });

  it('accepts any hole where gold has a hole', async () => {
    const { steps } = await run(
      scriptedTranslator('holes', { u1: ['add root: for num~loopvar in nums:\n  ?'] }),
      'dup.incomplete',
    );
    const first = step(steps, 'dup.incomplete', 0);
    expect(first.comparison.filled).toEqual([]);
  });

  it('accepts a different name for an inferred loop variable, but not for a stated one', async () => {
    const inferred = await run(
      scriptedTranslator('names', { u1: ['add root: for n~loopvar in nums:\n  ...'] }),
      'dup.incomplete',
    );
    expect(isExact(step(inferred.steps, 'dup.incomplete', 0))).toBe(true);
    const stated = await run(
      scriptedTranslator('names', {
        u3: ['add root:\n  for x in nums:\n    if x in seen:\n      return True'],
      }),
      'dup.terse',
    );
    const loop = step(stated.steps, 'dup.terse', 2).comparison;
    expect(loop.covered).toBeLessThan(loop.goldUnits);
    expect(loop.unsupported.length).toBeGreaterThan(0);
  });

  it('picks the most favorable alternative', async () => {
    const { steps } = await run(
      scriptedTranslator('else', {
        u1: ['add root: seen = set()'],
        u3: [
          'add root:\n  for num in nums:\n    if num in seen:\n      return True\n    else:\n      ...',
        ],
      }),
      'dup.terse',
    );
    const loop = step(steps, 'dup.terse', 2);
    expect(loop.comparison.alternative).toBe(1);
    expect(isExact(loop)).toBe(true);
  });

  it('checks placement for refinements', async () => {
    const { steps } = await run(
      scriptedTranslator('misplaced', { u4: ['add root: seen.add(num)'] }),
      'dup.incomplete',
    );
    const last = step(steps, 'dup.incomplete', 3).comparison;
    expect(last.placement).toEqual({ expected: ['n7'], actual: ['n1'], correct: false });
  });

  it('measures stability of code the step should not touch', async () => {
    const { steps, metrics } = await run(
      scriptedTranslator('unstable', { u3: ['add root start: seen = set()', 'set n10.name = s'] }),
      'dup.incomplete',
    );
    const third = step(steps, 'dup.incomplete', 2).comparison;
    expect(third.stability.lines).toBe(3);
    expect(third.stability.kept).toBe(0);
    expect(third.stability.changed.map((c) => c.kind)).toEqual(['ForEach']);
    expect(metrics.stability.value).toBeLessThan(1);
  });

  it('scores questions against gold', async () => {
    const { steps, metrics } = await run(
      scriptedTranslator('asks', { u1: ['ask Which list?'] }),
      'dup.incomplete',
    );
    expect(step(steps, 'dup.incomplete', 0).comparison.asked).toEqual({
      actual: true,
      expected: 'no',
    });
    expect(metrics.clarificationPrecision).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(metrics.clarificationRecall.value).toBeNull();
  });
});

describe('equivalent code', () => {
  it('treats x = x + y and x += y as the same', async () => {
    const corpus = corpusOf({
      problems: { dup: PROBLEM },
      walkthroughs: { 'dup.incomplete': INCOMPLETE, 'dup.terse': TERSE },
      gold: {
        'dup.incomplete':
          'step 1\nadd root: count = 0\nstep 2\nadd root: count += 1\nstep 3\nstep 4\n',
        'dup.terse': 'step 1\nstep 2\nstep 3\n',
      },
    });
    const { steps } = await runEval(corpus, {
      translator: scriptedTranslator('explicit', {
        u1: ['add root: count = 0'],
        u2: ['add root: count = count + 1'],
      }),
      filter: { walkthroughs: ['dup.incomplete'] },
    });
    expect(steps.every(isExact)).toBe(true);
  });
});

describe('failures', () => {
  it('records a rejected batch and scores the step as producing nothing', async () => {
    const bad: Translator = {
      name: 'bad',
      translate: (context) =>
        Promise.resolve({
          batch: {
            utteranceId: context.utterance.id,
            ops: [{ op: 'remove_node', node: 'n99', provenance: [] }],
          },
          unparsedSpans: [],
        }),
    };
    const { steps, metrics } = await run(bad, 'dup.terse');
    expect(metrics.rejected).toBe(3);
    expect(steps[0]?.rejected?.code).toBe('unknown-node');
    expect(steps[0]?.code.produced).toBe(steps[0]?.code.before);
  });

  it('records a translator that throws or answers for the wrong utterance', async () => {
    const throwing: Translator = {
      name: 'throws',
      translate: () => Promise.reject(new Error('boom')),
    };
    const { steps } = await run(throwing, 'dup.terse');
    expect(steps[0]?.rejected).toEqual({ code: 'translator-error', message: 'boom' });
    const wrong: Translator = {
      name: 'wrong',
      translate: () =>
        Promise.resolve({ batch: { utteranceId: 'u99', ops: [] }, unparsedSpans: [] }),
    };
    expect((await run(wrong, 'dup.terse')).steps[0]?.rejected?.code).toBe('wrong-utterance');
    const rejectsNonError: Translator = {
      name: 'x',
      translate: () => Promise.reject(new Error('plain')),
    };
    expect((await run(rejectsNonError, 'dup.terse')).steps[0]?.rejected?.message).toBe('plain');
  });

  it('adds up usage and cost', async () => {
    const paid: Translator = {
      name: 'paid',
      translate: (context) =>
        Promise.resolve({
          batch: { utteranceId: context.utterance.id, ops: [] },
          unparsedSpans: [{ utteranceId: context.utterance.id, start: 0, end: 1 }],
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
        }),
    };
    const { metrics, steps } = await run(paid);
    expect(metrics.usage.inputTokens).toBe(700);
    expect(metrics.usage.costUsd).toBeCloseTo(0.07);
    expect(metrics.usage.costPer20).toBeCloseTo(0.2);
    expect(steps[0]?.unparsed).toBe(1);
  });
});

describe('selectWalkthroughs', () => {
  it('filters by split, problem, style and ID', () => {
    const corpus = fixture();
    const ids = (filter: Parameters<typeof selectWalkthroughs>[1]) =>
      selectWalkthroughs(corpus, filter).map((g) => g.walkthrough.id);
    expect(ids({})).toEqual(['dup.incomplete', 'dup.terse']);
    expect(ids({ split: 'test' })).toEqual([]);
    expect(ids({ split: 'train', styles: ['terse'] })).toEqual(['dup.terse']);
    expect(ids({ problems: ['other'] })).toEqual([]);
    expect(ids({ walkthroughs: ['dup.incomplete'] })).toEqual(['dup.incomplete']);
  });
});

describe('the validator', () => {
  const lexical = (input: ValidationInput) => validate(input);

  it('passes gold and reports its rates', async () => {
    const { metrics, steps } = await runEval(fixture(), {
      translator: oracleTranslator,
      validator: lexical,
    });
    expect(metrics.validation).toMatchObject({
      rejection: { numerator: 0, denominator: 7 },
      downgrade: { numerator: 0 },
      falseRejection: { numerator: 0 },
    });
    expect(metrics.validation?.downgrade.denominator).toBeGreaterThan(5);
    expect(steps[0]?.validation).toMatchObject({ heldBack: [], falselyHeld: 0 });
    expect((await run(oracleTranslator)).metrics.validation).toBeNull();
  });

  it('counts held-back gold as false rejections', async () => {
    // Validating against mumbling holds back everything gold says.
    const mumbled = (input: ValidationInput) =>
      validate({
        ...input,
        utterances: input.utterances.map((u) =>
          createUtterance(u.id, u.tokens.map(() => 'mm').join(' ')),
        ),
      });
    const { metrics, steps } = await runEval(fixture(), {
      translator: oracleTranslator,
      validator: mumbled,
    });
    expect(metrics.validation?.falseRejection.value).toBeGreaterThan(0.5);
    expect(metrics.faithfulness.value).toBe(1);
    const held = steps.flatMap((s) => s.validation?.heldBack ?? []);
    expect(held.some((h) => h.falseRejection)).toBe(true);
    const report = markdownReport({ translator: 'oracle', steps, metrics });
    expect(report).toContain('Held back (VAL003, which a gold answer supports)');
    expect(report).toMatch(/\| VAL003 \| The cited words don't say it \| \d+ \| \d+ \| \d+ \|/);
  });

  it('keeps the gaps a gap-filling translator closes', async () => {
    const open = await runEval(fixture(), { translator: fillerTranslator });
    expect(open.metrics.gapPreservation.value).toBeLessThan(1);
    const kept = await runEval(fixture(), { translator: fillerTranslator, validator: lexical });
    expect(kept.metrics.gapPreservation.value).toBe(1);
    expect(kept.metrics.validation?.rejection.numerator).toBeGreaterThan(0);
    expect(kept.translator).toBe('filler');
  });
});
