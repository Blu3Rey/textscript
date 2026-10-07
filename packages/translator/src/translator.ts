// The Translator turns one utterance into one edit batch (ROADMAP.md §2.1).
// It's the only part of the system that may use a language model; everything
// it returns still goes through the validator (S8) and `apply`.
//
// S6 defines the contract so the evaluation runner can drive any
// translator. S7 adds the baseline and LLM implementations.

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
  /** Words the translator couldn't encode. The caller keeps them as notes. */
  unparsedSpans: Span[];
  usage?: TranslationUsage;
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
