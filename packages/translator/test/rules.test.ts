import { apply, createUtterance, emptySession, type IrDocument, type Span } from '@textscript/core';
import { render } from '@textscript/render-python';
import { describe, expect, it } from 'vitest';
import { rulesTranslator, translateWithRules } from '../src/index';

const problem = { id: 'p', title: 'P', statement: 'S', inputs: ['nums', 'target'] };

/** Says each utterance in turn; returns the code and the words left out. */
function say(...utterances: string[]): { code: string; unparsed: Span[] } {
  let document: IrDocument = emptySession().document;
  const unparsed: Span[] = [];
  utterances.forEach((text, i) => {
    const translation = translateWithRules({
      utterance: createUtterance(`u${String(i + 1)}`, text),
      document,
      recent: [],
      problem,
    });
    const result = apply(document, translation.batch);
    if (!result.ok) throw new Error(result.error.message);
    document = result.document;
    unparsed.push(...translation.unparsedSpans);
  });
  return { code: render(document.program).text, unparsed };
}

describe('the rules translator', () => {
  it('builds collections, loops, conditions and returns', () => {
    const { code, unparsed } = say(
      'Make a set called seen.',
      'For each num in nums, if num is in seen, return true. Otherwise add num to seen.',
      'After the loop, return false.',
    );
    expect(code).toBe(
      [
        'seen = set()',
        'for num in nums:',
        '    if num in seen:',
        '        return True',
        '    else:',
        '        seen.add(num)',
        'return False',
        '',
      ].join('\n'),
    );
    expect(unparsed).toEqual([]);
  });

  it('puts returns after the open loop, and a place said alone applies to the next clause', () => {
    expect(
      say('A list called out.', 'For each num in nums, append num to out.', 'Return out.').code,
    ).toBe(['out = []', 'for num in nums:', '    out.append(num)', 'return out', ''].join('\n'));
    // An open block hole takes a bare return; "after the loop" skips it.
    expect(say('Loop over the indices of nums.', 'Return target.').code).toBe(
      ['for i in range(len(nums)):', '    return target', ''].join('\n'),
    );
    expect(say('Loop over the indices of nums.', 'After that loop, return target.').code).toBe(
      [
        'for i in range(len(nums)):',
        '    ...  # TODO(textscript): body not described',
        'return target',
        '',
      ].join('\n'),
    );
    expect(
      say(
        'Write a function reverse that takes node.',
        'Return node.',
        'Outside the function, return reverse of node.',
      ).code,
    ).toBe(
      ['def reverse(node):', '    return node', '', '', 'return reverse(node)', ''].join('\n'),
    );
  });

  it('leaves what it cannot read as holes, never guesses', () => {
    const { code, unparsed } = say(
      'A stack called stack.',
      'For each ch in nums, push ch onto the stack.',
      'At the end, return true if the stack is empty.',
      'Return the answer.',
    );
    expect(code).toContain('if __hole__("the stack is empty"):\n    return True');
    expect(code).toContain('return __hole__("the answer")');
    expect(code).toContain('    stack.append(ch)\n');
    expect(unparsed).toEqual([]);
  });

  it('reports clauses it cannot read, and pronouns nobody resolved', () => {
    const { code, unparsed } = say(
      'A dictionary called counts.',
      'Blah blah, increment total, return it.',
    );
    expect(code).toBe(['counts = {}', 'return __hole__("it")', ''].join('\n'));
    expect(unparsed).toEqual([
      { utteranceId: 'u2', start: 0, end: 2 },
      { utteranceId: 'u2', start: 3, end: 5 },
    ]);
  });

  it('reads while loops, steps, swaps, remarks, sorting and literal code', () => {
    const { code } = say(
      'Left starts at 0.',
      'While left is less than the length of nums, left goes up by one.',
      'Swap left and target.',
      'It runs in linear time.',
      'Sort nums.',
    );
    expect(code).toBe(
      [
        '# Complexity: It runs in linear time',
        'left = 0',
        'while left < len(nums):',
        '    left += 1',
        '    # swap left and target',
        '    ...',
        '    nums.sort()',
        '',
      ].join('\n'),
    );
    expect(say('Lo starts at 0.', 'lo += 1', 'Rename lo to low.').code).toBe(
      ['low = 0', 'low += 1', ''].join('\n'),
    );
  });

  it('stores into maps and breaks out of loops', () => {
    expect(
      say(
        'A dictionary called seen.',
        'For each num in nums, store num in seen under target. Then break.',
      ).code,
    ).toBe(['seen = {}', 'for num in nums:', '    seen[target] = num', '    break', ''].join('\n'));
  });

  it('runs as a translator', async () => {
    const translation = await rulesTranslator.translate({
      utterance: createUtterance('u1', 'Make a set called seen.'),
      document: emptySession().document,
      recent: [],
      problem,
    });
    expect(rulesTranslator.name).toBe('rules');
    expect(translation.batch.ops.map((op) => op.op)).toEqual(['add_stmt']);
  });
});
