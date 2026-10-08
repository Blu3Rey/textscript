import { compileCommands } from '@textscript/commands';
import {
  allNodes,
  apply,
  createUtterance,
  emptySession,
  type EditBatch,
  type EditOp,
  type IrDocument,
  type IrNode,
  type Utterance,
} from '@textscript/core';
import { render } from '@textscript/render-python';
import { describe, expect, it } from 'vitest';
import { codeOf, HELD_BACK_REASON, validate, type ValidationResult } from '../src/index';

/** A session that says things, compiles console commands for them, and validates. */
class Session {
  document: IrDocument = emptySession().document;
  readonly utterances: Utterance[] = [];

  /** Compiles commands citing the whole utterance (or `@a:b` spans), without validating. */
  batch(text: string, ...commands: string[]): EditBatch {
    const id = `u${String(this.utterances.length + 1)}`;
    const utterance = createUtterance(id, text);
    this.utterances.push(utterance);
    const compiled = compileCommands(
      this.document,
      commands.map((command) => ({ text: command })),
      {
        utteranceId: id,
        provenance: [{ utteranceId: id, start: 0, end: utterance.tokens.length }],
      },
    );
    if (!compiled.ok) throw new Error(`${compiled.code}: ${compiled.message}`);
    return compiled.batch;
  }

  /** Validates a batch and applies what's left. */
  check(batch: EditBatch): ValidationResult {
    const result = validate({
      document: this.document,
      batch,
      utterances: this.utterances,
      inputs: ['nums', 'target'],
    });
    const applied = apply(this.document, result.batch);
    if (!applied.ok) throw new Error(applied.error.message);
    this.document = applied.document;
    return result;
  }

  say(text: string, ...commands: string[]): ValidationResult {
    return this.check(this.batch(text, ...commands));
  }

  get code(): string {
    return render(this.document.program, { mode: 'ui' }).text;
  }

  find(predicate: (node: IrNode) => boolean): IrNode {
    const node = allNodes(this.document.program).find(predicate);
    if (node === undefined) throw new Error('no such node');
    return node;
  }
}

const hole = `⟨${HELD_BACK_REASON}⟩`;

