// An editing session as an append-only event log (docs/adr/005, 008).
//
// The current state is a fold of the log over an empty program. Undo and
// redo restore exact snapshots; revert undoes one earlier utterance's edit
// on top of everything since, by applying its inverse batch. Every event,
// undo included, is appended; nothing is ever removed from the log.

import { z } from 'zod';
import { createBuilder } from '../ir/build';
import { zodIssueMessages } from '../ir/serialize';
import type { IrDocument } from '../ir/types';
import { apply } from '../ops/apply';
import { EditBatchSchema } from '../ops/schema';
import type { ApplyError, Clarification, EditBatch } from '../ops/types';
import type { Utterance } from './tokenize';

export type SessionEvent =
  /** An utterance and the batch it produced. The batch may be empty. */
  | { type: 'edit'; utterance: Utterance; batch: EditBatch }
  | { type: 'undo'; utterance?: Utterance }
  | { type: 'redo'; utterance?: Utterance }
  /** Undoes the edit of utterance `target`, keeping everything said since. */
  | { type: 'revert'; target: string; utterance?: Utterance };

export interface SessionLog {
  formatVersion: 1;
  events: SessionEvent[];
}

/** An edit currently in effect: what undo would take back. */
export interface AppliedEdit {
  /** The utterance whose edit this is, or the target of a revert. */
  utteranceId: string;
  /** Set when this entry is a revert. */
  isRevert: boolean;
  before: IrDocument;
  after: IrDocument;
  /** Undoes this edit when applied to `after` or anything built on it. */
  inverse: EditBatch;
}

export interface SessionState {
  document: IrDocument;
  /** Every utterance so far, in order: the transcript. */
  utterances: Utterance[];
  /** Edits in effect, oldest first. Undo takes the last. */
  applied: AppliedEdit[];
  /** Undone edits, most recently undone last. Redo takes the last. */
  undone: AppliedEdit[];
  /** Questions from the most recent event. */
  clarifications: Clarification[];
  /** How many events have been applied. */
  version: number;
}

export type SessionErrorCode =
  | 'duplicate-utterance'
  | 'mismatched-utterance'
  | 'edit-failed'
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'nothing-to-revert'
  | 'already-reverted'
  | 'revert-conflict';

export interface SessionError {
  code: SessionErrorCode;
  message: string;
  /** For `edit-failed` and `revert-conflict`: why the batch didn't apply. */
  applyError?: ApplyError;
}

export type SessionResult = { ok: true; state: SessionState } | { ok: false; error: SessionError };

/** A session before anything has been said: an empty program. */
export function emptySession(): SessionState {
  const b = createBuilder();
  return {
    document: b.document(b.program([])),
    utterances: [],
    applied: [],
    undone: [],
    clarifications: [],
    version: 0,
  };
}

function fail(code: SessionErrorCode, message: string, applyError?: ApplyError): SessionResult {
  return {
    ok: false,
    error: { code, message, ...(applyError === undefined ? {} : { applyError }) },
  };
}

