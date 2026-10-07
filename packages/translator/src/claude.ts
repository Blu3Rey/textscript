// The Claude adapter for the LLM translator (docs/adr/012).
//
// - The system prompt (instructions and examples) is frozen and cached; the
//   problem is a second cached block, since it repeats for a whole session;
//   only the turn varies.
// - Structured outputs keep the answer schema-valid; the snippet parser and
//   the applier check what's inside it.
// - Effort is set explicitly (Claude Opus 5.5 defaults to medium), and
//   refusals fall back server-side to the model Anthropic recommends.
// - A retry appends the reply's content blocks unchanged, then the error.

import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaStopReason,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ANSWER_JSON_SCHEMA } from './answer';
import { packProblem, packTurn } from './context';
import {
  addCounts,
  createLlmTranslator,
  NO_TOKENS,
  TranslatorError,
  usageOf,
  type Conversation,
  type Effort,
  type LlmBackend,
  type LlmTranslatorOptions,
  type Price,
  type TokenCounts,
} from './llm';
import { systemPrompt } from './prompt';
import type { TranslationContext, Translator } from './translator';

export const DEFAULT_MODEL = 'claude-opus-5-5';

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

export interface ClaudeTranslatorOptions extends LlmTranslatorOptions {
  messages: MessagesApi;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

/** US dollars per million tokens. Cache writes are the 5-minute kind. */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function claudeBackend(options: ClaudeTranslatorOptions): LlmBackend {
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

  return {
    name: `claude:${model}:${effort}`,
    start(context): Conversation {
      let history: BetaMessageParam[] = [];
      let last: ModelReply | undefined;
      let counts: TokenCounts = NO_TOKENS;
      return {
        async send(feedback) {
          if (feedback !== undefined && last !== undefined) {
            // Append-only: the reply goes back as it came, then the error.
            history = [
              ...history,
              { role: 'assistant', content: last.content },
              { role: 'user', content: feedback },
            ];
          }
          const reply = await options.messages.create(request(context, history));
          last = reply;
          counts = addCounts(counts, {
            input: reply.usage.input_tokens,
            output: reply.usage.output_tokens,
            cacheRead: reply.usage.cache_read_input_tokens ?? 0,
            cacheWrite: reply.usage.cache_creation_input_tokens ?? 0,
          });
          if (reply.stop_reason === 'refusal') {
            throw new TranslatorError('refusal', 'The model declined to translate this utterance.');
          }
          if (reply.stop_reason === 'max_tokens') {
            throw new TranslatorError('max-tokens', 'The answer was cut off at the token limit.');
          }
          return reply.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('');
        },
        usage: () => usageOf(counts, PRICES[model]),
      };
    },
  };
}

export function createClaudeTranslator(options: ClaudeTranslatorOptions): Translator {
  return createLlmTranslator(claudeBackend(options));
}
