// The Gemini adapter for the LLM translator (docs/adr/014). Same prompt,
// answer schema, retry and salvage as Claude; only the wire differs.
//
// - The system instruction (instructions and examples) and the problem come
//   first and never change within a session, so Gemini's implicit caching
//   can reuse them; only the turn varies.
// - `responseJsonSchema` keeps the answer schema-valid.
// - Effort maps to a thinking level.
// - Blocked prompts and safety stops are refusals; MAX_TOKENS is a cut-off.
// - A retry appends the model's content unchanged (thought signatures
//   included), then the error.

import {
  BlockedReason,
  FinishReason,
  ThinkingLevel,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
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
import type { Translator } from './translator';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

/** What the translator reads from a response. `GenerateContentResponse` has all of it. */
export type GeminiReply = Pick<
  GenerateContentResponse,
  'candidates' | 'promptFeedback' | 'usageMetadata'
>;

/** `ai.models` from `@google/genai`, or a stand-in for tests. */
export interface GeminiModelsApi {
  generateContent(params: GenerateContentParameters): Promise<GeminiReply>;
}

export interface GeminiTranslatorOptions extends LlmTranslatorOptions {
  models: GeminiModelsApi;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

/**
 * US dollars per million tokens, prompts up to 200k tokens. Cached input is
 * priced as plain input, so costs are an upper bound when caching hits.
 */
export const GEMINI_PRICES: Readonly<Record<string, Price>> = {
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 1.5, cacheWrite: 0 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 2, cacheWrite: 0 },
};

const THINKING: Readonly<Record<Effort, ThinkingLevel>> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

const REFUSALS: ReadonlySet<FinishReason> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

export function geminiBackend(options: GeminiTranslatorOptions): LlmBackend {
  const model = options.model ?? GEMINI_DEFAULT_MODEL;
  const effort = options.effort ?? 'medium';
  const system = systemPrompt(options.examples ?? []);

  return {
    name: `gemini:${model}:${effort}`,
    start(context): Conversation {
      let contents: Content[] = [
        {
          role: 'user',
          parts: [{ text: packProblem(context.problem) }, { text: packTurn(context) }],
        },
      ];
      let last: Content | undefined;
      let counts: TokenCounts = NO_TOKENS;
      return {
        async send(feedback) {
          if (feedback !== undefined && last !== undefined) {
            contents = [...contents, last, { role: 'user', parts: [{ text: feedback }] }];
          }
          const reply = await options.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: system,
              responseMimeType: 'application/json',
              responseJsonSchema: ANSWER_JSON_SCHEMA,
              thinkingConfig: { thinkingLevel: THINKING[effort] },
              maxOutputTokens: options.maxTokens ?? 16000,
            },
          });
          const meta = reply.usageMetadata;
          const cached = meta?.cachedContentTokenCount ?? 0;
          counts = addCounts(counts, {
            input: (meta?.promptTokenCount ?? 0) - cached,
            // Thinking is billed as output.
            output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
            cacheRead: cached,
            cacheWrite: 0,
          });
          const blocked = reply.promptFeedback?.blockReason;
          if (blocked !== undefined && blocked !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
            throw new TranslatorError('refusal', `The prompt was blocked (${blocked}).`);
          }
          const candidate = reply.candidates?.[0];
          const reason = candidate?.finishReason;
          if (reason !== undefined && REFUSALS.has(reason)) {
            throw new TranslatorError('refusal', `The model stopped (${reason}).`);
          }
          if (reason === FinishReason.MAX_TOKENS) {
            throw new TranslatorError('max-tokens', 'The answer was cut off at the token limit.');
          }
          last = candidate?.content ?? { role: 'model', parts: [] };
          return (last.parts ?? [])
            .flatMap((part) =>
              part.thought === true || part.text === undefined ? [] : [part.text],
            )
            .join('');
        },
        usage: () => usageOf(counts, GEMINI_PRICES[model]),
      };
    },
  };
}

export function createGeminiTranslator(options: GeminiTranslatorOptions): Translator {
  return createLlmTranslator(geminiBackend(options));
}
