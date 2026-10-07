// Tokens for one line of a snippet (see parser.ts for the language).

export type TokenKind =
  | 'name'
  | 'number'
  | 'string'
  | 'op'
  /** `~rule`: the node was inferred by an allowed-inference rule. */
  | 'infer'
  /** `@start:end`: the node came from these tokens of the utterance. */
  | 'span'
  /** `?`, `?cond`, `?name`, `?value`, `?ref`: a hole. */
  | 'hole'
  /** `...`: a block hole, or a step not yet described. */
  | 'ellipsis';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Column of the first character, 0-based. */
  column: number;
  /** Decoded value for strings and numbers. */
  value?: string | number;
}

export class SnippetError extends Error {
  readonly column: number;

  constructor(message: string, column: number) {
    super(message);
    this.name = 'SnippetError';
    this.column = column;
  }
}

/** Longest first, so `//=` wins over `//` and `/`. */
const OPERATORS = [
  '//=',
  '**',
  '//',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
  '.',
];

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const INFER = /~([a-z][a-z-]*)/y;
const SPAN = /@(\d+):(\d+)/y;
const HOLE = /\?(cond|name|value|ref)?/y;

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '0': '\0',
};

function readString(line: string, start: number): { value: string; end: number } {
  const quote = line.charAt(start);
  let value = '';
  let i = start + 1;
  while (i < line.length) {
    const char = line.charAt(i);
    if (char === quote) return { value, end: i + 1 };
    if (char !== '\\') {
      value += char;
      i += 1;
      continue;
    }
    const next = line.charAt(i + 1);
    if (next === 'x' || next === 'u') {
      const width = next === 'x' ? 2 : 4;
      const hex = line.slice(i + 2, i + 2 + width);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) {
        throw new SnippetError(`Bad \\${next} escape`, i);
      }
      value += String.fromCharCode(parseInt(hex, 16));
      i += 2 + width;
    } else if (next in ESCAPES) {
      value += ESCAPES[next] ?? '';
      i += 2;
    } else {
      throw new SnippetError(`Unknown escape \\${next}`, i);
    }
  }
  throw new SnippetError('Unterminated string', start);
}

/** Splits code (without its comment) into tokens. */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const sticky = (pattern: RegExp) => {
    pattern.lastIndex = i;
    return pattern.exec(line);
  };
  while (i < line.length) {
    const char = line.charAt(i);
    if (char === ' ' || char === '\t') {
      i += 1;
      continue;
    }
    if (line.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis', text: '...', column: i });
      i += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      const { value, end } = readString(line, i);
      tokens.push({ kind: 'string', text: line.slice(i, end), column: i, value });
      i = end;
      continue;
    }
    const number =
      /[0-9]/.test(char) || (char === '.' && /[0-9]/.test(line.charAt(i + 1)))
        ? sticky(NUMBER)
        : null;
    if (number) {
      tokens.push({ kind: 'number', text: number[0], column: i, value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const name = sticky(NAME);
    if (name) {
      tokens.push({ kind: 'name', text: name[0], column: i });
      i += name[0].length;
      continue;
    }
    const infer = sticky(INFER);
    if (infer) {
      tokens.push({ kind: 'infer', text: infer[1] ?? '', column: i });
      i += infer[0].length;
      continue;
    }
    const span = sticky(SPAN);
    if (span) {
      tokens.push({ kind: 'span', text: span[0], column: i });
      i += span[0].length;
      continue;
    }
    const hole = sticky(HOLE);
    if (hole) {
      tokens.push({ kind: 'hole', text: hole[1] ?? '', column: i });
      i += hole[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => line.startsWith(candidate, i));
    if (op !== undefined) {
      tokens.push({ kind: 'op', text: op, column: i });
      i += op.length;
      continue;
    }
    throw new SnippetError(`Unexpected character "${char}"`, i);
  }
  return tokens;
}

/**
 * Splits a line into its code and its comment (the text after a `#` that
 * isn't inside a string).
 */
export function splitComment(line: string): { code: string; comment?: string } {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (quote !== undefined) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return { code: line.slice(0, i), comment: line.slice(i + 1).trim() };
    }
  }
  return { code: line };
}
