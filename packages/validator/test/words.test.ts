import { createUtterance } from '@textscript/core';
import { describe, expect, it } from 'vitest';
import { inflects, nameParts, nameSaid, partMatches, Words } from '../src/index';

function words(text: string): Words {
  const utterance = createUtterance('u1', text);
  return Words.of([{ utteranceId: 'u1', start: 0, end: utterance.tokens.length }], [utterance]);
}

describe('Words', () => {
  it('matches cue phrases and their inflections', () => {
    const w = words("If it's at least ten, we stopped and added it.");
    expect(w.has('at least')).toBe(true);
    expect(w.has('add')).toBe(true);
    expect(w.has('stop')).toBe(true);
    expect(w.has('least ten we')).toBe(false);
    expect(w.has('')).toBe(false);
    expect(w.hasAny(['nope', "it's"])).toBe(true);
    expect(inflects('increasing', 'increase')).toBe(true);
    expect(inflects('ins', 'in')).toBe(true);
    expect(inflects('index', 'in')).toBe(false);
  });

  it('finds every number said, in words or digits', () => {
    expect(
      [...words('Twenty-six zeros, then 3.5 and a hundred, twice.').numbers()].sort(
        (a, b) => a - b,
      ),
    ).toEqual([0, 2, 3.5, 6, 20, 26, 100]);
    expect(words('twenty six').numberPositions(26)).toEqual([0]);
    expect(words('twenty six').numberPositions(6)).toEqual([1]);
  });

  it('keeps spans apart and knows which sentence a word is in', () => {
    const one = createUtterance('u1', 'Add one.');
    const two = createUtterance('u2', 'Then stop.');
    const w = Words.of(
      [
        { utteranceId: 'u1', start: 0, end: 2 },
        { utteranceId: 'u2', start: 0, end: 2 },
        { utteranceId: 'u9', start: 0, end: 1 },
      ],
      [one, two],
    );
    expect(w.text).toBe('add one then stop');
    expect(w.has('one then')).toBe(false);
    expect(w.near(0, 1, 6)).toBe(true);
    expect(w.near(1, 3, 6)).toBe(false);
    expect(words('a b c d e f g h').near(0, 7, 6)).toBe(false);
  });
});

describe('names', () => {
  it('splits names into parts', () => {
    expect(nameParts('max_len')).toEqual(['max', 'len']);
    expect(nameParts('maxLen')).toEqual(['max', 'len']);
  });

  it('matches abbreviations, plurals and prefixes, but not short words for long names', () => {
    expect(partMatches('nums', 'numbers')).toBe(true);
    expect(partMatches('cnt', 'count')).toBe(true);
    expect(partMatches('lo', 'low')).toBe(true);
    expect(partMatches('count', 'counts')).toBe(true);
    expect(partMatches('index', 'in')).toBe(false);
    expect(partMatches('numbers', 'num')).toBe(true);
    expect(partMatches('dq', 'deque')).toBe(false);
    expect(partMatches('ways', 'way')).toBe(true);
    expect(partMatches('x', '')).toBe(false);
  });

  it('says a name by parts, run-together words, initials or synonyms', () => {
    expect(nameSaid('max_len', words('the max length so far'))).toBe(true);
    expect(nameSaid('twosum', words('call it two sum'))).toBe(true);
    expect(nameSaid('dp', words('a dynamic programming table'))).toBe(true);
    expect(nameSaid('i', words('each index'), { i: ['index'] })).toBe(true);
    expect(nameSaid('seen', words('a set of numbers'))).toBe(false);
    expect(nameSaid('', words('anything'))).toBe(false);
  });
});
