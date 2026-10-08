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

  it('adds an else to an if that has none, and adds to one that has', () => {
    const result = compileCommands(
      empty,
      [
        { text: 'add root:\n    if x > 1:\n        return 1' },
        { text: 'add n2.orelse: return 2' },
        { text: 'add n2.orelse: return 3' },
      ],
      { utteranceId: 'u1', provenance: whole },
    );
    expect(result.ok).toBe(true);
    expect(render(result.document.program).text).toBe(
      'if x > 1:\n    return 1\nelse:\n    return 2\n    return 3\n',
    );
    expect(result.batch.ops.map((op) => op.op)).toEqual(['add_stmt', 'update_field', 'add_stmt']);
    const loop = compileCommands(
      empty,
      [{ text: 'add root: for x in xs:\n    ...' }, { text: 'add n2.orelse: return 2' }],
      { utteranceId: 'u1', provenance: whole },
    );
    expect(loop).toMatchObject({
      ok: false,
      index: 1,
      message: 'ForEach n2 has no block "orelse"',
    });
    const root = compileCommands(empty, [{ text: 'add n1.orelse: return 2' }], {
      utteranceId: 'u1',
      provenance: whole,
    });
    expect(root).toMatchObject({ ok: false, message: 'Program n1 has no block "orelse"' });
  });

  it('forgives what models get wrong but mean clearly', () => {
    const run = (...texts: string[]) =>
      compileCommands(
        empty,
        texts.map((text) => ({ text })),
        { utteranceId: 'u1', provenance: whole },
      );
    // n2 is the loop, n6 the first statement in it.
    const setup = 'add root:\n    for x in xs:\n        y = x\n        return y';
    // The anchor says where: `root` is overruled by n6's own block.
    expect(render(run(setup, 'add root after n6: z = 1').document.program).text).toBe(
      'for x in xs:\n    y = x\n    z = 1\n    return y\n',
    );
    // `add <plain statement>:` means right after it.
    expect(render(run(setup, 'add n6: z = 1').document.program).text).toBe(
      'for x in xs:\n    y = x\n    z = 1\n    return y\n',
    );
    // A repeated `return` or `name =` around a value.
    const ret = run(setup, 'set n9.value = return y + 1');
    expect(render(ret.document.program).text).toContain('return y + 1');
    const assign = run(setup, 'set n6.value = y = x * 2');
    expect(render(assign.document.program).text).toContain('y = x * 2');
    // `add after <ref>:` with no parent: the anchor's block.
    expect(render(run(setup, 'add after n2: return 0').document.program).text).toBe(
      'for x in xs:\n    y = x\n    return y\nreturn 0\n',
    );
    expect(render(run(setup, 'add before n9: z = 1').document.program).text).toBe(
      'for x in xs:\n    y = x\n    z = 1\n    return y\n',
    );
    // `<statement>.orelse` with the statement inside an `if`: that `if`'s else.
    const branch = 'add root:\n    if x:\n        continue';
    expect(render(run(branch, 'add n5.orelse: y = 1').document.program).text).toBe(
      'if x:\n    continue\nelse:\n    y = 1\n',
    );
  });

  it('says clearly what to do instead for tuple assignments and statements in an expression hole', () => {
    const tuple = compileCommands(empty, [{ text: 'add root: a, b = b, a' }], {
      utteranceId: 'u1',
      provenance: whole,
    });
    expect(tuple).toMatchObject({ ok: false, code: 'syntax' });
    expect(tuple.ok ? '' : tuple.message).toContain(
      'Tuple assignments ("a, b = x, y") aren\'t supported: write one assignment per line',
    );
    const statements = compileCommands(
      empty,
      [{ text: 'add root: x = ?' }, { text: 'fill h1:\n    if y:\n        return 1' }],
      { utteranceId: 'u1', provenance: whole },
    );
    expect(statements).toMatchObject({
      ok: false,
      index: 1,
      message:
        'h1 is a hole for a value: fill it with one expression. To add statements, use add with a block',
    });
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
    const fill = fail('fill h1:\n    x = 1\n    y = 2');
    expect(fill).toMatchObject({
      ok: false,
      code: 'bad-ref',
      message:
        'There is no hole h1; there are 0 holes. To add statements, use add <block>: <statements>, or add <if>.orelse: <statements> for "otherwise"',
    });
    const loopElse = compileCommands(
      empty,
      [{ text: 'add root: for x in xs:\n    ...' }, { text: 'set n2.orelse = print(x)' }],
      { utteranceId: 'u1', provenance: whole },
    );
    expect(loopElse).toMatchObject({
      ok: false,
      code: 'usage',
      message:
        'ForEach n2 has no else. For "otherwise" after an if, use add <if>.orelse: <statements>',
    });
    const set = fail('set dp[0] = nums[0]');
    expect(set).toMatchObject({ ok: false, code: 'usage' });
    expect(set.ok ? '' : set.message).toContain(
      'To write a new statement such as "dp[0] = nums[0]", use add <block>: <statements>',
    );
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
  it("keeps lines written at an inline header's own level as they are", () => {
    expect(joinBody('if x:', '    y = 1\nz = 2')).toBe('if x:\n    y = 1\nz = 2');
  });

  it('keeps lines below an inline compound header nested', () => {
    expect(joinBody('for x in xs:', '        print(x)')).toBe('for x in xs:\n    print(x)');
    expect(joinBody('a = 1', '    b = 2')).toBe('a = 1\nb = 2');
    expect(joinBody('', '  a = 1\n    b')).toBe('a = 1\n  b');
    expect(joinBody('a = 1', '')).toBe('a = 1');
  });
});
