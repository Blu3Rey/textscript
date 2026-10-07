import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runRepl } from '../src/console/repl';
import { memoryFs } from './memory-fs';

async function session(lines: string[]) {
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => (text += chunk.toString()));
  await runRepl({ input: Readable.from([lines.join('\n') + '\n']), output, fs: memoryFs() });
  return text;
}

describe('runRepl', () => {
  it('reads a block until a blank line when a line ends with a colon', async () => {
    const text = await session([
      'say Loop.',
      'add root:',
      '  for x in xs:',
      '    print(x)',
      '',
      'show',
    ]);
    expect(text).toContain('ts> ... ... ... ');
    expect(text).toContain('│     print(x)');
  });

  it('runs wrap and meta commands on one line', async () => {
    const text = await session(['say A.', 'add root: a = 1', 'wrap n2: if ready:', ':log']);
    expect(text).toContain('wrap_nodes');
    expect(text).toContain('u1  "A."  add_stmt, wrap_nodes (pending)');
  });

  it('stops at :quit', async () => {
    const text = await session([':quit', ':help']);
    expect(text).not.toContain('Commands');
  });

  it('prints errors and carries on', async () => {
    const text = await session(['nonsense', ':help']);
    expect(text).toContain('✗ unknown-command');
    expect(text).toContain('Commands');
  });
});
