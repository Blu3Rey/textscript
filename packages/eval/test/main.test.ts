import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main';
import { INCOMPLETE, INCOMPLETE_GOLD, PROBLEM, TERSE, TERSE_GOLD } from './helpers';

function corpusDir(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'textscript-eval-'));
  const files: Record<string, string> = {
    'problems/dup.md': PROBLEM,
    'walkthroughs/dup.incomplete.txt': INCOMPLETE,
    'walkthroughs/dup.terse.txt': TERSE,
    'gold/dup.incomplete.gold': INCOMPLETE_GOLD,
    'gold/dup.terse.gold': TERSE_GOLD,
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe('textscript-eval', () => {
  it('prints help', async () => {
    for (const argv of [[], ['--help'], ['run', '-h']]) {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage: textscript-eval');
    }
  });

  it('rejects bad usage with exit code 2', async () => {
    for (const [argv, message] of [
      [['frobnicate', '--corpus', corpusDir()], "unknown command 'frobnicate'"],
      [['run', '--colour', 'red'], "unknown option '--colour'"],
      [['run', '--out'], '--out needs a value'],
      [['run', '--corpus', corpusDir(), '--translator', 'llm'], "unknown translator 'llm'"],
      [['run', '--corpus', corpusDir(), '--split', 'dev'], "unknown split 'dev'"],
      [['run', '--corpus', corpusDir(), '--style', 'chatty'], "unknown style 'chatty'"],
    ] as const) {
      const result = await run([...argv]);
      expect(result.code, message).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });

  it('checks a corpus and prints counts', async () => {
    const result = await run(['check', '--corpus', corpusDir()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'Problems: 1 (train 1)',
        'Walkthroughs: 2 (incomplete 1, terse 1)',
        'Annotated: 2 walkthroughs, 7 utterances, 1 with more than one acceptable answer',
        'No issues.',
        '',
      ].join('\n'),
    );
  });

  it('reports corpus issues and refuses to run on them', async () => {
    const root = corpusDir({ 'gold/dup.terse.gold': 'step 1\n' });
    const check = await run(['check', '--corpus', root]);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain(
      'gold/dup.terse.gold: The walkthrough has 3 utterances but the gold has 1 steps',
    );
    const result = await run(['run', '--corpus', root]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('the corpus has issues');
  });

  it('runs a translator, writes reports and a baseline, and gates against it', async () => {
    const root = corpusDir();
    const out = join(root, 'out');
    const baseline = join(root, 'baseline.json');
    const oracle = await run([
      'run',
      '--corpus',
      root,
      '--translator',
      'oracle',
      '--out',
      out,
      '--write-baseline',
      baseline,
    ]);
    expect(oracle.code).toBe(0);
    expect(oracle.stdout).toContain(
      '| Faithfulness: produced nodes a gold answer supports | 100.0% |',
    );
    expect(oracle.stdout).toContain(`0 steps don't match; details in ${join(out, 'report.md')}.`);
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('# Evaluation: oracle');
    expect(readFileSync(join(out, 'report.html'), 'utf8')).toContain('<!doctype html>');
    expect(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))).toMatchObject({
      translator: 'oracle',
    });
    expect(JSON.parse(readFileSync(baseline, 'utf8'))).toMatchObject({ faithfulness: 1 });

    const passing = await run([
      'run',
      '--corpus',
      root,
      '--translator',
      'oracle',
      '--baseline',
      baseline,
    ]);
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain('✓ Faithfulness: 100.00% (baseline 100.00%)');

    const empty = await run([
      'run',
      '--corpus',
      root,
      '--baseline',
      baseline,
      '--style',
      'terse',
      '--split',
      'train',
    ]);
    expect(empty.stdout).toContain("2 steps don't match; use --out for details.");
    expect(empty.code).toBe(1);
    expect(empty.stdout).toContain(
      '✗ Gap preservation (incomplete walkthroughs): – (baseline 100.00%)',
    );

    writeFileSync(baseline, '{"nope": true}');
    const bad = await run(['run', '--corpus', root, '--baseline', baseline]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('is not a baseline');
  });

  it('filters by problem and walkthrough', async () => {
    const root = corpusDir();
    const result = await run([
      'run',
      '--corpus',
      root,
      '--translator',
      'oracle',
      '--problem',
      'dup',
      '--walkthrough',
      'dup.terse',
    ]);
    expect(result.stdout).toContain('1 walkthroughs, 3 steps.');
  });

  it('shows gold step by step, with IDs and gaps', async () => {
    const result = await run(['gold', 'dup.incomplete', '--corpus', corpusDir()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Step 1 (u1): 0:Loop 1:through 2:the 3:list 4:of 5:numbers 6:.',
    );
    expect(result.stdout).toContain('  n2 │ for num in nums:');
    expect(result.stdout).toContain('  gaps: GAP003');
    const missing = await run(['gold', 'nope', '--corpus', corpusDir()]);
    expect(missing.code).toBe(2);
  });

  it('shows a draft up to the step that fails', async () => {
    const root = corpusDir({
      'gold/dup.terse.gold': 'step 1\nadd root: seen = set()\nstep 2\nremove n99\nstep 3\n',
    });
    const result = await run(['gold', 'dup.terse', '--corpus', root]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('n2 │ seen = set()');
    expect(result.stderr).toContain('There is no node n99');
    expect(result.stderr).toContain('Stopped after step 1.');
  });

  it('compares second annotations', async () => {
    const root = corpusDir({
      'agreement/dup.terse.gold':
        'step 1\nadd root: seen = []\nstep 2\nstep 3\nadd root:\n  for num in nums:\n    if num in seen:\n      return True\n',
    });
    const result = await run(['agree', '--corpus', root]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dup.terse: 2/3 steps identical');
    expect(result.stdout).toMatch(
      /Overall: 2\/3 steps identical \(66\.7%\), mean node F1 0\.\d+, holes in common –/,
    );

    const broken = join(root, 'broken.gold');
    writeFileSync(broken, 'step 1\nremove n9\n');
    const failing = await run(['agree', '--corpus', root, broken, join(root, 'gold', 'x.gold')]);
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("no compiled corpus gold for 'broken'");

    const renamed = join(root, 'dup.incomplete.gold');
    writeFileSync(renamed, 'step 1\nremove n9\n');
    const bad = await run(['agree', '--corpus', root, renamed]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('There is no node n9');

    expect((await run(['agree', '--corpus', corpusDir()])).code).toBe(2);
  });
});

describe('bin/eval.js', () => {
  it('runs as an executable', () => {
    const bin = fileURLToPath(new URL('../bin/eval.js', import.meta.url));
    const result = spawnSync(process.execPath, [bin, 'check', '--corpus', corpusDir()], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No issues.');
  });
});
