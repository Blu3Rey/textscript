import { createUtterance, emptySession } from '@textscript/core';
import type { ChatRequest, Ollama } from 'ollama';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_JSON_SCHEMA,
  createOllamaTranslator,
  packProblem,
  packTurn,
  systemPrompt,
  type Answer,
  type OllamaChatApi,
  type OllamaReply,
  type TranslationContext,
} from '../src/index';
import { examples } from '../src/examples';

const problem = {
  id: 'dup',
  title: 'Contains Duplicate',
  statement: 'Find a repeat.',
  inputs: ['nums'],
};

function context(text = 'Loop through the list of numbers.'): TranslationContext {
  return {
    utterance: createUtterance('u1', text),
    document: emptySession().document,
    recent: [],
    problem,
  };
}

function reply(answer: Answer | string, doneReason = 'stop'): OllamaReply {
  return {
    message: {
      role: 'assistant',
      content: typeof answer === 'string' ? answer : JSON.stringify(answer),
      thinking: 'Let me see.',
    },
    done_reason: doneReason,
    prompt_eval_count: 3000,
    eval_count: 200,
  };
}

function fake(...replies: OllamaReply[]): OllamaChatApi & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(structuredClone(request));
      const next = replies.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error('no more replies'));
    },
  };
}

const loop: Answer = {
  commands: [{ command: 'add root: for num~loopvar in nums:\n    ...', words: [0, 6] }],
  unparsed: [],
};

describe('the Ollama translator', () => {
  it('sends the prompt, the problem and the turn with a schema and a context window big enough for them', async () => {
    const ollama = fake(reply(loop));
    await createOllamaTranslator({ ollama, examples }).translate(context());
    expect(ollama.requests[0]).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: systemPrompt(examples) },
        { role: 'user', content: `${packProblem(problem)}\n\n${packTurn(context())}` },
      ],
      stream: false,
      format: ANSWER_JSON_SCHEMA,
      options: { num_ctx: 16384, num_predict: 8192, seed: 42 },
    });
  });

  it('reads the answer, counts tokens and costs nothing', async () => {
    const translator = createOllamaTranslator({ ollama: fake(reply(loop)) });
    expect(translator.name).toBe('ollama:qwen3:8b');
    const translation = await translator.translate(context());
    expect(translation.batch.ops.map((op) => op.op)).toEqual(['add_stmt']);
    expect(translation.usage).toEqual({ inputTokens: 3000, outputTokens: 200, costUsd: 0 });
  });

  it('passes think, model and limits through when set', async () => {
    const ollama = fake(reply(loop));
    const translator = createOllamaTranslator({
      ollama,
      model: 'gpt-oss:20b',
      think: 'low',
      contextLength: 32768,
      maxTokens: 2000,
      seed: 7,
    });
    expect(translator.name).toBe('ollama:gpt-oss:20b:think-low');
    await translator.translate(context());
    expect(ollama.requests[0]).toMatchObject({
      model: 'gpt-oss:20b',
      think: 'low',
      options: { num_ctx: 32768, num_predict: 2000, seed: 7 },
    });
  });

  it('sends the error back once, appending the answer without its thinking', async () => {
    const bad: Answer = { commands: [{ command: 'fill h1: x', words: [] }], unparsed: [] };
    const ollama = fake(reply(bad), reply(loop));
    const translation = await createOllamaTranslator({ ollama }).translate(context());
    expect(translation.trace?.attempts).toBe(2);
    expect(ollama.requests[1]?.messages?.slice(2)).toEqual([
      { role: 'assistant', content: JSON.stringify(bad) },
      {
        role: 'user',
        content: `${translation.trace?.errors[0] ?? ''}\nReturn the whole answer again, corrected.`,
      },
    ]);
    expect(translation.usage?.inputTokens).toBe(6000);
  });

  it('reports a cut-off answer, and gives up after two non-answers', async () => {
    await expect(
      createOllamaTranslator({ ollama: fake(reply(loop, 'length')) }).translate(context()),
    ).rejects.toMatchObject({ code: 'max-tokens' });
    await expect(
      createOllamaTranslator({ ollama: fake(reply(''), reply('{"commands": 1}')) }).translate(
        context(),
      ),
    ).rejects.toMatchObject({ code: 'no-answer' });
  });

  it('retries once when the connection drops, but not on other errors', async () => {
    let calls = 0;
    const flaky: OllamaChatApi = {
      chat() {
        calls++;
        return calls === 1
          ? Promise.reject(new TypeError('fetch failed'))
          : Promise.resolve(reply(loop));
      },
    };
    const translation = await createOllamaTranslator({ ollama: flaky }).translate(context());
    expect(calls).toBe(2);
    expect(translation.batch.ops).toHaveLength(1);
    const missing: OllamaChatApi = {
      chat: () => Promise.reject(new Error('model "qwen3:8b" not found, try pulling it first')),
    };
    await expect(createOllamaTranslator({ ollama: missing }).translate(context())).rejects.toThrow(
      'not found',
    );
  });

  it('accepts the real client', () => {
    const typed = (client: Ollama): OllamaChatApi => client;
    expect(typed).toBeTypeOf('function');
  });
});
