import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allNodes,
  apply,
  applyEvent,
  createUtterance,
  EditBatchSchema,
  diffPrograms,
  editBatchJsonSchema,
  emptySession,
  nodeIdNumber,
  parseDocument,
  parseSessionLog,
  replay,
  serialize,
  serializeSessionLog,
  type IrDocument,
  type SessionEvent,
  type SessionState,
} from '../src';
import { document } from './arbitraries';
import { batchFor } from './op-arbitraries';

/** A random document paired with a random batch aimed at it. */
const docAndBatch = document.chain((doc) => batchFor(doc).map((batch) => ({ doc, batch })));

function ids(doc: IrDocument): Set<string> {
  return new Set(allNodes(doc.program).map((node) => node.id));
}

const validateBatchJson = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(
  editBatchJsonSchema(),
);

describe('random batches', () => {
  it('are judged the same by the Zod schema and the exported JSON Schema', () => {
    fc.assert(
      fc.property(docAndBatch, ({ batch }) => {
        expect(validateBatchJson(batch)).toBe(EditBatchSchema.safeParse(batch).success);
        // And with an op broken by a missing field.
        const broken = { ...batch, ops: batch.ops.map((op, i) => (i === 0 ? { op: op.op } : op)) };
        expect(validateBatchJson(broken)).toBe(EditBatchSchema.safeParse(broken).success);
      }),
      { numRuns: 200 },
    );
  });

  it('apply often enough for the properties to mean something', () => {
    const samples = fc.sample(docAndBatch, { numRuns: 300, seed: 7 });
    const applied = samples.filter(({ doc, batch }) => apply(doc, batch).ok).length;
    expect(applied / samples.length).toBeGreaterThan(0.25);
  });

  it('are undone exactly by their inverse', () => {
    fc.assert(
      fc.property(docAndBatch, ({ doc, batch }) => {
        const result = apply(doc, batch);
        if (!result.ok) return;
        const undone = apply(result.document, result.inverse);
        expect(undone.ok ? undone.document.program : undone.error).toEqual(doc.program);
      }),
      { numRuns: 300 },
    );
  });

  it('leave a valid document, and only use fresh IDs for new nodes', () => {
    fc.assert(
      fc.property(docAndBatch, ({ doc, batch }) => {
        const result = apply(doc, batch);
        if (!result.ok) return;
        expect(parseDocument(result.document).ok).toBe(true);
        expect(result.document.nextId).toBeGreaterThanOrEqual(doc.nextId);
        const before = ids(doc);
        for (const id of ids(result.document)) {
          if (!before.has(id)) expect(nodeIdNumber(id)).toBeGreaterThanOrEqual(doc.nextId);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never change the input, whether or not they apply', () => {
    fc.assert(
      fc.property(docAndBatch, ({ doc, batch }) => {
        const before = JSON.stringify(doc);
        apply(doc, batch);
        expect(JSON.stringify(doc)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });

  it('are deterministic', () => {
    fc.assert(
      fc.property(docAndBatch, ({ doc, batch }) => {
        expect(apply(doc, batch)).toEqual(apply(doc, batch));
      }),
      { numRuns: 100 },
    );
  });

  it('produce diffs that read the same in both directions', () => {
    fc.assert(
      fc.property(docAndBatch, ({ doc, batch }) => {
        const result = apply(doc, batch);
        if (!result.ok) return;
        const forward = diffPrograms(doc.program, result.document.program);
        const backward = diffPrograms(result.document.program, doc.program);
        expect(new Set(forward.added)).toEqual(new Set(backward.removed));
        expect(new Set(forward.removed)).toEqual(new Set(backward.added));
        expect(new Set(forward.changed)).toEqual(new Set(backward.changed));
        const before = ids(doc);
        const after = ids(result.document);
        expect(new Set(forward.added)).toEqual(new Set([...after].filter((id) => !before.has(id))));
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Plays out a random session: edits, undos, redos and reverts chosen by
 * `choices`, keeping only events that apply (as the app would).
 */
function randomSession(
  choices: readonly number[],
  seed: number,
): { events: SessionEvent[]; state: SessionState } {
  let state = emptySession();
  const events: SessionEvent[] = [];
  let utterance = 0;
  choices.forEach((choice, i) => {
    let event: SessionEvent;
    if (choice < 6) {
      const id = `u${String(++utterance)}`;
      const [batch] = fc.sample(batchFor(state.document), { numRuns: 1, seed: seed + i });
      if (batch === undefined) return;
      event = {
        type: 'edit',
        utterance: createUtterance(id, `utterance ${id}`),
        batch: { ...batch, utteranceId: id },
      };
    } else if (choice < 8) {
      event = { type: 'undo' };
    } else if (choice < 9) {
      event = { type: 'redo' };
    } else {
      const target = state.applied.filter((edit) => !edit.isRevert).at(choice % 2 === 0 ? 0 : -1);
      if (target === undefined) return;
      event = { type: 'revert', target: target.utteranceId };
    }
    const result = applyEvent(state, event);
    if (!result.ok) return;
    state = result.state;
    events.push(event);
  });
  return { events, state };
}

describe('random sessions', () => {
  const session = fc.tuple(fc.array(fc.nat(9), { minLength: 1, maxLength: 12 }), fc.nat());

  it('replay from their saved log to the same document, byte for byte', () => {
    fc.assert(
      fc.property(session, ([choices, seed]) => {
        const { events, state } = randomSession(choices, seed);
        const parsed = parseSessionLog(serializeSessionLog({ formatVersion: 1, events }));
        if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
        const replayed = replay(parsed.log.events);
        if (!replayed.ok)
          throw new Error(
            `replay failed at ${String(replayed.eventIndex)}: ${replayed.error.message}`,
          );
        expect(serialize(replayed.state.document)).toBe(serialize(state.document));
        expect(replayed.state).toEqual(state);
      }),
      { numRuns: 60 },
    );
  });

  it('never reuse an ID, across undo and redo', () => {
    fc.assert(
      fc.property(session, ([choices, seed]) => {
        const { events } = randomSession(choices, seed);
        let state = emptySession();
        const seenIds = new Map<string, string>();
        for (const event of events) {
          const result = applyEvent(state, event);
          if (!result.ok) throw new Error(result.error.message);
          expect(result.state.document.nextId).toBeGreaterThanOrEqual(state.document.nextId);
          state = result.state;
          for (const node of allNodes(state.document.program)) {
            const fingerprint = node.kind;
            const previous = seenIds.get(node.id);
            if (previous !== undefined) expect(previous).toBe(fingerprint);
            seenIds.set(node.id, fingerprint);
          }
        }
      }),
      { numRuns: 60 },
    );
  });
});
