import { describe, expect, it } from 'vitest';
import { Console, ConsoleError } from '../src/console/console';
import { resolveRef } from '@textscript/commands';
import { runScript, splitScript } from '../src/console/script';
import { memoryFs } from './memory-fs';

function consoleWith(...commands: string[]) {
  const fs = memoryFs();
  const c = new Console({ fs });
  for (const command of commands) {
    const result = c.execute(command);
    if (result.status === 'error') throw new Error(result.output.join('\n'));
  }
  return { c, fs };
}

function run(c: Console, command: string) {
  const result = c.execute(command);
  return { ...result, text: result.output.join('\n') };
}

describe('Console', () => {
  it('ignores blank commands', () => {
    expect(new Console({ fs: memoryFs() }).execute('   ')).toEqual({ status: 'ok', output: [] });
  });

  it('shows the tokens of each utterance', () => {
    const { c } = consoleWith();
    expect(run(c, 'say Loop through the list.').text).toBe('u1: 0:Loop 1:through 2:the 3:list 4:.');
    expect(run(c, 'say').status).toBe('error');
  });

  it('starts an utterance from the command when nothing was said', () => {
    const { c } = consoleWith('add root: x = 1');
    expect(c.events).toHaveLength(0);
    expect(run(c, ':log').text).toBe('u1  "add root: x = 1"  add_stmt (pending)');
    run(c, ':commit');
    expect(c.events).toHaveLength(1);
    expect(run(c, ':commit').text).toBe('(nothing to commit)');
  });

  it('keeps the pending batch when an edit fails', () => {
    const { c } = consoleWith('say Set x.', 'add root: x = 1');
    const failed = run(c, 'remove n42');
    expect(failed.status).toBe('error');
    expect(failed.error).toEqual({ code: 'bad-ref', message: 'There is no node n42' });
    expect(run(c, ':log').text).toContain('add_stmt (pending)');
  });

  it('says which op of a multi-statement command failed', () => {
    const { c } = consoleWith('say Two things.', 'add root: x = 1');
    const bad = run(c, 'add root after n4:\n  y = 2\n  print(y)');
    expect(bad.status).toBe('error');
    expect(bad.text).toContain('[op 1 of this command]');
    const moved = run(c, 'move n2 n2');
    expect(moved.error?.code).toBe('usage');
    expect(moved.text).not.toContain('[op');
  });

  it('adds statements at a position', () => {
    const { c } = consoleWith('say Three steps.', 'add root: b = 2', 'add root start: a = 1');
    run(c, 'add root after n2: c = 3');
    run(c, 'add root before n2: z = 0');
    expect(run(c, 'add root middle: q = 1').error?.code).toBe('usage');
    expect(run(c, 'expect code:\n  a = 1\n  z = 0\n  b = 2\n  c = 3').status).toBe('ok');
  });

  it('adds to an else block with ref.field', () => {
    const { c } = consoleWith('say Branch.', 'add root:\n  if x:\n    a = 1\n  else:\n    ...');
    expect(run(c, 'add n2.orelse: b = 2').status).toBe('ok');
    expect(run(c, 'add n2.cond: b = 2').error?.code).toBe('usage');
    expect(run(c, 'expect code:\n  if x:\n      a = 1\n  else:\n      b = 2').status).toBe('ok');
  });

  it('sets scalar fields from literals or text', () => {
    const { c } = consoleWith('say Values.', 'add root: x = 1');
    for (const [value, rendered] of [
      ['True', 'x = True'],
      ['None', 'x = None'],
      ['2.5', 'x = 2.5'],
      ['"hi"', 'x = "hi"'],
    ] as const) {
      expect(run(c, `set n4.value = ${value}`).error).toBeUndefined();
      expect(run(c, `expect code:\n  ${rendered}`).status).toBe('ok');
    }
    expect(run(c, 'set n2.op = +=').error?.code).toBe('invalid-field');
    expect(run(c, 'set n2 value').error?.code).toBe('usage');
  });

  it('sets a block of several statements, written inline or below', () => {
    const { c } = consoleWith('say Branch.', 'add root:\n  if x:\n    a = 1');
    expect(run(c, 'set n2.orelse = b = 2\n    c = 3').error).toBeUndefined();
    expect(
      run(c, 'expect code:\n  if x:\n      a = 1\n  else:\n      b = 2\n      c = 3').status,
    ).toBe('ok');
    expect(
      run(c, 'set n2.orelse =\n      d = 4\n      if y:\n          e = 5').error,
    ).toBeUndefined();
    expect(run(c, 'fill h1:\n  ...').error?.code).toBe('bad-ref');
    expect(
      run(
        c,
        'expect code:\n  if x:\n      a = 1\n  else:\n      d = 4\n      if y:\n          e = 5',
      ).status,
    ).toBe('ok');
  });

  it('sets a statement block with set', () => {
    const { c } = consoleWith('say Loop.', 'add root: while x:\n  ...');
    expect(run(c, 'set n2.body = y = 1').status).toBe('ok');
    expect(run(c, 'expect code:\n  while x:\n      y = 1').status).toBe('ok');
  });

  it('replaces expressions and conditions in place', () => {
    const { c } = consoleWith('say Compare.', 'add root: if a < b:\n  return a');
    expect(run(c, 'replace n3: a <= b').status).toBe('ok');
    expect(run(c, 'replace n8: b').status).toBe('ok');
    expect(run(c, 'replace n2:\n  x = 1\n  y = 2').error?.code).toBe('usage');
    expect(run(c, 'expect code:\n  if a <= b:\n      return b').status).toBe('ok');
  });

  it('fills condition, expression and block holes', () => {
    const { c } = consoleWith('say Holes.', 'add root: while ?cond:\n  x = ?value');
    run(c, 'fill h1: x < 3');
    run(c, 'fill h1: x + 1');
    expect(run(c, 'expect code:\n  while x < 3:\n      x = x + 1').status).toBe('ok');
  });

  it('moves statements with a position', () => {
    const { c } = consoleWith('say Order.', 'add root:\n  a = 1\n  b = 2');
    expect(run(c, 'move n5 root start').status).toBe('ok');
    expect(run(c, 'expect code:\n  b = 2\n  a = 1').status).toBe('ok');
  });

  it('labels and unlabels nodes', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1', 'label n2 First Step');
    expect(resolveRef(c.document.program, '@first-step')).toBe('n2');
    expect(run(c, 'label n2').error?.code).toBe('usage');
    run(c, 'unlabel @first-step');
    expect(() => resolveRef(c.document.program, '@first-step')).toThrow(/No node is labeled/);
  });

  it('adds and removes notes', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1');
    expect(run(c, 'note n2:').error?.code).toBe('usage');
    expect(run(c, 'note n2 complexity: O(1)').text).toContain('# Complexity: O(1)');
    expect(run(c, 'unnote').error?.code).toBe('usage');
    expect(run(c, 'unnote n5').status).toBe('ok');
  });

  it('records clarification questions', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1');
    expect(run(c, 'ask Is a an int?').text).toContain('? Is a an int?');
    expect(run(c, 'ask -- n2').error?.code).toBe('usage');
    run(c, ':commit');
    expect(run(c, 'show').text).toContain('? Is a an int?');
  });

  it('rejects malformed wraps and renames', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1');
    expect(run(c, 'wrap n2: x = 1').error?.code).toBe('syntax');
    expect(run(c, 'wrap n2').error?.code).toBe('usage');
    expect(run(c, 'rename n3').error?.code).toBe('usage');
    expect(run(c, 'fill h1').error?.code).toBe('usage');
    expect(run(c, 'remove').error?.code).toBe('usage');
  });

  it('runs edit ops given as JSON', () => {
    const { c } = consoleWith('say A.');
    const op = run(
      c,
      'op {"op":"add_stmt","parent":"n1","position":{"at":"end"},"stmt":{"kind":"Break","id":"t1","provenance":[{"utteranceId":"u1","start":0,"end":1}]}}',
    );
    expect(op.status).toBe('ok');
    expect(run(c, 'expect code:\n  break').status).toBe('ok');
  });

  it('keeps an empty utterance with the undo it asked for', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1', 'say Never mind.');
    run(c, ':undo');
    expect(run(c, ':log').text).toBe('u1  "A."  add_stmt\nundo  "Never mind."');
    run(c, 'say And again.');
    expect(run(c, ':undo').error?.code).toBe('nothing-to-undo');
    expect(run(c, ':log').text).toContain('u3  "And again."  no changes (pending)');
  });

  it('shows inferences on request and coverage', () => {
    const { c } = consoleWith(
      'say Loop over nums.',
      'add root: for num~loopvar in nums:\n  print(num)',
    );
    expect(run(c, ':diag').text).toContain('1 inferred');
    expect(run(c, ':diag all').text).toContain('INFO001');
    expect(run(c, ':coverage').text).toContain('✗ inputs: unknown');
    expect(run(c, ':inputs nums').text).toBe('inputs: nums');
    expect(run(c, ':inputs').text).toBe('inputs: nums');
    expect(run(c, ':diag').text).not.toContain('GAP001');
  });

  it('dumps the IR of the program or a node', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1');
    expect(JSON.parse(run(c, ':ir').text)).toMatchObject({ kind: 'Program', id: 'n1' });
    expect(JSON.parse(run(c, ':ir n2').text)).toMatchObject({ kind: 'Assign' });
  });

  it('reports file errors and bad logs', () => {
    const fs = memoryFs({ 'bad.json': '{"formatVersion": 1}', 'broken.json': 'nope' });
    const c = new Console({
      fs: {
        ...fs,
        writeFile: () => {
          throw new Error('read-only');
        },
      },
    });
    expect(run(c, ':export out.py').error?.code).toBe('write-failed');
    expect(run(c, ':save out.json').error?.code).toBe('write-failed');
    expect(run(c, ':load bad.json').error?.code).toBe('bad-log');
    expect(run(c, ':load broken.json').error?.code).toBe('bad-log');
    expect(run(c, ':load').error?.code).toBe('usage');
  });

  it('reports a log that does not replay', () => {
    const fs = memoryFs({
      'log.json': JSON.stringify({ formatVersion: 1, events: [{ type: 'undo' }] }),
    });
    const c = new Console({ fs });
    const result = run(c, ':load log.json');
    expect(result.error?.code).toBe('bad-log');
    expect(result.text).toContain("Event 0 doesn't replay");
  });

  it('continues an existing session', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1', ':commit');
    const next = new Console({ fs: memoryFs(), session: { state: c.state, events: c.events } });
    expect(run(next, 'say B.').text).toBe('u2: 0:B 1:.');
    run(next, 'add root: b = 2');
    run(next, ':commit');
    expect(next.events).toHaveLength(2);
    expect(c.events).toHaveLength(1);
    expect(run(next, 'expect code:\n  a = 1\n  b = 2').status).toBe('ok');
  });

  it('prints help and quits', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1');
    expect(run(c, ':help').text).toContain('Commands');
    expect(run(c, ':quit').status).toBe('quit');
    expect(c.events).toHaveLength(1);
  });

  it('checks expectations', () => {
    const { c } = consoleWith('say A.', 'add root: a = 1');
    expect(run(c, 'expect gaps WARN001').status).toBe('ok');
    expect(run(c, 'expect gaps none').text).toBe('✗ expected gaps none, got WARN001');
    expect(run(c, 'expect error usage').text).toBe('✗ expected error usage, got no error');
    expect(run(c, 'expect code:\n  b = 2').status).toBe('mismatch');
    expect(run(c, 'expect nothing').error?.code).toBe('usage');
  });

  it('rethrows errors that are not about the command', () => {
    const c = new Console({
      fs: {
        readFile: () => {
          throw new ConsoleError('x', 'y');
        },
        writeFile: () => undefined,
      },
    });
    expect(run(c, ':load a').error?.code).toBe('read-failed');
  });
});

describe('scripts', () => {
  it('split into commands, continuations and comments', () => {
    expect(splitScript('# hi\nadd root:\n  x = 1\n\n  y = 2\n\nshow\n')).toEqual([
      { line: 1, comment: '# hi' },
      { line: 2, text: 'add root:\n  x = 1\n\n  y = 2' },
      { line: 7, text: 'show' },
    ]);
  });

  it('count failed expectations and unexpected errors', () => {
    const result = runScript(
      'say A.\nadd root: a = 1\nexpect gaps none\nremove n9\nshow\nremove n9\n',
      { fs: memoryFs() },
    );
    expect(result.failures).toBe(3);
    expect(result.transcript).toContain('! line 3: expectation not met');
    expect(result.transcript).toContain('! line 4: unexpected error');
    expect(result.transcript).toContain('! line 6: unexpected error');
    expect(result.transcript.endsWith('-- 3 failures\n')).toBe(true);
  });

  it('stop at :quit', () => {
    const result = runScript(':quit\nfrobnicate\n', { fs: memoryFs() });
    expect(result.failures).toBe(0);
    expect(result.transcript).not.toContain('frobnicate');
  });
});
