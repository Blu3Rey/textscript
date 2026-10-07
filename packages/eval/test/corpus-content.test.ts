// Checks the real corpus in corpus/ against the rules in corpus/README.md
// and ANNOTATION.md, and the S6 exit criteria.

import { fileURLToPath } from 'node:url';
import { analyze } from '@textscript/core';
import { PYTHON_BUILTINS } from '@textscript/render-python';
import { emptyTranslator } from '@textscript/translator';
import { describe, expect, it } from 'vitest';
import { STYLES } from '../src/corpus/corpus';
import { loadCorpus, readCorpusDir } from '../src/corpus/load';
import { oracleTranslator, runEval } from '../src/run';

const root = fileURLToPath(new URL('../../../corpus', import.meta.url));
const files = readCorpusDir(root);
const corpus = loadCorpus(files);
const walkthroughs = [...corpus.walkthroughs.values()];

describe('the corpus', () => {
  it('has no issues', () => {
    expect(corpus.issues).toEqual([]);
  });

  it('has 30 problems and at least 60 annotated walkthroughs', () => {
    expect(corpus.problems.size).toBeGreaterThanOrEqual(30);
    expect(corpus.gold.size).toBeGreaterThanOrEqual(60);
  });

  it('gives every problem walkthroughs in at least two styles', () => {
    for (const problem of corpus.problems.values()) {
      const styles = new Set(
        walkthroughs.filter((w) => w.problem === problem.id).map((w) => w.style),
      );
      expect(styles.size, problem.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('has every style well represented', () => {
    for (const style of STYLES) {
      expect(walkthroughs.filter((w) => w.style === style).length, style).toBeGreaterThanOrEqual(
        12,
      );
    }
  });

  it('holds out about 20% of problems, covering every style', () => {
    const test = [...corpus.problems.values()].filter((p) => p.split === 'test');
    const share = test.length / corpus.problems.size;
    expect(share).toBeGreaterThanOrEqual(0.15);
    expect(share).toBeLessThanOrEqual(0.25);
    const styles = new Set(
      walkthroughs.filter((w) => test.some((p) => p.id === w.problem)).map((w) => w.style),
    );
    expect([...styles].sort()).toEqual([...STYLES].sort());
  });

  it('leaves something open at the end of every incomplete walkthrough, and says what', () => {
    for (const gold of corpus.gold.values()) {
      if (gold.walkthrough.style !== 'incomplete') continue;
      const id = gold.walkthrough.id;
      expect(files.gold.get(id), id).toMatch(/^# Left out: /);
      const inputs = corpus.problems.get(gold.walkthrough.problem)?.inputs ?? [];
      const gaps = analyze(gold.final.document.program, {
        builtins: PYTHON_BUILTINS,
        inputs,
      }).diagnostics.filter((d) => d.severity === 'gap');
      expect(gaps.length, id).toBeGreaterThan(0);
    }
  });

  it('corrects earlier code in a later utterance in every corrective walkthrough', () => {
    const corrections = new Set([
      'update_field',
      'replace_node',
      'remove_node',
      'move_node',
      'rename_symbol',
    ]);
    for (const gold of corpus.gold.values()) {
      if (gold.walkthrough.style !== 'corrective') continue;
      const ops = gold.steps.flatMap((step) => step.alternatives[0]?.batch.ops ?? []);
      expect(
        ops.some((op) => corrections.has(op.op)),
        gold.walkthrough.id,
      ).toBe(true);
    }
  });

  it('never ships a solution in a problem statement', () => {
    for (const problem of corpus.problems.values()) {
      expect(problem.statement, problem.id).not.toMatch(/```python|\bdef \w+\(/);
    }
  });
});

describe('the corpus against the stub translators', () => {
  it('the oracle replays gold perfectly', async () => {
    const { metrics } = await runEval(corpus, { translator: oracleTranslator });
    expect(metrics.steps).toBeGreaterThan(200);
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
  }, 60_000);

  it('the empty translator keeps every gap and covers nothing', async () => {
    const { metrics } = await runEval(corpus, { translator: emptyTranslator });
    expect(metrics.gapPreservation.value).toBe(1);
    expect(metrics.coverage.value).toBe(0);
  }, 60_000);
});
