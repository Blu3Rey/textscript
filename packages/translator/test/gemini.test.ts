import {
  BlockedReason,
  FinishReason,
  ThinkingLevel,
  type GenerateContentParameters,
  type GoogleGenAI,
} from '@google/genai';
import { createUtterance, emptySession } from '@textscript/core';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_JSON_SCHEMA,
  createGeminiTranslator,
  packProblem,
  packTurn,
  systemPrompt,
  TranslatorError,
  type Answer,
  type GeminiModelsApi,
  type GeminiReply,
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

function reply(
  answer: Answer | string,
  finishReason: FinishReason = FinishReason.STOP,
  extra: Partial<GeminiReply> = {},
): GeminiReply {
  return {
    candidates: [
      {
        finishReason,
        content: {
          role: 'model',
          parts: [
            { text: 'thinking about it', thought: true, thoughtSignature: 'sig' },
            { text: typeof answer === 'string' ? answer : JSON.stringify(answer) },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 1000,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 60,
    },
    ...extra,
  };
}

function fake(
  ...replies: GeminiReply[]
): GeminiModelsApi & { requests: GenerateContentParameters[] } {
  const requests: GenerateContentParameters[] = [];
  return {
    requests,
    generateContent(params) {
      requests.push(structuredClone(params));
      const next = replies.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error('no more replies'));
    },
  };
}

const loop: Answer = {
  commands: [{ command: 'add root: for num~loopvar in nums:\n    ...', words: [0, 6] }],
  unparsed: [],
};

describe('the Gemini translator', () => {
  it('sends the prompt as a system instruction, then the problem and the turn, with a JSON schema', async () => {
    const api = fake(reply(loop));
    await createGeminiTranslator({ models: api, examples, effort: 'low' }).translate(context());
    expect(api.requests[0]).toEqual({
      model: 'gemini-3.5-flash',
      contents: [
        { role: 'user', parts: [{ text: packProblem(problem) }, { text: packTurn(context()) }] },
      ],
      config: {
        systemInstruction: systemPrompt(examples),
        responseMimeType: 'application/json',
        responseJsonSchema: ANSWER_JSON_SCHEMA,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 16000,
      },
    });
  });

  it('reads the answer, skipping thoughts, and prices thinking as output', async () => {
    const translator = createGeminiTranslator({ models: fake(reply(loop)) });
    expect(translator.name).toBe('gemini:gemini-3.5-flash:medium');
    const translation = await translator.translate(context());
    expect(translation.batch.ops.map((op) => op.op)).toEqual(['add_stmt']);
    expect(translation.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: (200 * 1.5 + 100 * 9 + 800 * 1.5) / 1e6,
    });
    expect(translation.trace).toEqual({ attempts: 1, salvaged: false, errors: [] });
  });

  it('sends the error back once, appending the model content with its thought signature', async () => {
    const bad: Answer = { commands: [{ command: 'fill h1: x', words: [] }], unparsed: [] };
    const api = fake(reply(bad), reply(loop));
    const translation = await createGeminiTranslator({ models: api, effort: 'max' }).translate(
      context(),
    );
    expect(translation.trace?.attempts).toBe(2);
    const second = api.requests[1];
    expect(second?.config?.thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.HIGH);
    expect(Array.isArray(second?.contents) ? second.contents.slice(1) : []).toEqual([
      reply(bad).candidates?.[0]?.content,
      {
        role: 'user',
        parts: [
          {
            text: `${translation.trace?.errors[0] ?? ''}\nReturn the whole answer again, corrected.`,
          },
        ],
      },
    ]);
  });

  it('salvages after two failures, and gives up on two non-answers', async () => {
    const mixed: Answer = {
      commands: [
        { command: 'add root: seen = set()', words: [0, 2] },
        { command: 'remove n99', words: [3, 5] },
      ],
      unparsed: [],
    };
    const salvaged = await createGeminiTranslator({
      models: fake(reply(mixed), reply(mixed)),
    }).translate(context('A set called seen, then drop it.'));
    expect(salvaged.trace).toMatchObject({ attempts: 2, salvaged: true });
    await expect(
      createGeminiTranslator({ models: fake(reply('nope'), { candidates: [] }) }).translate(
        context(),
      ),
    ).rejects.toMatchObject({ code: 'no-answer' });
  });

  it('reports blocked prompts, safety stops and cut-off answers', async () => {
    const cases: [GeminiReply, string][] = [
      [
        reply(loop, FinishReason.STOP, { promptFeedback: { blockReason: BlockedReason.SAFETY } }),
        'refusal',
      ],
      [reply(loop, FinishReason.PROHIBITED_CONTENT), 'refusal'],
      [reply(loop, FinishReason.MAX_TOKENS), 'max-tokens'],
    ];
    for (const [answer, code] of cases) {
      const attempt = createGeminiTranslator({ models: fake(answer) }).translate(context());
      await expect(attempt).rejects.toBeInstanceOf(TranslatorError);
      await expect(
        createGeminiTranslator({ models: fake(answer) }).translate(context()),
      ).rejects.toMatchObject({ code });
    }
    const unspecified = reply(loop, FinishReason.STOP, {
      promptFeedback: { blockReason: BlockedReason.BLOCKED_REASON_UNSPECIFIED },
    });
    expect(
      (await createGeminiTranslator({ models: fake(unspecified) }).translate(context())).batch.ops,
    ).toHaveLength(1);
  });

  it('leaves cost out for unknown models and counts missing usage as zero', async () => {
    const translation = await createGeminiTranslator({
      models: fake({ candidates: reply(loop).candidates ?? [] }),
      model: 'gemini-x',
    }).translate(context());
    expect(translation.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('accepts the real SDK client', () => {
    const typed = (ai: GoogleGenAI): GeminiModelsApi => ai.models;
    expect(typed).toBeTypeOf('function');
  });
});
