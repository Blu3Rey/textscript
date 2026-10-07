// The words a node cites, and the ways a word can support code: a cue
// phrase, a number, or a name (docs/adr/013).

import { tokenize, type Span, type Utterance } from '@textscript/core';

const SUFFIXES: readonly string[] = ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers', 'est', 'ly', "'s"];

/** Lowercase, with curly apostrophes straightened. */
export function normalize(text: string): string {
  return text.toLowerCase().replaceAll('’', "'");
}

/** Whether `token` is `cue` or an inflection of it: "adds", "added", "adding". */
export function inflects(token: string, cue: string): boolean {
  if (token === cue) return true;
  for (const base of cue.endsWith('e') ? [cue, cue.slice(0, -1)] : [cue]) {
    if (token.startsWith(base) && SUFFIXES.includes(token.slice(base.length))) return true;
  }
  // "stopped", "dropping": a doubled final consonant.
  const last = cue.at(-1);
  return (
    last !== undefined &&
    /[bdgmnprt]/.test(last) &&
    token.startsWith(cue + last) &&
    ['ed', 'ing', 'er'].includes(token.slice(cue.length + 1))
  );
}

const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  half: 2,
  twice: 2,
  double: 2,
  once: 1,
  single: 1,
  pair: 2,
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};

/** The words of some spans, ready to be searched. */
export class Words {
  /** Lowercased tokens; `''` separates spans so phrases don't cross them. */
  readonly tokens: readonly string[];

  /**
   * Sentence number of each token. Commas don't end one: spoken formulas
   * run across them ("the width, so right minus left, times the height").
   */
  readonly sentences: readonly number[];

  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
    let sentence = 0;
    this.sentences = tokens.map((token) => {
      if (token === '' || ['.', ';', '!', '?', ':'].includes(token)) sentence++;
      return sentence;
    });
  }

  /** Whether two positions are in the same sentence and at most `distance` words apart. */
  near(a: number, b: number, distance: number): boolean {
    return Math.abs(a - b) <= distance && this.sentences[a] === this.sentences[b];
  }

  static of(spans: readonly Span[], utterances: readonly Utterance[]): Words {
    const tokens: string[] = [];
    for (const span of spans) {
      const utterance = utterances.find((u) => u.id === span.utteranceId);
      if (utterance === undefined) continue;
      if (tokens.length > 0) tokens.push('');
      for (const token of utterance.tokens.slice(span.start, span.end))
        tokens.push(normalize(token.text));
    }
    return new Words(tokens);
  }

  get text(): string {
    return this.tokens.filter(Boolean).join(' ');
  }

  /** Whether a cue phrase ("at least", ">=", "add") occurs, inflections allowed. */
  has(cue: string): boolean {
    const parts = tokenize(normalize(cue)).map((t) => t.text);
    const [first] = parts;
    if (first === undefined) return false;
    for (let i = 0; i + parts.length <= this.tokens.length; i++) {
      if (parts.every((part, j) => inflects(this.tokens[i + j] ?? '', part))) return true;
    }
    return false;
  }

  hasAny(cues: readonly string[]): boolean {
    return cues.some((cue) => this.has(cue));
  }

  /** Where each occurrence of any of the cue phrases starts. */
  positions(cues: readonly string[]): number[] {
    const found: number[] = [];
    for (const cue of cues) {
      const parts = tokenize(normalize(cue)).map((t) => t.text);
      if (parts.length === 0) continue;
      for (let i = 0; i + parts.length <= this.tokens.length; i++) {
        if (parts.every((part, j) => inflects(this.tokens[i + j] ?? '', part))) found.push(i);
      }
    }
    return found;
  }

  /** Where number words, digits and their compounds occur that say `value`. */
  numberPositions(value: number): number[] {
    return this.tokens.flatMap((_, i) =>
      new Words(this.tokens.slice(i, i + 3)).numbers().has(value) &&
      !new Words(this.tokens.slice(i + 1, i + 3)).numbers().has(value)
        ? [i]
        : [],
    );
  }

  /** Every number said: digits, number words ("twenty-six"), and words that imply one. */
  numbers(): Set<number> {
    const found = new Set<number>();
    const { tokens } = this;
    tokens.forEach((token, i) => {
      if (/^\d+(?:\.\d+)?$/.test(token)) found.add(Number(token));
      const unit = UNITS[token] ?? UNITS[token.replace(/s$/, '')];
      if (unit !== undefined) found.add(unit);
      const ordinal = ORDINALS[token];
      if (ordinal !== undefined) found.add(ordinal);
      const tens = TENS[token];
      if (tens !== undefined) {
        found.add(tens);
        // "twenty six", "twenty-six"
        const next = tokens[i + 1] === '-' ? tokens[i + 2] : tokens[i + 1];
        const ones = next === undefined ? undefined : UNITS[next];
        if (ones !== undefined && ones < 10) found.add(tens + ones);
      }
    });
    return found;
  }
}

/** `max_len` → `max`, `len`; `maxLen` → `max`, `len`. */
export function nameParts(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/_+/)
    .filter(Boolean);
}

function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es') && /(?:x|ch|sh|ss)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') && !word.endsWith('ss') && word.length > 2 ? word.slice(0, -1) : word;
}

function isSubsequence(part: string, word: string): boolean {
  let i = 0;
  for (const char of word) if (char === part[i]) i++;
  return i === part.length;
}

/**
 * Whether one part of a name is said by one word: the same word, singular
 * or plural, a prefix ("num", "numbers"), or an abbreviation that keeps
 * the first letter ("cnt", "count").
 */
export function partMatches(part: string, word: string): boolean {
  if (word === '' || part === '') return false;
  if (part === word || singular(part) === singular(word)) return true;
  if (part.length < 2 || !word.startsWith(part.charAt(0))) return false;
  // "lo" for "low"; but a short word ("in") doesn't say a longer name ("index").
  if (word.startsWith(part)) return true;
  if (part.startsWith(word)) return word.length >= 3;
  return part.length * 2 >= word.length && isSubsequence(part, word);
}

/** Where words that say some part of a name occur. */
export function namePositions(
  name: string,
  words: Words,
  synonyms: Readonly<Record<string, readonly string[]>> = {},
): number[] {
  const parts = nameParts(name);
  const found = new Set<number>();
  words.tokens.forEach((word, i) => {
    if (parts.some((part) => partMatches(part, word))) found.add(i);
  });
  for (const part of parts) for (const i of words.positions(synonyms[part] ?? [])) found.add(i);
  return [...found];
}

/** Whether a name is said: each part by a word, by adjacent words run together, or as initials. */
export function nameSaid(
  name: string,
  words: Words,
  synonyms: Readonly<Record<string, readonly string[]>> = {},
): boolean {
  const tokens = words.tokens.filter((t) => /^[\p{L}\p{N}_']+$/u.test(t));
  const said = (part: string): boolean => {
    if (tokens.some((word) => partMatches(part, word))) return true;
    if ((synonyms[part] ?? []).some((cue) => words.has(cue))) return true;
    for (let i = 0; i < tokens.length; i++) {
      // "dp" for "dynamic programming", "twosum" for "two sum"
      for (const length of [2, 3]) {
        const run = tokens.slice(i, i + length);
        if (run.length < length) continue;
        if (part.length >= 2 && run.map((w) => w[0]).join('') === part) return true;
        if (partMatches(part, run.join(''))) return true;
      }
    }
    return false;
  };
  const parts = nameParts(name);
  return parts.length > 0 && (parts.every(said) || said(parts.join('')));
}