describe('validate', () => {
  it('passes what the words say', () => {
    const s = new Session();
    const result = s.say(
      'Make a set called seen, and loop through the numbers.',
      'add root: seen = set()\nfor num~loopvar in nums:\n    ...',
    );
    expect(result.heldBack).toEqual([]);
    expect(result.checked).toBeGreaterThan(4);
    expect(s.code).toContain('seen = set()');
  });

  it('holds back a name nobody said, as a name hole that keeps the words', () => {
    const s = new Session();
    const result = s.say('Make a set.', 'add root: seen = set()');
    expect(result.heldBack).toMatchObject([
      { code: 'VAL003', proposed: 'seen', message: 'The words "Make a set." don\'t say `seen`' },
    ]);
    const replaced = s.find((node) => node.kind === 'NameHole');
    expect(replaced).toMatchObject({
      reason: HELD_BACK_REASON,
      provenance: [{ utteranceId: 'u1' }],
    });
    expect(s.code).toBe(`${hole} = set()\n`);
  });

  it('holds back values and conditions with the matching hole kinds', () => {
    const s = new Session();
    s.say('Loop through the numbers.', 'add root: for num~loopvar in nums:\n    ...');
    const blockHole = s.find((node) => node.kind === 'BlockHole');
    const result = s.say(
      "If it's valid, return true.",
      `fill ${blockHole.id}:\n    if num > 0:\n        return True`,
    );
    expect(result.heldBack.map((h) => [h.code, h.proposed])).toEqual([['VAL003', 'num > 0']]);
    expect(s.find((node) => node.kind === 'CondHole')).toBeDefined();
    expect(s.code).toContain('return True');

    const value = s.say('Count starts somewhere.', 'add root: count = 7');
    expect(value.heldBack.map((h) => h.proposed)).toEqual(['7']);
    expect(s.find((node) => node.kind === 'ExprHole')).toBeDefined();
  });

  it('removes a statement whose kind nobody said, leaving a hole if the block empties', () => {
    const s = new Session();
    s.say('Loop through the numbers.', 'add root: for num~loopvar in nums:\n    ...');
    const blockHole = s.find((node) => node.kind === 'BlockHole');
    const result = s.say('Then nothing happens.', `fill ${blockHole.id}: break`);
    expect(result.heldBack.map((h) => h.proposed)).toEqual(['break']);
    expect(s.code).toContain('⟨body not described⟩');
  });

  it('checks inferred nodes against their rules', () => {
    const s = new Session();
    const misfit = s.say('Count starts at zero.', 'add root: count~loopvar = 0');
    expect(misfit.heldBack).toMatchObject([
      {
        code: 'VAL004',
        proposed: 'count',
        message: "`count` is marked INF-LOOPVAR, which doesn't cover it",
      },
    ]);
    // The rule supplies `len`, which nobody said.
    const range = s.say(
      'Go over each index i of nums.',
      'add root: for i in range(len(nums)~range-bounds):\n    ...',
    );
    expect(range.heldBack).toEqual([]);
  });

  it('holds back nodes citing words that were never said', () => {
    const s = new Session();
    s.utterances.push(createUtterance('u1', 'Hello there.'));
    const stmt = (span: { utteranceId: string; start: number; end: number }): EditOp => ({
      op: 'add_stmt',
      parent: s.document.program.id,
      position: { at: 'end' },
      stmt: { kind: 'Break', id: 't1', provenance: [span] },
      provenance: [{ utteranceId: 'u1', start: 0, end: 2 }],
    });
    for (const span of [
      { utteranceId: 'u9', start: 0, end: 1 },
      { utteranceId: 'u1', start: 0, end: 9 },
    ]) {
      const bad = s.check({ utteranceId: 'u1', ops: [stmt(span)] });
      expect(bad.heldBack).toMatchObject([
        {
          code: 'VAL002',
          message: "`break` cites words that aren't in this or an earlier utterance",
        },
      ]);
    }
    expect(s.code).toBe('');
  });

  it('only accepts spans from this utterance or earlier ones', () => {
    const s = new Session();
    s.utterances.push(
      createUtterance('u1', 'Return true.'),
      createUtterance('u2', 'Return false.'),
    );
    const result = validate({
      document: s.document,
      batch: {
        utteranceId: 'u1',
        ops: [
          {
            op: 'add_stmt',
            parent: s.document.program.id,
            position: { at: 'end' },
            stmt: {
              kind: 'Return',
              id: 't1',
              provenance: [{ utteranceId: 'u2', start: 0, end: 2 }],
              value: {
                kind: 'Literal',
                id: 't2',
                value: false,
                provenance: [{ utteranceId: 'u2', start: 0, end: 2 }],
              },
            },
          },
        ],
      },
      utterances: s.utterances,
    });
    expect(result.heldBack.map((h) => h.code)).toEqual(['VAL002']);
  });

  it('needs an operator said near what it combines, and its operands said too', () => {
    const s = new Session();
    s.say('So prev and curr start at one.', 'add root: prev = 1\ncurr = 1');
    const near = s.say(
      'Ways is prev plus curr, from two to n inclusive.',
      'add root: ways = prev + 1',
    );
    expect(near.heldBack.map((h) => h.proposed)).toEqual(['prev + 1']);
    const inclusive = s.say(
      'Loop i from two to n inclusive.',
      'add root: for i in range(2, n + 1):\n    ...',
    );
    expect(inclusive.heldBack).toEqual([]);
    const next = s.say('Look at the next index.', 'add root: x = nums[i + 1]');
    expect(next.heldBack.map((h) => h.proposed)).toEqual(['x']);
    // "add it to total" says `+ total`, not that best starts at `total + 1`.
    const operand = s.say('Add it to total.', 'add root: best = total + 1');
    expect(operand.heldBack.map((h) => h.proposed)).toEqual(['best = total + 1']);
  });

  it('checks a narrow citation against its whole utterance before holding anything back', () => {
    const s = new Session();
    // The model cites only "num" for `seen`; "seen" is elsewhere in the utterance.
    const narrow = s.say(
      'If num is in seen, return true.',
      'add root:\n    if num in seen@1:2:\n        return True',
    );
    expect(narrow.heldBack).toEqual([]);
    expect(s.find((node) => node.kind === 'Name' && node.name === 'seen').provenance).toEqual([
      { utteranceId: 'u1', start: 1, end: 2 },
    ]);
    // Words the whole utterance doesn't say are still held back.
    const unsaid = s.say(
      'If num shows up, keep going.',
      'add root:\n    if num in seen@1:2:\n        continue',
    );
    expect(unsaid.heldBack.map((h) => h.proposed)).toEqual(['num in seen']);
  });

  it('holds back each run of unsaid conditions in an and/or as one hole, keeping the rest', () => {
    const s = new Session();
    const partly = s.say(
      'If the value is in range and x is in seen, return true.',
      'add root:\n    if 0 <= x and x < 10 and x in seen:\n        return True',
    );
    expect(partly.heldBack).toMatchObject([{ code: 'VAL003', proposed: '0 <= x and x < 10' }]);
    expect(s.code).toContain(`if ${hole} and x in seen:`);
    const none = s.say(
      'If it works, return true.',
      'add root:\n    if 0 <= x and x < 10:\n        return True',
    );
    expect(none.heldBack.map((h) => h.proposed)).toEqual(['0 <= x and x < 10']);
    expect(s.code).toContain(`if ${hole}:`);
  });

  it('holds back a whole setup line when neither the value nor the setup was said', () => {
    const s = new Session();
    const invented = s.say('Add one to islands for each one.', 'add root: islands = 0');
    expect(invented.heldBack).toMatchObject([
      {
        proposed: 'islands = 0',
        message: 'The words "Add one to islands for each one." don\'t set up `islands`',
      },
    ]);
    expect(s.code).toBe('');
    // The setup said, the value not: only the value is held back.
    expect(
      s.say('Islands starts somewhere.', 'add root: islands = 7').heldBack.map((h) => h.proposed),
    ).toEqual(['7']);
  });

  it('holds back a conversion nobody said', () => {
    const s = new Session();
    s.say('Make a list called count.', 'add root: count = []');
    const result = s.say('The key is just count itself.', 'add root: key = tuple(count)');
    expect(result.heldBack.map((h) => [h.code, h.proposed])).toEqual([['VAL003', 'tuple(count)']]);
    const said = s.say('Make the key the tuple of count.', 'add root: key = tuple(count)');
    expect(said.heldBack).toEqual([]);
  });

  it('holds back a statement with nothing said left in it', () => {
    const s = new Session();
    const scan = s.say(
      "It's sorted except for one drop, so I'll scan for that drop.",
      'add root:\n    for i in range(len(nums) - 1):\n        if nums[i] > nums[i + 1]:\n            return nums[i + 1]',
    );
    expect(scan.heldBack.at(-1)).toMatchObject({
      code: 'VAL003',
      proposed: 'for i in range(len(nums) - 1): …',
    });
    expect(s.code).toBe('');
    const musing = s.say('I keep landing on the same thing, right?', 'add root: visited = set()');
    expect(musing.heldBack.at(-1)?.proposed).toBe('visited = set()');
    expect(s.code).toBe('');
    // A said `return`, and holes written with the speaker's words, stay.
    s.say('Return the answer.', 'add root: return best');
    expect(s.code).toBe(`return ${hole}\n`);
    const check = s.say(
      'If it is valid, do something.',
      'add root:\n    if ?cond"it is valid":\n        ...',
    );
    expect(check.heldBack).toEqual([]);
  });

  it("doesn't take the pronoun I for the variable i", () => {
    const s = new Session();
    const pronoun = s.say("I'll go through the numbers.", 'add root: for i in nums:\n    ...');
    expect(pronoun.heldBack.map((h) => h.proposed)).toEqual(['i']);
    const variable = s.say('Loop with i over nums.', 'add root: for i in nums:\n    ...');
    expect(variable.heldBack).toEqual([]);
  });

  it('calls the speaker\'s own functions by name, not by "that"', () => {
    const s = new Session();
    s.say('Define explore on r.', 'add root:\n    def explore(r):\n        ...');
    const that = s.say('And inside that, the main part.', 'add root: explore(0)');
    expect(that.heldBack.map((h) => h.proposed)).toEqual(['explore(0)']);
    const named = s.say('Explore from zero.', 'add root: explore(0)');
    expect(named.heldBack).toEqual([]);
  });

  it('holds back returning a condition when the words return True only under it', () => {
    const s = new Session();
    s.say('Make a list called queue.', 'add root: queue = []');
    const result = s.say('Return True if the queue is empty.', 'add root: return not queue');
    expect(result.heldBack).toMatchObject([
      {
        code: 'VAL003',
        proposed: 'return not queue',
        message:
          'The words "Return True if the queue is empty." say when it returns True, not what it returns otherwise',
      },
    ]);
    const whether = s.say('Return whether the queue is empty.', 'add root: return not queue');
    expect(whether.heldBack).toEqual([]);
  });

  it("doesn't let a collection's name stand for its loop variable's", () => {
    const s = new Session();
    expect(
      s
        .say('Go through each amount in nums.', 'add root: for num in nums:\n    ...')
        .heldBack.map((h) => h.proposed),
    ).toEqual(['num']);
    expect(
      s.say('For each num in nums, keep going.', 'add root: for num in nums:\n    continue')
        .heldBack,
    ).toEqual([]);
  });

  it('accepts code the batch takes out and rebuilds unchanged', () => {
    const s = new Session();
    s.say('If num is in seen, return true.', 'add root: if num in seen:\n    return True');
    const ifNode = s.find((node) => node.kind === 'If');
    const rebuilt = s.say(
      'Otherwise keep going.',
      `replace ${ifNode.id}:\n    if num in seen:\n        return True\n    else:\n        continue`,
    );
    expect(rebuilt.heldBack).toEqual([]);
    expect(s.code).toContain('else:\n    continue');
  });

  it('drops field changes, renames and labels the words do not support', () => {
    const s = new Session();
    s.say('While lo is less than hi, keep going.', 'add root: while lo < hi:\n    continue');
    const compare = s.find((node) => node.kind === 'Compare');
    const name = s.find((node) => node.kind === 'Name' && node.name === 'lo');
    const loop = s.find((node) => node.kind === 'While');

    expect(s.say('Make it at most.', `set ${compare.id}.op = <=`).heldBack).toEqual([]);
    const op = s.say('Make it different.', `set ${compare.id}.op = >`);
    expect(op.heldBack).toMatchObject([{ code: 'VAL003', target: { op: 0 } }]);
    expect(op.batch.ops).toEqual([]);

    expect(s.say('Call lo low instead.', `rename ${name.id} low`).heldBack).toEqual([]);
    expect(s.say('Rename that.', `rename ${name.id} start`).heldBack).toHaveLength(1);
    expect(s.say('Call this the search loop.', `label ${loop.id} search loop`).heldBack).toEqual(
      [],
    );
    expect(s.say('Label it.', `label ${loop.id} binary search`).heldBack).toHaveLength(1);
    expect(s.code).toContain('while low <= hi:');
  });

  it('drops ops with no words, and lets questions through', () => {
    const s = new Session();
    s.say('Return true.', 'add root: return True');
    const ret = s.find((node) => node.kind === 'Return');
    const result = s.check({
      utteranceId: 'u1',
      ops: [
        { op: 'remove_node', node: ret.id },
        { op: 'ask_clarification', question: 'Which one?', candidates: [] },
      ],
    });
    expect(result.heldBack).toMatchObject([{ code: 'VAL001', target: { op: 0 } }]);
    expect(result.batch.ops.map((o) => o.op)).toEqual(['ask_clarification']);
  });

  it('returns nodes it cannot judge as claims for a second opinion', () => {
    const s = new Session();
    const result = s.say('Set x to nums at target.', 'add root: x = nums[target]');
    expect(result.heldBack).toEqual([]);
    expect(result.claims.map((c) => c.code)).toEqual(['x = nums[target]', 'nums[target]']);
    expect(result.claims[0]?.words).toBe('set x to nums at target .');
  });

  it('returns a batch the applier rejects unchanged', () => {
    const s = new Session();
    const batch: EditBatch = { utteranceId: 'u1', ops: [{ op: 'remove_node', node: 'n99' }] };
    expect(validate({ document: s.document, batch, utterances: [] })).toEqual({
      batch,
      heldBack: [],
      checked: 0,
      claims: [],
    });
  });
});

describe('codeOf', () => {
  it('renders one line of any node', () => {
    const s = new Session();
    s.say(
      'If x is one, return zero, else if x is two return one, else return a map of x to x.',
      'add root:\n    if x == 1:\n        return 0\n    elif x == 2:\n        return 1\n    else:\n        return {x: x}',
    );
    const kinds = ['If', 'Elif', 'DictEntry', 'Block', 'Compare', 'Program'];
    expect(kinds.map((kind) => codeOf(s.find((node) => node.kind === kind)))).toEqual([
      'if x == 1: …',
      'elif x == 2: …',
      'x: x',
      'else: …',
      'x == 1',
      '(program)',
    ]);
  });
});
