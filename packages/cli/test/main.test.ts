import { spawnSync } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main';
import { memoryFs } from './memory-fs';

function sink() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => (text += chunk.toString()));
  return { stream, read: () => text };
}

async function run(
  argv: string[],
  options: { stdin?: string; files?: Record<string, string> } = {},
) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, {
    stdin: Readable.from([options.stdin ?? '']),
    stdout: stdout.stream,
    stderr: stderr.stream,
    fs: memoryFs(options.files),
  });
  return { code, stdout: stdout.read(), stderr: stderr.read() };
}

const PASSING = 'say Set x.\nadd root: x = 1\nexpect code:\n  x = 1\n';
const FAILING = 'say Set x.\nadd root: x = 1\nexpect gaps none\n';

describe('main', () => {
  it.each([[['--help']], [['-h']]])('prints help for %j', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: textscript');
    expect(result.stderr).toBe('');
  });

  it.each(['--version', '-v'])('prints the version for %s', async (flag) => {
    const result = await run([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^textscript \d+\.\d+\.\d+ \(IR schema v\d+\)\n$/);
  });

  it('rejects unknown options with exit code 2', async () => {
    const result = await run(['--bogus']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--bogus'");
    expect(result.stdout).toBe('');
  });

  it.each([
    [['extra'], "unexpected argument 'extra'"],
    [['run'], 'run needs a script file'],
    [['--inputs'], '--inputs needs a value'],
  ])('rejects %j with exit code 2', async (argv, message) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('runs scripts and prints their transcripts', async () => {
    const result = await run(['run', 'a.scenario'], { files: { 'a.scenario': PASSING } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('> add root: x = 1');
    expect(result.stdout).toMatch(/a\.scenario: ok\n$/);
  });

  it('exits 1 when an expectation fails, and --quiet prints only summaries', async () => {
    const files = { 'a.scenario': PASSING, 'b.scenario': FAILING };
    const result = await run(['run', '--quiet', 'a.scenario', 'b.scenario'], { files });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('a.scenario: ok\nb.scenario: 1 failed\n');
  });

  it('passes --inputs to the analyzer', async () => {
    const script = 'say Loop.\nadd root: for x in nums:\n  print(x)\nexpect gaps none\n';
    const files = { 's.scenario': script };
    expect((await run(['run', 's.scenario'], { files })).code).toBe(1);
    expect((await run(['run', '--inputs', 'nums', 's.scenario'], { files })).code).toBe(0);
  });

  it('exits 2 when a script cannot be read', async () => {
    const result = await run(['run', 'missing.scenario']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("can't read missing.scenario");
  });

  it('starts the console with no command', async () => {
    const result = await run([], { stdin: 'say Set x.\nadd root: x = 1\n:quit\n' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('TextScript console');
    expect(result.stdout).toContain('n2 │ x = 1');
  });
});

describe('bin/textscript.js', () => {
  const bin = fileURLToPath(new URL('../bin/textscript.js', import.meta.url));

  it('runs as an executable', () => {
    const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^textscript /);
  });

  it('runs the console on piped input', () => {
    const input =
      'say Loop over the numbers.\nadd root: for num in nums:\n    print(num)\n\n:inputs nums\nshow\n';
    const result = spawnSync(process.execPath, [bin], { encoding: 'utf8', input });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('... ');
    expect(result.stdout).toContain('n6 │     print(num)');
    expect(result.stdout).toContain('(no gaps)');
  });

  it('runs a scenario file', () => {
    const scenario = fileURLToPath(
      new URL('../scenarios/worked-example.scenario', import.meta.url),
    );
    const result = spawnSync(process.execPath, [bin, 'run', '--quiet', scenario], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/worked-example\.scenario: ok\n$/);
  });
});
