// Every scenario in scenarios/ runs end to end: no failed expectations,
// and a transcript that matches its golden file byte for byte.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScript } from '../src/console/script';
import { memoryFs } from './memory-fs';

const dir = fileURLToPath(new URL('../scenarios/', import.meta.url));
const scenarios = readdirSync(dir)
  .filter((file) => file.endsWith('.scenario'))
  .map((file) => file.slice(0, -'.scenario'.length))
  .sort();

describe('scenarios', () => {
  it('include the worked example and at least 10 more', () => {
    expect(scenarios).toContain('worked-example');
    expect(scenarios.length).toBeGreaterThanOrEqual(11);
  });

  it.each(scenarios)('%s', async (name) => {
    const fs = memoryFs();
    const result = runScript(readFileSync(`${dir}${name}.scenario`, 'utf8'), { fs });
    expect(result.failures, result.transcript).toBe(0);
    await expect(result.transcript).toMatchFileSnapshot(`golden/${name}.out`);
  });

  it('save-load-export writes the log and the code', () => {
    const fs = memoryFs();
    runScript(readFileSync(`${dir}save-load-export.scenario`, 'utf8'), { fs });
    expect(fs.files.get('total.py')).toBe(
      'total = 0\nfor num in nums:\n    if num >= 0:\n        total += num\nreturn total\n',
    );
    expect(JSON.parse(fs.files.get('session.json') ?? '')).toMatchObject({ formatVersion: 1 });
  });
});