/** Applies one event. The input state is never modified. */
export function applyEvent(state: SessionState, event: SessionEvent): SessionResult {
  if (event.utterance !== undefined && state.utterances.some((u) => u.id === event.utterance?.id)) {
    return fail('duplicate-utterance', `Utterance ${event.utterance.id} is already in the session`);
  }
  const base: SessionState = {
    ...state,
    utterances:
      event.utterance === undefined ? state.utterances : [...state.utterances, event.utterance],
    clarifications: [],
    version: state.version + 1,
  };

  switch (event.type) {
    case 'edit': {
      if (event.batch.utteranceId !== event.utterance.id) {
        return fail(
          'mismatched-utterance',
          `The batch is for ${event.batch.utteranceId}, not ${event.utterance.id}`,
        );
      }
      const result = apply(state.document, event.batch);
      if (!result.ok) return fail('edit-failed', result.error.message, result.error);
      const edit: AppliedEdit = {
        utteranceId: event.utterance.id,
        isRevert: false,
        before: state.document,
        after: result.document,
        inverse: result.inverse,
      };
      return {
        ok: true,
        state: {
          ...base,
          document: result.document,
          applied: [...state.applied, edit],
          undone: [],
          clarifications: result.clarifications,
        },
      };
    }

    case 'undo': {
      const edit = state.applied.at(-1);
      if (edit === undefined) return fail('nothing-to-undo', 'There is nothing to undo');
      return {
        ok: true,
        state: {
          ...base,
          // The program goes back; nextId never does, so IDs aren't reused.
          document: { ...edit.before, nextId: state.document.nextId },
          applied: state.applied.slice(0, -1),
          undone: [...state.undone, edit],
        },
      };
    }

    case 'redo': {
      const edit = state.undone.at(-1);
      if (edit === undefined) return fail('nothing-to-redo', 'There is nothing to redo');
      return {
        ok: true,
        state: {
          ...base,
          document: { ...edit.after, nextId: Math.max(edit.after.nextId, state.document.nextId) },
          applied: [...state.applied, edit],
          undone: state.undone.slice(0, -1),
        },
      };
    }

    case 'revert': {
      if (state.applied.some((edit) => edit.isRevert && edit.utteranceId === event.target)) {
        return fail('already-reverted', `The edit of ${event.target} has already been reverted`);
      }
      const target = state.applied.findLast(
        (edit) => !edit.isRevert && edit.utteranceId === event.target,
      );
      if (target === undefined) {
        return fail('nothing-to-revert', `No edit from ${event.target} is in effect`);
      }
      const result = apply(state.document, target.inverse);
      if (!result.ok) {
        return fail(
          'revert-conflict',
          `The edit of ${event.target} can't be reverted after what was changed since: ${result.error.message}`,
          result.error,
        );
      }
      const edit: AppliedEdit = {
        utteranceId: event.target,
        isRevert: true,
        before: state.document,
        after: result.document,
        inverse: result.inverse,
      };
      return {
        ok: true,
        state: {
          ...base,
          document: result.document,
          applied: [...state.applied, edit],
          undone: [],
        },
      };
    }
  }
}

export type ReplayResult =
  | { ok: true; state: SessionState }
  | { ok: false; error: SessionError; eventIndex: number; state: SessionState };

/**
 * Rebuilds the state by applying events in order, from an empty session or
 * from a state cached earlier (a snapshot) followed by the newer events.
 */
export function replay(
  events: readonly SessionEvent[],
  start: SessionState = emptySession(),
): ReplayResult {
  let state = start;
  for (const [eventIndex, event] of events.entries()) {
    const result = applyEvent(state, event);
    if (!result.ok) return { ok: false, error: result.error, eventIndex, state };
    state = result.state;
  }
  return { ok: true, state };
}

// Persistence ------------------------------------------------------------------

const UtteranceSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  tokens: z.array(
    z.strictObject({
      text: z.string().min(1),
      start: z.number().int().min(0),
      end: z.number().int().min(1),
    }),
  ),
});

const SessionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('edit'), utterance: UtteranceSchema, batch: EditBatchSchema }),
  z.strictObject({ type: z.literal('undo'), utterance: UtteranceSchema.exactOptional() }),
  z.strictObject({ type: z.literal('redo'), utterance: UtteranceSchema.exactOptional() }),
  z.strictObject({
    type: z.literal('revert'),
    target: z.string().min(1),
    utterance: UtteranceSchema.exactOptional(),
  }),
]);

export const SessionLogSchema: z.ZodType<SessionLog> = z.strictObject({
  formatVersion: z.literal(1),
  events: z.array(SessionEventSchema),
});

export function serializeSessionLog(log: SessionLog): string {
  return JSON.stringify(SessionLogSchema.parse(log));
}

export type ParseSessionLogResult = { ok: true; log: SessionLog } | { ok: false; issues: string[] };

export function parseSessionLog(text: string): ParseSessionLogResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, issues: [error.message] };
  }
  const parsed = SessionLogSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, log: parsed.data }
    : { ok: false, issues: zodIssueMessages(parsed.error) };
}
