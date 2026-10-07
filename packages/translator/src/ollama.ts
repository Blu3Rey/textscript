// The Ollama adapter for the LLM translator (docs/adr/014): models running
// locally, so no key, no rate limits and no cost. Same prompt, answer
// schema, retry and salvage as Claude and Gemini.
//
// - Ollama's default context window (a few thousand tokens) is smaller
//   than the prompt with its examples, and it truncates silently, so the
//   adapter always sets `num_ctx`.
// - `format` takes the answer's JSON schema (structured outputs).
// - Thinking is the model's default unless `think` is set: some models
//   take true/false, some take low/medium/high, and some reject it.
// - A `length` stop is a cut-off. There are no refusals to detect.
// - A dropped connection ("fetch failed") is retried once.

import type { ChatRequest, ChatResponse, Message } from 'ollama';
import { ANSWER_JSON_SCHEMA } from './answer';
import { packProblem, packTurn } from './context';
import {
  addCounts,
  createLlmTranslator,
  NO_TOKENS,
  TranslatorError,
  usageOf,
  type Conversation,
  type LlmBackend,
  type LlmTranslatorOptions,
  type TokenCounts,
} from './llm';
import { systemPrompt } from './prompt';
import type { Translator } from './translator';

export const OLLAMA_DEFAULT_MODEL = 'qwen3:8b';

/** Enough for the prompt, its examples, a long session and the answer. */
export const OLLAMA_DEFAULT_CONTEXT = 16384;

/** What the translator reads from a response. `ChatResponse` has all of it. */
export type OllamaReply = Pick<
  ChatResponse,
  'message' | 'done_reason' | 'prompt_eval_count' | 'eval_count'
>;

/** `new Ollama({ host })` from the `ollama` package, or a stand-in for tests. */
export interface OllamaChatApi {
  chat(request: ChatRequest & { stream?: false }): Promise<OllamaReply>;
}

export interface OllamaTranslatorOptions extends LlmTranslatorOptions {
  ollama: OllamaChatApi;
  model?: string;
  /** Leave unset for the model's default; not every model accepts every value. */
  think?: ChatRequest['think'];
  /** `num_ctx`: tokens of context, prompt and answer together. */
  contextLength?: number;
  maxTokens?: number;
}

export function ollamaBackend(options: OllamaTranslatorOptions): LlmBackend {
  const model = options.model ?? OLLAMA_DEFAULT_MODEL;
  const system = systemPrompt(options.examples ?? []);
  const think = options.think;

  return {
    name: `ollama:${model}${think === undefined ? '' : `:think-${String(think)}`}`,
    start(context): Conversation {
      let messages: Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: `${packProblem(context.problem)}\n\n${packTurn(context)}` },
      ];
      let last: Message | undefined;
      let counts: TokenCounts = NO_TOKENS;
      return {
        async send(feedback) {
          if (feedback !== undefined && last !== undefined) {
            messages = [
              ...messages,
              { role: 'assistant', content: last.content },
              { role: 'user', content: feedback },
            ];
          }
          const request = {
            model,
            messages,
            stream: false,
            format: ANSWER_JSON_SCHEMA,
            ...(think === undefined ? {} : { think }),
            options: {
              num_ctx: options.contextLength ?? OLLAMA_DEFAULT_CONTEXT,
              num_predict: options.maxTokens ?? 8192,
            },
          } satisfies ChatRequest & { stream: false };
          let reply: OllamaReply;
          try {
            reply = await options.ollama.chat(request);
          } catch (error) {
            // "fetch failed": the connection dropped or Node gave up waiting
            // (it waits five minutes for a response to start). Try once more.
            if (!(error instanceof TypeError)) throw error;
            reply = await options.ollama.chat(request);
          }
          counts = addCounts(counts, {
            input: reply.prompt_eval_count,
            output: reply.eval_count,
            cacheRead: 0,
            cacheWrite: 0,
          });
          if (reply.done_reason === 'length') {
            throw new TranslatorError('max-tokens', 'The answer was cut off at the token limit.');
          }
          last = reply.message;
          return reply.message.content;
        },
        // Local models cost nothing per token.
        usage: () => usageOf(counts, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      };
    },
  };
}

export function createOllamaTranslator(options: OllamaTranslatorOptions): Translator {
  return createLlmTranslator(ollamaBackend(options));
}
