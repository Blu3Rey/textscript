// A translator's answer: edit commands (docs/adr/012), each citing the words
// it came from, and the words it couldn't encode. Answers compile into an
// edit batch through the commands package, the same way gold does.
//
// The JSON Schema is flat on purpose. Structured outputs don't support
// recursive schemas, and the IR is recursive; the commands carry the code
// as text, and the snippet parser checks it.

import { compileCommands, EDIT_COMMANDS, type CommandInput } from '@textscript/commands';
import { quoteSpan, type EditOp, type Span } from '@textscript/core';
import { z } from 'zod';
import type { Translation, TranslationContext } from './translator';

export interface AnswerCommand {
  command: string;
  /** `[start, end]` word indices (end exclusive), or `[]` for the whole utterance. */
  words: number[];
}

export interface Answer {
  commands: AnswerCommand[];
  /** Word ranges with content the commands don't capture. Not filler. */
  unparsed: { start: number; end: number }[];
}

export const AnswerSchema: z.ZodType<Answer> = z.object({
  commands: z.array(z.object({ command: z.string(), words: z.array(z.number().int()) })),
  unparsed: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
});

/** The same shape as JSON Schema, for `output_config.format`. */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          words: { type: 'array', items: { type: 'integer' } },
        },
        required: ['command', 'words'],
        additionalProperties: false,
      },
    },
    unparsed: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'integer' }, end: { type: 'integer' } },
        required: ['start', 'end'],
        additionalProperties: false,
      },
    },
  },
  required: ['commands', 'unparsed'],
  additionalProperties: false,
} as const;

function span(context: TranslationContext, start: number, end: number): Span | undefined {
  const words = context.utterance.tokens.length;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > words ||
    start >= end
  ) {
    return undefined;
  }
  return { utteranceId: context.utterance.id, start, end };
}

function whole(context: TranslationContext): Span[] {
  const words = context.utterance.tokens.length;
  return words > 0 ? [{ utteranceId: context.utterance.id, start: 0, end: words }] : [];
}

/**
 * Splits commands a model wrote into one string ("add root: a = 0\nadd root:
 * b = 0"): a line at column 0 that starts with a command word, then a space
 * and something other than an operator, starts a new command.
 */
export function splitCommands(command: string): string[] {
  const commands: string[] = [];
  for (const line of command.split('\n')) {
    const match = /^([a-z]+) +[^\s=(.[+\-*/%<>!]/.exec(line);
    const last = commands.length - 1;
    if (last < 0 || (match?.[1] !== undefined && EDIT_COMMANDS.has(match[1]))) commands.push(line);
    else commands[last] = `${commands[last] ?? ''}\n${line}`;
  }
  return commands;
}

/** Commands with their provenance; a missing or bad word range means the whole utterance. */
function inputs(context: TranslationContext, commands: readonly AnswerCommand[]): CommandInput[] {
  return commands.flatMap(({ command, words }) => {
    const [start, end] = words;
    const cited = start === undefined || end === undefined ? undefined : span(context, start, end);
    return splitCommands(command).map((text) => ({
      text,
      provenance: cited ? [cited] : whole(context),
    }));
  });
}

/** A note on the program keeping words that weren't encoded. */
function noteFor(context: TranslationContext, keep: Span): EditOp | undefined {
  const words = quoteSpan(keep, [...context.recent, context.utterance]);
  if (words === undefined || words.trim() === '') return undefined;
  return {
    op: 'add_note',
    node: context.document.program.id,
    text: `Not encoded: "${words}"`,
    tag: 'general',
    provenance: [keep],
  };
}

/**
 * Adds a note for each unparsed span, so nothing said is lost (ROADMAP.md
 * principle 6). The app applies this before `apply`; evaluation scores the
 * translation without it.
 */
export function withUnparsedNotes(
  context: TranslationContext,
  translation: Translation,
): Translation {
  const notes = translation.unparsedSpans.flatMap((keep) => {
    const op = noteFor(context, keep);
    return op ? [op] : [];
  });
  return {
    ...translation,
    batch: { ...translation.batch, ops: [...translation.batch.ops, ...notes] },
  };
}

export type EncodeResult =
  | { ok: true; translation: Translation }
  | { ok: false; index: number; command: string; code: string; message: string };

function unparsedSpans(context: TranslationContext, answer: Answer): Span[] {
  return answer.unparsed.flatMap(({ start, end }) => {
    const keep = span(context, start, end);
    return keep ? [keep] : [];
  });
}

function translation(
  context: TranslationContext,
  ops: readonly EditOp[],
  unparsed: Span[],
): Translation {
  return { batch: { utteranceId: context.utterance.id, ops: [...ops] }, unparsedSpans: unparsed };
}

/** Compiles an answer exactly, or says which command failed and why. */
export function encodeAnswer(context: TranslationContext, answer: Answer): EncodeResult {
  const commands = inputs(context, answer.commands);
  const result = compileCommands(context.document, commands, {
    utteranceId: context.utterance.id,
    provenance: whole(context),
  });
  if (!result.ok) {
    const command = commands[result.index]?.text ?? '';
    return { ok: false, index: result.index, command, code: result.code, message: result.message };
  }
  return {
    ok: true,
    translation: translation(context, result.batch.ops, unparsedSpans(context, answer)),
  };
}

/**
 * Keeps what can be kept: each command that still compiles after the ones
 * kept before it stays; the words of the others are reported as unparsed,
 * so nothing said is lost and nothing unchecked gets in.
 */
export function salvageAnswer(context: TranslationContext, answer: Answer): Translation {
  const options = { utteranceId: context.utterance.id, provenance: whole(context) };
  const kept: CommandInput[] = [];
  const lost: Span[] = [];
  for (const command of inputs(context, answer.commands)) {
    if (compileCommands(context.document, [...kept, command], options).ok) kept.push(command);
    else lost.push(...(command.provenance ?? []));
  }
  const compiled = compileCommands(context.document, kept, options);
  return translation(context, compiled.batch.ops, [...unparsedSpans(context, answer), ...lost]);
}
