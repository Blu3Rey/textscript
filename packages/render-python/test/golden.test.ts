import { createBuilder, parseDocument } from '@textscript/core';
import { describe, expect, it } from 'vitest';
import { render } from '../src';
import { CASES } from './cases';

// Export goldens are .py files, so `pnpm check:python` parses every one.
// After an intended output change, run `pnpm test -u` and review the diff.

it('has at least 40 golden cases with unique names', () => {
  expect(CASES.length).toBeGreaterThanOrEqual(40);
  expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
});

describe.each(CASES)('$name', (c) => {
  const b = createBuilder();
  const program = c.build(b);

  it('is a valid IR document', () => {
    const result = parseDocument(b.document(program));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('renders for export', async () => {
    await expect(render(program).text).toMatchFileSnapshot(`./golden/${c.name}.py`);
  });

  it('renders for the UI', async () => {
    await expect(render(program, { mode: 'ui' }).text).toMatchFileSnapshot(
      `./golden/${c.name}.ui.txt`,
    );
  });
});
