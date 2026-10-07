import { emptySession } from '@textscript/core';
import { render } from '@textscript/render-python';
import { describe, expect, it } from 'vitest';
import {
  commandFailure,
  CommandError,
  compileCommand,
  compileCommands,
  joinBody,
  RefError,
  SnippetError,
} from '../src/index';

const empty = emptySession().document;
const whole = [{ utteranceId: 'u1', start: 0, end: 5 }];

describe('compileCommands', () => {
  it('lets later commands refer to what earlier ones made', () => {
    const result = compileCommands(
      empty,
      [{ text: 'add root: for num in nums:\n    ...' }, { text: 'fill h1: print(num)' }],
      { utteranceId: 'u1', provenance: whole },
    );
    expect(result.ok).toBe(true);
    expect(render(result.document.program).text).toBe('for num in nums:\n    print(num)\n');
    expect(result.batch.ops.map((op) => op.op)).toEqual(['add_stmt', 'fill_hole']);
  });

  it('gives each command its own provenance when asked', () => {
    const result = compileCommands(
      empty,
      [{ text: 'add root: x = 1', provenance: [{ utteranceId: 'u1', start: 2, end: 3 }] }],
      {
        utteranceId: 'u1',
        provenance: whole,
      },
    );
    const [op] = result.batch.ops;
    expect(op?.op === 'add_stmt' ? op.stmt.provenance : undefined).toEqual([
      { utteranceId: 'u1', start: 2, end: 3 },
    ]);
  });

  it('stops at the first failing command and keeps the ones before', () => {
    const result = compileCommands(
      empty,
      [{ text: 'add root: x = 1' }, { text: 'remove n99' }, { text: 'add root: y = 2' }],
      { utteranceId: 'u1', provenance: whole },
    );
    expect(result).toMatchObject({ ok: false, index: 1, code: 'bad-ref' });
    expect(render(result.document.program).text).toBe('x = 1\n');
  });

  it('reports syntax, unknown commands and apply errors with codes', () => {
    const fail = (text: string) =>
      compileCommands(empty, [{ text }], { utteranceId: 'u1', provenance: whole });
    expect(fail('add root: x = = 1')).toMatchObject({ ok: false, code: 'syntax' });
    expect(fail('frobnicate')).toMatchObject({ ok: false, code: 'unknown-command' });
    expect(fail('add root after n1: x = 1')).toMatchObject({ ok: false, code: 'invalid-anchor' });
  });

  it('collects clarification questions', () => {
    const result = compileCommands(empty, [{ text: 'ask Which list?' }], {
      utteranceId: 'u1',
      provenance: whole,
    });
    expect(result.ok && result.clarifications).toEqual([
      { question: 'Which list?', candidates: [] },
    ]);
  });
});

describe('compileCommand', () => {
  it('throws typed errors that commandFailure describes', () => {
    const run = (text: string) => () =>
      compileCommand(empty, text, { utteranceId: 'u1', provenance: whole, nextId: () => 't1' });
    expect(run('add root x')).toThrow(CommandError);
    expect(run('add root: (')).toThrow(SnippetError);
    expect(run('remove h9')).toThrow(RefError);
    expect(commandFailure(new Error('x'))).toBeUndefined();
  });
});

describe('joinBody', () => {
  it('keeps lines below an inline compound header nested', () => {
    expect(joinBody('for x in xs:', '        print(x)')).toBe('for x in xs:\n    print(x)');
    expect(joinBody('a = 1', '    b = 2')).toBe('a = 1\nb = 2');
    expect(joinBody('', '  a = 1\n    b')).toBe('a = 1\n  b');
    expect(joinBody('a = 1', '')).toBe('a = 1');
  });
});
