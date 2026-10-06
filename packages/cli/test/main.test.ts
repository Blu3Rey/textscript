import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main';

function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

describe('main', () => {
  it.each([[[]], [['--help']], [['-h']]])('prints help for %j', (argv) => {
    const result = run(argv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: textscript');
    expect(result.stderr).toBe('');
  });

  it.each(['--version', '-v'])('prints the version for %s', (flag) => {
    const result = run([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^textscript \d+\.\d+\.\d+ \(IR schema v\d+\)\n$/);
  });

  it('rejects unknown options with exit code 2', () => {
    const result = run(['--bogus']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--bogus'");
    expect(result.stdout).toBe('');
  });

  it('rejects extra arguments with exit code 2', () => {
    const result = run(['--help', 'extra']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unexpected argument 'extra'");
  });
});

describe('bin/textscript.js', () => {
  it('runs as an executable', () => {
    const bin = fileURLToPath(new URL('../bin/textscript.js', import.meta.url));
    const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^textscript /);
  });
});
