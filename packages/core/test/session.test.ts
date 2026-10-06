import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  createUtterance,
  emptySession,
  parseSessionLog,
  quoteSpan,
  replay,
  serialize,
  serializeSessionLog,
  tokenize,
  type EditOp,
  type SessionEvent,
  type SessionResult,
  type SessionState,
} from '../src';
import { at } from './fixtures';

describe('tokenize', () => {
  it('splits words, numbers and punctuation with their offsets', () => {
    expect(tokenize("If we've seen it, return 0.5.")).toEqual([
      { text: 'If', start: 0, end: 2 },
      { text: "we've", start: 3, end: 8 },
      { text: 'seen', start: 9, end: 13 },
      { text: 'it', start: 14, end: 16 },
      { text: ',', start: 16, end: 17 },
      { text: 'return', start: 18, end: 24 },
      { text: '0.5', start: 25, end: 28 },
      { text: '.', start: 28, end: 29 },
    ]);
  });

  it('keeps identifiers, accents and emoji together', () => {
    expect(tokenize('call two_sum on café 😀').map((t) => t.text)).toEqual([
      'call',
      'two_sum',
      'on',
      'café',
      '😀',
    ]);
    expect(tokenize('O(n)').map((t) => t.text)).toEqual(['O', '(', 'n', ')']);
  });

  it('quotes the words a span covers, as typed', () => {
    const utterances = [createUtterance('u1', 'add  it to   the set')];
    expect(quoteSpan({ utteranceId: 'u1', start: 2, end: 5 }, utterances)).toBe('to   the set');
    expect(quoteSpan({ utteranceId: 'u2', start: 0, end: 1 }, utterances)).toBeUndefined();
    expect(quoteSpan({ utteranceId: 'u1', start: 4, end: 9 }, utterances)).toBeUndefined();
    expect(quoteSpan({ utteranceId: 'u1', start: 2, end: 2 }, utterances)).toBeUndefined();
  });

  it('returns nothing for blank text', () => {
    expect(tokenize('  \n\t ')).toEqual([]);
  });
});

/** Utterance n with a batch of ops that adds `break` statements, labeled. */
function edit(n: number, ...ops: EditOp[]): SessionEvent {
  const utterance = createUtterance(`u${String(n)}`, `utterance ${String(n)}`);
  return { type: 'edit', utterance, batch: { utteranceId: utterance.id, ops } };
}

function addBreak(n: number, programId: string): SessionEvent {
  return edit(n, {
    op: 'add_stmt',
    parent: programId,
    position: { at: 'end' },
    stmt: { kind: 'Break', id: 't1', provenance: [at(0, 1, `u${String(n)}`)] },
  });
}

function ok(result: SessionResult): SessionState {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state;
}

function run(...events: SessionEvent[]): SessionState {
  const result = replay(events);
  if (!result.ok) throw new Error(`event ${String(result.eventIndex)}: ${result.error.code}`);
  return result.state;
}

const programId = emptySession().document.program.id;
const bodyIds = (state: SessionState) => state.document.program.body.map((s) => s.id);

