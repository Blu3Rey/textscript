import { buildSymbolTable, createBuilder } from '@textscript/core';
import { said } from '@textscript/core/testing';
import { describe, expect, it } from 'vitest';
import {
  PYTHON_BUILTINS,
  PYTHON_KEYWORDS,
  commentText,
  pythonName,
  pythonNumber,
  pythonString,
} from '../src';

describe('pythonName', () => {
  it('suffixes hard keywords', () => {
    expect(pythonName('class')).toBe('class_');
    expect(pythonName('None')).toBe('None_');
    expect(pythonName('lambda')).toBe('lambda_');
  });

  it('leaves ordinary and soft-keyword names alone', () => {
    for (const name of ['nums', 'match', 'case', 'type', '_', 'print']) {
      expect(pythonName(name)).toBe(name);
    }
  });

  it('knows the 35 hard keywords', () => {
    expect(PYTHON_KEYWORDS.size).toBe(35);
  });
});

describe('pythonString', () => {
  it.each([
    ['', '""'],
    ['plain', '"plain"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\slash', '"back\\\\slash"'],
    ['a\nb\rc\td', '"a\\nb\\rc\\td"'],
    ['\u0000\u001f\u007f', '"\\x00\\x1f\\x7f"'],
    ['héllo ✓', '"héllo ✓"'],
    ['😀', '"😀"'],
    ['\ud800', '"\\ud800"'],
    ['x\udc00y', '"x\\udc00y"'],
  ])('writes %j as %s', (input, expected) => {
    expect(pythonString(input)).toBe(expected);
  });
});

describe('pythonNumber', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [-7, '-7'],
    [0.5, '0.5'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [-0, '-0.0'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
  ])('writes %s as %s', (input, expected) => {
    expect(pythonNumber(input)).toBe(expected);
  });
});

describe('commentText', () => {
  it('keeps comments on one line without control characters', () => {
    expect(commentText('a\nb\r\nc\td\u0000e f')).toBe('a b  c d e f');
  });

  it('replaces lone surrogates and keeps pairs', () => {
    expect(commentText('x\ud800y😀')).toBe('x�y😀');
  });
});

describe('PYTHON_BUILTINS', () => {
  it('lets the symbol table resolve built-in calls', () => {
    const b = createBuilder();
    const call = b.call(
      { callee: b.name('len', said(0)), args: [b.name('nums', said(1))] },
      said(0, 2),
    );
    const table = buildSymbolTable(b.program([b.exprStmt(call, said(0, 2))]), {
      builtins: PYTHON_BUILTINS,
    });
    expect(table.references.map((ref) => [ref.name, ref.resolution.kind])).toEqual([
      ['len', 'builtin'],
      ['nums', 'unresolved'],
    ]);
  });
});
