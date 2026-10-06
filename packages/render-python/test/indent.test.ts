import { describe, expect, it } from 'vitest';
import { INDENT_UNIT, indentLines } from '../src/index';

describe('indentLines', () => {
  it('returns lines unchanged at depth 0', () => {
    expect(indentLines(['x = 1', 'y = 2'], 0)).toEqual(['x = 1', 'y = 2']);
  });

  it('prefixes one indent unit per level', () => {
    expect(indentLines(['pass'], 2)).toEqual([INDENT_UNIT + INDENT_UNIT + 'pass']);
  });

  it('leaves empty lines empty', () => {
    expect(indentLines(['a = 1', '', 'b = 2'], 1)).toEqual(['    a = 1', '', '    b = 2']);
  });

  it.each([-1, 1.5, Number.NaN])('rejects depth %s', (depth) => {
    expect(() => indentLines(['pass'], depth)).toThrow(RangeError);
  });
});

// Golden-file convention: expected renderer output lives in test/golden/*.py.
// Run `pnpm test -u` to rewrite goldens after an intended change, then review
// the diff. CI never writes goldens, and `pnpm check:python` parses every one.
describe('golden output', () => {
  it('renders nested blocks', async () => {
    const lines = [
      'def contains_duplicate(nums):',
      ...indentLines(
        [
          'seen = set()',
          'for num in nums:',
          ...indentLines(['if num in seen:', ...indentLines(['return True'], 1)], 1),
          ...indentLines(['seen.add(num)'], 1),
          '',
          'return False',
        ],
        1,
      ),
    ];
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./golden/nested-blocks.py');
  });
});
