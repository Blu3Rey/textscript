// The Translator turns one utterance into one edit batch (ROADMAP.md §2.1).
// It's the only part of the system that may use a language model; everything
// it returns still goes through the validator (S8) and `apply`.

import type { EditBatch, IrDocument, Span, Utterance } from '@textscript/core';

/** The interview problem being solved. Never includes a solution. */
export interface ProblemContext {
  id: string;
  title: string;
  /** The statement as the candidate would read it. */
  statement: string;
  /** Names the problem gives as inputs, such as `nums`. */
  inputs: string[];
}

export interface TranslationContext {
  /** What was just said, already tokenized. Spans cite its token indices. */
  utterance: Utterance;
  /** The solution as it stands before this utterance. */
  document: IrDocument;
  /** Earlier utterances, oldest first, for "it", "that" and "then". */
  recent: Utterance[];
  problem: ProblemContext;
}

export interface TranslationUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in US dollars, when the translator can work it out. */
  costUsd?: number;
}

export interface Translation {
  /**
   * The edits for this utterance. Its `utteranceId` is the utterance's ID.
   * Questions for the user are `ask_clarification` ops in the batch.
   */
  batch: EditBatch;
  /**
   * Words the translator couldn't encode. `withUnparsedNotes` keeps them as
   * notes, so nothing said is lost (ROADMAP.md principle 6).
   */
  unparsedSpans: Span[];
  usage?: TranslationUsage;
  /**
   * What the validator held back from the batch (docs/adr/013): info-level
   * notes for the user, each stating what the words didn't say.
   */
  heldBack?: HeldBackNotice[];
  /** How the translation went, for reports. */
  trace?: { attempts: number; salvaged: boolean; errors: string[] };
}

export interface HeldBackNotice {
  /** A `VALIDATION_CODES` code from `@textscript/validator`. */
  code: string;
  /** The code that was held back. */
  proposed: string;
  message: string;
  spans: Span[];
}

export interface Translator {
  /** Short and stable; it appears in reports. */
  readonly name: string;
  translate(context: TranslationContext): Promise<Translation>;
}

/** Translates nothing. The floor for every metric except faithfulness. */
export const emptyTranslator: Translator = {
  name: 'empty',
  translate: (context) =>
    Promise.resolve({ batch: { utteranceId: context.utterance.id, ops: [] }, unparsedSpans: [] }),
};