describe('sessions', () => {
  it('start with an empty program', () => {
    const state = emptySession();
    expect(state.document.program.body).toEqual([]);
    expect(state).toMatchObject({ utterances: [], applied: [], undone: [], version: 0 });
  });

  it('apply edits and keep the transcript', () => {
    const state = run(addBreak(1, programId), addBreak(2, programId));
    expect(state.document.program.body).toHaveLength(2);
    expect(state.utterances.map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(state.version).toBe(2);
  });

  it('undo and redo restore exact versions without reusing IDs', () => {
    const one = run(addBreak(1, programId));
    const undone = ok(applyEvent(one, { type: 'undo' }));
    expect(undone.document.program).toEqual(emptySession().document.program);
    expect(undone.document.nextId).toBe(one.document.nextId);

    const redone = ok(applyEvent(undone, { type: 'redo' }));
    expect(redone.document).toEqual(one.document);

    const fresh = ok(applyEvent(undone, addBreak(2, programId)));
    expect(bodyIds(fresh)).not.toEqual(bodyIds(one));
  });

  it('clear the redo stack when something new is said', () => {
    const state = run(addBreak(1, programId), { type: 'undo' }, addBreak(2, programId));
    expect(state.undone).toEqual([]);
    expect(applyEvent(state, { type: 'redo' })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-redo' },
    });
  });

  it('refuse to undo or redo past the ends', () => {
    expect(applyEvent(emptySession(), { type: 'undo' })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-undo' },
    });
    expect(applyEvent(emptySession(), { type: 'redo' })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-redo' },
    });
  });

  it("revert an earlier utterance's edit and keep what came after", () => {
    const state = run(addBreak(1, programId), addBreak(2, programId), addBreak(3, programId));
    const [first, second, third] = bodyIds(state);
    const reverted = ok(
      applyEvent(state, {
        type: 'revert',
        target: 'u2',
        utterance: createUtterance('u4', 'scratch the second one'),
      }),
    );
    expect(bodyIds(reverted)).toEqual([first, third]);
    expect(reverted.applied.at(-1)).toMatchObject({ utteranceId: 'u2', isRevert: true });
    expect(second).toBeDefined();

    // Undoing the revert brings the statement back.
    expect(bodyIds(ok(applyEvent(reverted, { type: 'undo' })))).toEqual([first, second, third]);
  });

  it('refuse to revert twice, or to revert what is not in effect', () => {
    const state = run(addBreak(1, programId), { type: 'revert', target: 'u1' });
    expect(applyEvent(state, { type: 'revert', target: 'u1' })).toMatchObject({
      ok: false,
      error: { code: 'already-reverted' },
    });
    expect(applyEvent(state, { type: 'revert', target: 'u9' })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-revert' },
    });
    const undone = run(addBreak(1, programId), { type: 'undo' });
    expect(applyEvent(undone, { type: 'revert', target: 'u1' })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-revert' },
    });
  });

  it('report a conflict when later edits make a revert impossible', () => {
    const state = run(addBreak(1, programId));
    const breakId = bodyIds(state)[0] ?? '';
    const later = ok(applyEvent(state, edit(2, { op: 'remove_node', node: breakId })));
    const result = applyEvent(later, { type: 'revert', target: 'u1' });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'revert-conflict', applyError: { code: 'unknown-node' } },
    });
  });

  it('refuse duplicate utterances and batches for another utterance', () => {
    const state = run(addBreak(1, programId));
    expect(applyEvent(state, addBreak(1, programId))).toMatchObject({
      ok: false,
      error: { code: 'duplicate-utterance' },
    });
    const event = addBreak(2, programId);
    if (event.type !== 'edit') throw new Error('expected an edit');
    expect(
      applyEvent(state, { ...event, batch: { ...event.batch, utteranceId: 'u9' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'mismatched-utterance' },
    });
  });

  it('report edits that fail, with the apply error', () => {
    const result = applyEvent(emptySession(), edit(1, { op: 'remove_node', node: 'n999' }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'edit-failed', applyError: { code: 'unknown-node', opIndex: 0 } },
    });
  });

  it('surface clarification questions from the latest event only', () => {
    const asked = run(
      edit(1, { op: 'ask_clarification', question: 'Which list?', candidates: [] }),
    );
    expect(asked.clarifications).toEqual([{ question: 'Which list?', candidates: [] }]);
    expect(ok(applyEvent(asked, addBreak(2, programId))).clarifications).toEqual([]);
  });

  it('record an utterance that changed nothing', () => {
    const state = run(edit(1));
    expect(state.utterances).toHaveLength(1);
    expect(state.document).toEqual(emptySession().document);
  });

  it('report which event failed during replay', () => {
    const result = replay([addBreak(1, programId), { type: 'redo' }]);
    expect(result).toMatchObject({ ok: false, eventIndex: 1, error: { code: 'nothing-to-redo' } });
  });

  it('continue from a cached state', () => {
    const events = [addBreak(1, programId), addBreak(2, programId), { type: 'undo' } as const];
    const all = run(...events);
    const snapshot = run(...events.slice(0, 2));
    const resumed = replay(events.slice(2), snapshot);
    expect(resumed.ok && resumed.state).toEqual(all);
  });
});

describe('session logs', () => {
  const events: SessionEvent[] = [
    addBreak(1, programId),
    addBreak(2, programId),
    { type: 'undo', utterance: createUtterance('u3', 'undo that') },
    { type: 'redo' },
    { type: 'revert', target: 'u1' },
  ];

  it('round-trip through JSON and replay to the same document, byte for byte', () => {
    const log = { formatVersion: 1 as const, events };
    const parsed = parseSessionLog(serializeSessionLog(log));
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    expect(parsed.log).toEqual(log);
    expect(serialize(run(...parsed.log.events).document)).toBe(serialize(run(...events).document));
  });

  it('report malformed logs', () => {
    expect(parseSessionLog('{')).toMatchObject({ ok: false });
    expect(parseSessionLog('{"formatVersion":2,"events":[]}')).toMatchObject({
      ok: false,
      issues: [expect.stringContaining('formatVersion')],
    });
    expect(parseSessionLog('{"formatVersion":1,"events":[{"type":"jump"}]}')).toMatchObject({
      ok: false,
    });
  });
});
