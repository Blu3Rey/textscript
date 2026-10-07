// The LLM translator (docs/adr/012): Claude writes edit commands as JSON.
//
// - The system prompt (instructions and examples) is frozen and cached; the
//   problem is a second cached block, since it repeats for a whole session;
//   only the turn varies.
// - Structured outputs keep the answer schema-valid; the snippet parser and
//   the applier check what's inside it.
// - If the answer doesn't compile or apply, the error goes back once. If the
//   second answer fails too, the commands that work are kept and the words
//   of the rest become notes.
// - Effort is set explicitly (Claude Opus 5.5 defaults to medium), and
//   refusals fall back server-side to the model Anthropic recommends.

import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaStopReason,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AnswerSchema,
  ANSWER_JSON_SCHEMA,
  encodeAnswer,
  salvageAnswer,
  type Answer,
} from './answer';
import { packProblem, packTurn } from './context';
import { systemPrompt, type Example } from './prompt';
import type { Translation, TranslationContext, TranslationUsage, Translator } from './translator';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** What the translator reads from a response. `BetaMessage` has all of it. */
export interface ModelReply {
  content: BetaContentBlock[];
  stop_reason: BetaStopReason | null;
  model: string;
  usage: Pick<
    BetaUsage,
    'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'
  >;
}

/** `client.beta.messages` from `@anthropic-ai/sdk`, or a stand-in for tests. */
export interface MessagesApi {
  create(params: MessageCreateParamsNonStreaming): Promise<ModelReply>;
}

export interface ClaudeTranslatorOptions {
  messages: MessagesApi;
  model?: string;
  effort?: Effort;
  examples?: readonly Example[];
  maxTokens?: number;
}

export class TranslatorError extends Error {
  readonly code: 'refusal' | 'max-tokens' | 'no-answer';

  constructor(code: TranslatorError['code'], message: string) {
    super(message);
    this.name = 'TranslatorError';
    this.code = code;
  }
}

/** US dollars per million tokens. Cache writes are the 5-minute kind. */
export const PRICES: Readonly<
  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function usageOf(replies: readonly ModelReply[], model: string): TranslationUsage {
  const total = (pick: (usage: ModelReply['usage']) => number | null) =>
    replies.reduce((sum, reply) => sum + (pick(reply.usage) ?? 0), 0);
  const input = total((u) => u.input_tokens);
  const output = total((u) => u.output_tokens);
  const cacheRead = total((u) => u.cache_read_input_tokens);
  const cacheWrite = total((u) => u.cache_creation_input_tokens);
  const price = PRICES[model];
  return {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
    ...(price
      ? {
          costUsd:
            (input * price.input +
              output * price.output +
              cacheRead * price.cacheRead +
              cacheWrite * price.cacheWrite) /
            1_000_000,
        }
      : {}),
  };
}

/** The JSON answer in a reply, or why there isn't one. */
function readAnswer(reply: ModelReply): Answer | string {
  const text = reply.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'The answer was not valid JSON.';
  }
  const parsed = AnswerSchema.safeParse(json);
  return parsed.success ? parsed.data : 'The answer did not match the schema.';
}

export function createClaudeTranslator(options: ClaudeTranslatorOptions): Translator {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? 'medium';
  const system = systemPrompt(options.examples ?? []);

  const request = (
    context: TranslationContext,
    messages: BetaMessageParam[],
  ): MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: options.maxTokens ?? 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMA } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: packProblem(context.problem),
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: packTurn(context) },
        ],
      },
      ...messages,
    ],
  });

  const call = async (
    context: TranslationContext,
    messages: BetaMessageParam[],
  ): Promise<ModelReply> => {
    const reply = await options.messages.create(request(context, messages));
    if (reply.stop_reason === 'refusal') {
      throw new TranslatorError('refusal', 'The model declined to translate this utterance.');
    }
    if (reply.stop_reason === 'max_tokens') {
      throw new TranslatorError('max-tokens', 'The answer was cut off at the token limit.');
    }
    return reply;
  };

  return {
    name: `claude:${model}:${effort}`,
    async translate(context: TranslationContext): Promise<Translation> {
      const replies: ModelReply[] = [];
      const errors: string[] = [];
      let answer: Answer | undefined;
      let followUp: BetaMessageParam[] = [];

      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await call(context, followUp);
        replies.push(reply);
        const read = readAnswer(reply);
        let feedback: string;
        if (typeof read === 'string') {
          feedback = read;
        } else {
          answer = read;
          const encoded = encodeAnswer(context, read);
          if (encoded.ok) {
            return {
              ...encoded.translation,
              usage: usageOf(replies, model),
              trace: { attempts: attempt + 1, salvaged: false, errors },
            };
          }
          const command = read.commands[encoded.index]?.command ?? '';
          feedback = `Command ${String(encoded.index + 1)} (${JSON.stringify(command)}) failed: ${encoded.code}: ${encoded.message}`;
        }
        errors.push(feedback);
        // Append-only: the reply goes back as it came, then the error.
        followUp = [
          ...followUp,
          { role: 'assistant', content: reply.content },
          { role: 'user', content: `${feedback}\nReturn the whole answer again, corrected.` },
        ];
      }

      if (answer === undefined) {
        throw new TranslatorError('no-answer', errors.join(' '));
      }
      return {
        ...salvageAnswer(context, answer),
        usage: usageOf(replies, model),
        trace: { attempts: 2, salvaged: true, errors },
      };
    },
  };
}
