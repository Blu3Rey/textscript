import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessagesApi, ModelReply } from '@textscript/translator';
import { describe, expect, it, vi } from 'vitest';
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

async function run(argv: string[], messages?: MessagesApi) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    ...(messages ? { messages } : {}),
  });
  return { code, stdout, stderr };
}

/** A Claude API that understands nothing, and records the efforts it was asked for. */
function silentClaude(): MessagesApi & { efforts: string[] } {
  const efforts: string[] = [];
  return {
    efforts,
    create(params) {
      efforts.push(params.output_config?.effort ?? 'none');
      const reply: ModelReply = {
        content: [{ type: 'text', text: '{"commands":[],"unparsed":[]}', citations: null }],
        stop_reason: 'end_turn',
        model: params.model,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      return Promise.resolve(reply);
    },
  };
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

  it('runs the Claude translator with a model and effort', async () => {
    const claude = silentClaude();
    const result = await run(
      [
        'run',
        '--corpus',
        corpusDir(),
        '--translator',
        'claude',
        '--effort',
        'low',
        '--concurrency',
        '2',
      ],
      claude,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Evaluation: claude:claude-opus-5-5:low');
    expect(result.stdout).toContain('per 20 utterances');
    expect(claude.efforts).toEqual(Array.from({ length: 7 }, () => 'low'));
    for (const [argv, message] of [
      [['--effort', 'huge'], "unknown effort 'huge'"],
      [['--concurrency', '0'], '--concurrency needs a positive integer'],
    ] as const) {
      const bad = await run(
        ['run', '--corpus', corpusDir(), '--translator', 'claude', ...argv],
        claude,
      );
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain(message);
    }
  });

  it('validates by default, with a second opinion on request, or not at all', async () => {
    const root = corpusDir();
    const lexical = await run(['run', '--corpus', root, '--translator', 'filler']);
    expect(lexical.stdout).toContain('## Validator');
    expect(lexical.stdout).toContain('| False rejections: gold-supported units held back |');
    const off = await run([
      'run',
      '--corpus',
      root,
      '--translator',
      'filler',
      '--validator',
      'off',
    ]);
    expect(off.stdout).not.toContain('## Validator');
    const claude = silentClaude();
    const verified = await run(
      ['run', '--corpus', root, '--translator', 'oracle', '--validator', 'verified'],
      claude,
    );
    expect(verified.code).toBe(0);
    expect(claude.efforts.length).toBeGreaterThan(0);
    const bad = await run(['run', '--corpus', root, '--validator', 'strict']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown validator 'strict'");
  });

  it('needs an API key for Claude', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const result = await run(['run', '--corpus', corpusDir(), '--translator', 'claude']);
    vi.unstubAllEnvs();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('needs ANTHROPIC_API_KEY');
  });

  it('sweeps efforts and writes a report for each', async () => {
    const root = corpusDir();
    const claude = silentClaude();
    const result = await run(
      ['sweep', '--corpus', root, '--efforts', 'low,high', '--out', join(root, 'sweep')],
      claude,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Effort sweep: claude-opus-5-5');
    expect(result.stdout).toMatch(/\| low \| – \| 100\.0% \| .* \| \$0\.\d{4} \|/);
    expect(result.stdout).toContain('| high |');
    expect(new Set(claude.efforts)).toEqual(new Set(['low', 'high']));
    expect(readFileSync(join(root, 'sweep', 'high', 'report.md'), 'utf8')).toContain(
      '# Evaluation: claude:claude-opus-5-5:high',
    );
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

  it('shows another annotation of a walkthrough with --file', async () => {
    const root = corpusDir({
      'mine.gold': 'step 1\nadd root: seen = []\nstep 2\nstep 3\nremove n9\n',
    });
    const result = await run([
      'gold',
      'dup.terse',
      '--corpus',
      root,
      '--file',
      join(root, 'mine.gold'),
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('n2 │ seen = []');
    expect(result.stderr).toContain('There is no node n9');
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
      /Overall: 2\/3 steps identical \(66\.7%\), 1 with the same acceptable answers \(33\.3%\), mean node F1 0\.\d+, holes in common –/,
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
