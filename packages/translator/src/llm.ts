// What every LLM translator shares, whatever the provider (docs/adr/012,
// docs/adr/014): the model writes edit commands as JSON; if they don't
// compile or apply, the error goes back once; if the second answer fails
// too, the commands that work are kept and the words of the rest become
// unparsed spans. A provider adapter only sends messages and reads replies.

import { AnswerSchema, encodeAnswer, salvageAnswer, type Answer } from './answer';
import type { Example } from './prompt';
import type { Translation, TranslationContext, TranslationUsage, Translator } from './translator';

/** The effort (Claude) or thinking level (Gemini) a translator asks for. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export class TranslatorError extends Error {
  readonly code: 'refusal' | 'max-tokens' | 'no-answer';

  constructor(code: TranslatorError['code'], message: string) {
    super(message);
    this.name = 'TranslatorError';
    this.code = code;
  }
}

/** US dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Token counts, split the way they're priced. */
export interface TokenCounts {
  /** Input tokens not read from or written to a cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function usageOf(counts: TokenCounts, price: Price | undefined): TranslationUsage {
  return {
    inputTokens: counts.input + counts.cacheRead + counts.cacheWrite,
    outputTokens: counts.output,
    ...(price
      ? {
          costUsd:
            (counts.input * price.input +
              counts.output * price.output +
              counts.cacheRead * price.cacheRead +
              counts.cacheWrite * price.cacheWrite) /
            1_000_000,
        }
      : {}),
  };
}

export function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** One translation's exchange with a model. Keeps its own history. */
export interface Conversation {
  /**
   * The first call sends the problem and the turn; later calls append the
   * previous reply as it came, then `feedback`. Returns the answer's text,
   * or throws a `TranslatorError` for a refusal or a cut-off answer.
   */
  send(feedback?: string): Promise<string>;
  /** Everything used so far, priced if the model's price is known. */
  usage(): TranslationUsage;
}

/** A provider adapter: Claude, Gemini, … */
export interface LlmBackend {
  /** Appears in reports: `provider:model:effort`. */
  readonly name: string;
  start(context: TranslationContext): Conversation;
}

export interface LlmTranslatorOptions {
  examples?: readonly Example[];
}

/** The JSON answer in a reply, or why there isn't one. */
function readAnswer(text: string): Answer | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'The answer was not valid JSON.';
  }
  const parsed = AnswerSchema.safeParse(json);
  return parsed.success ? parsed.data : 'The answer did not match the schema.';
}

/** A translator that runs the answer, retry and salvage loop over any backend. */
export function createLlmTranslator(backend: LlmBackend): Translator {
  return {
    name: backend.name,
    async translate(context: TranslationContext): Promise<Translation> {
      const conversation = backend.start(context);
      const errors: string[] = [];
      let answer: Answer | undefined;
      let feedback: string | undefined;

      for (let attempt = 0; attempt < 2; attempt++) {
        const read = readAnswer(
          await conversation.send(
            feedback === undefined
              ? undefined
              : `${feedback}\nReturn the whole answer again, corrected.`,
          ),
        );
        if (typeof read === 'string') {
          feedback = read;
        } else {
          answer = read;
          const encoded = encodeAnswer(context, read);
          if (encoded.ok) {
            return {
              ...encoded.translation,
              usage: conversation.usage(),
              trace: { attempts: attempt + 1, salvaged: false, errors },
            };
          }
          feedback = `Command ${String(encoded.index + 1)} (${JSON.stringify(encoded.command)}) failed: ${encoded.code}: ${encoded.message}`;
        }
        errors.push(feedback);
      }

      if (answer === undefined) {
        throw new TranslatorError('no-answer', errors.join(' '));
      }
      return {
        ...salvageAnswer(context, answer),
        usage: conversation.usage(),
        trace: { attempts: 2, salvaged: true, errors },
      };
    },
  };
}
