// Python lexical details: which names are reserved, and how to write names,
// numbers, strings and comments so the output always parses.

/** Hard keywords. Soft keywords (`match`, `case`, `type`, `_`) are valid names. */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/**
 * Built-in functions and types an interview solution commonly uses. Pass
 * these to `buildSymbolTable` so `len(nums)` doesn't count as an undefined
 * name.
 */
export const PYTHON_BUILTINS: ReadonlySet<string> = new Set([
  'abs',
  'all',
  'any',
  'bool',
  'chr',
  'dict',
  'divmod',
  'enumerate',
  'filter',
  'float',
  'frozenset',
  'hash',
  'input',
  'int',
  'isinstance',
  'iter',
  'len',
  'list',
  'map',
  'max',
  'min',
  'next',
  'ord',
  'pow',
  'print',
  'range',
  'reversed',
  'round',
  'set',
  'sorted',
  'str',
  'sum',
  'tuple',
  'type',
  'zip',
]);

/**
 * A name as it appears in Python. Keywords get a trailing underscore
 * (PEP 8's convention), so a user who calls something `class` gets `class_`.
 */
export function pythonName(name: string): string {
  return PYTHON_KEYWORDS.has(name) ? `${name}_` : name;
}

/** A double-quoted Python string literal for any JavaScript string. */
export function pythonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const char = value.charAt(i);
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(i + 1))) {
      out += char + value.charAt(i + 1);
      i += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // A lone surrogate can't be encoded as UTF-8, so escape it.
      out += `\\u${hex(code, 4)}`;
    } else out += char;
  }
  return out + '"';
}

/** A Python numeric literal. Input is finite (the IR schema guarantees it). */
export function pythonNumber(value: number): string {
  // JavaScript's shortest round-trip form is also valid Python:
  // "42", "-0.5", "1e+21", "5e-324".
  return Object.is(value, -0) ? '-0.0' : String(value);
}

/**
 * Text that is safe inside a `#` comment: one line, no NUL or other control
 * characters, no lone surrogates.
 */
export function commentText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      out += text.charAt(i) + text.charAt(i + 1);
      i += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) out += '�';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += ' ';
    else out += text.charAt(i);
  }
  return out;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}
