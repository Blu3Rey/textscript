import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { compileCommands } from '@textscript/commands';
import { createUtterance, emptySession } from '@textscript/core';
import { FinishReason, type GenerateContentParameters } from '@google/genai';
import type {
  GeminiModelsApi,
  GeminiReply,
  MessagesApi,
  ModelReply,
  OllamaChatApi,
  Translator,
} from '@textscript/translator';
import type { ChatRequest } from 'ollama';
import { describe, expect, it } from 'vitest';
import {
  checkBatch,
  createClaudeVerifier,
  createGeminiVerifier,
  createOllamaVerifier,
  GEMINI_VERIFIER_MODEL,
  validatedTranslator,
  VERIFIER_MODEL,
  type Claim,
  type Verifier,
} from '../src/index';

const utterance = createUtterance('u1', 'Set x to nums at target.');
const document = emptySession().document;
const compiled = compileCommands(document, [{ text: 'add root: x = nums[target]' }], {
  utteranceId: 'u1',
  provenance: [{ utteranceId: 'u1', start: 0, end: utterance.tokens.length }],
});
if (!compiled.ok) throw new Error(compiled.message);
const batch = compiled.batch;
const input = { document, batch, utterances: [utterance], inputs: ['nums', 'target'] };

/** A verifier that rejects claims whose code matches. */
function rejecting(pattern: RegExp): Verifier & { asked: Claim[][] } {
  const asked: Claim[][] = [];
  return {
    name: 'fake',
    asked,
    verify(claims) {
      asked.push([...claims]);
      return Promise.resolve(claims.map((claim) => !pattern.test(claim.code)));
    },
  };
}

describe('checkBatch', () => {
  it('is validate when there is no verifier or nothing to ask', async () => {
    expect((await checkBatch(input)).claims).toHaveLength(2);
    const verifier = rejecting(/x/);
    const said = createUtterance('u1', 'Return true.');
    const plain = compileCommands(document, [{ text: 'add root: return True' }], {
      utteranceId: 'u1',
      provenance: [{ utteranceId: 'u1', start: 0, end: 3 }],
    });
    if (!plain.ok) throw new Error(plain.message);
    await checkBatch({ document, batch: plain.batch, utterances: [said] }, { verifier });
    expect(verifier.asked).toEqual([]);
  });

  it('holds back what the second opinion rejects', async () => {
    const verifier = rejecting(/^nums\[target\]$/);
    const result = await checkBatch(input, { verifier });
    expect(verifier.asked[0]?.map((c) => c.code)).toEqual(['x = nums[target]', 'nums[target]']);
    expect(result.heldBack).toMatchObject([
      {
        code: 'VAL005',
        proposed: 'nums[target]',
        message:
          'A second opinion found the words "Set x to nums at target." don\'t say `nums[target]`',
      },
    ]);
    expect(result.batch.ops.at(-1)).toMatchObject({
      op: 'replace_node',
      replacement: { kind: 'ExprHole' },
    });
  });

  it('keeps everything when the second opinion agrees', async () => {
    const result = await checkBatch(input, { verifier: rejecting(/^$/) });
    expect(result.heldBack).toEqual([]);
    expect(result.batch).toBe(batch);
  });
});

describe('validatedTranslator', () => {
  it('validates every batch and reports what it held back', async () => {
    const inner: Translator = {
      name: 'inner',
      translate: (context) =>
        Promise.resolve({
          batch: { ...batch, utteranceId: context.utterance.id },
          unparsedSpans: [],
        }),
    };
    const context = {
      utterance,
      document,
      recent: [],
      problem: { id: 'p', title: 'P', statement: 'S', inputs: ['nums', 'target'] },
    };
    const plain = await validatedTranslator(inner).translate(context);
    expect(plain).not.toHaveProperty('heldBack');
    const checked = await validatedTranslator(inner, { verifier: rejecting(/^x = /) }).translate(
      context,
    );
    expect(checked.heldBack).toEqual([
      {
        code: 'VAL005',
        proposed: 'x = nums[target]',
        message: expect.stringContaining('A second opinion') as unknown,
        spans: [{ utteranceId: 'u1', start: 0, end: 7 }],
      },
    ]);
    expect(validatedTranslator(inner).name).toBe('inner');
  });
});

function reply(text: string, stop: ModelReply['stop_reason'] = 'end_turn'): ModelReply {
  return {
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stop,
    model: VERIFIER_MODEL,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function api(
  answer: ModelReply | Error,
): MessagesApi & { requests: MessageCreateParamsNonStreaming[] } {
  const requests: MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    create(params) {
      requests.push(params);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

const claims: Claim[] = [
  { node: 'n1', code: 'x = 1', words: 'set x to one', spans: [] },
  { node: 'n2', code: 'nums[0]', words: 'the list', spans: [] },
];

describe('the Claude verifier', () => {
  it('asks about every claim in one structured call to Haiku', async () => {
    const messages = api(
      reply(
        JSON.stringify({
          verdicts: [
            { claim: 1, supported: true },
            { claim: 2, supported: false },
          ],
        }),
      ),
    );
    const verifier = createClaudeVerifier({ messages });
    expect(verifier.name).toBe('claude:claude-haiku-4-5');
    expect(await verifier.verify(claims)).toEqual([true, false]);
    const [request] = messages.requests;
    expect(request).toMatchObject({
      model: 'claude-haiku-4-5',
      output_config: { format: { type: 'json_schema' } },
      messages: [
        {
          role: 'user',
          content:
            'Claim 1\nWords: "set x to one"\nCode: x = 1\n\nClaim 2\nWords: "the list"\nCode: nums[0]',
        },
      ],
    });
    expect(request?.output_config).not.toHaveProperty('effort');
    expect(await verifier.verify([])).toEqual([]);
    expect(messages.requests).toHaveLength(1);
  });

  it('lets claims stand when the call fails, is refused, or answers badly', async () => {
    for (const answer of [
      new Error('network'),
      reply('{}', 'refusal'),
      reply('not json'),
      reply('{"verdicts": "no"}'),
      reply(JSON.stringify({ verdicts: [{ claim: 9, supported: false }] })),
    ]) {
      expect(
        await createClaudeVerifier({ messages: api(answer), model: 'm' }).verify(claims),
      ).toEqual([true, true]);
    }
  });
});

function geminiReply(text: string, finishReason = FinishReason.STOP): GeminiReply {
  return {
    candidates: [
      {
        finishReason,
        content: { role: 'model', parts: [{ text: 'hmm', thought: true }, { text }] },
      },
    ],
  };
}

function gemini(
  answer: GeminiReply | Error,
): GeminiModelsApi & { requests: GenerateContentParameters[] } {
  const requests: GenerateContentParameters[] = [];
  return {
    requests,
    generateContent(params) {
      requests.push(params);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

describe('the Gemini verifier', () => {
  it('asks about every claim in one structured call to Flash-Lite', async () => {
    const models = gemini(
      geminiReply(
        JSON.stringify({
          verdicts: [
            { claim: 2, supported: false },
            { claim: 1, supported: true },
          ],
        }),
      ),
    );
    const verifier = createGeminiVerifier({ models });
    expect(verifier.name).toBe(`gemini:${GEMINI_VERIFIER_MODEL}`);
    expect(await verifier.verify(claims)).toEqual([true, false]);
    expect(models.requests[0]).toMatchObject({
      model: 'gemini-3.1-flash-lite',
      contents:
        'Claim 1\nWords: "set x to one"\nCode: x = 1\n\nClaim 2\nWords: "the list"\nCode: nums[0]',
      config: { responseMimeType: 'application/json', maxOutputTokens: 4000 },
    });
    expect(await verifier.verify([])).toEqual([]);
  });

  it('lets claims stand when the call fails, stops early, or answers badly', async () => {
    for (const answer of [
      new Error('network'),
      geminiReply('{}', FinishReason.SAFETY),
      { candidates: [] },
      geminiReply('nope'),
    ]) {
      expect(
        await createGeminiVerifier({ models: gemini(answer), model: 'm' }).verify(claims),
      ).toEqual([true, true]);
    }
  });
});

describe('the Ollama verifier', () => {
  it('asks a local model about every claim in one structured call', async () => {
    const requests: ChatRequest[] = [];
    const ollama = (content: string, done_reason = 'stop'): OllamaChatApi => ({
      chat(request) {
        requests.push(request);
        return Promise.resolve({
          message: { role: 'assistant', content },
          done_reason,
          prompt_eval_count: 1,
          eval_count: 1,
        });
      },
    });
    const verdicts = JSON.stringify({ verdicts: [{ claim: 1, supported: false }] });
    const verifier = createOllamaVerifier({ ollama: ollama(verdicts) });
    expect(verifier.name).toBe('ollama:qwen3:8b');
    expect(await verifier.verify(claims)).toEqual([false, true]);
    expect(requests[0]).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      format: { type: 'object' },
      options: { num_ctx: 8192 },
    });
    expect(requests[0]?.messages?.[1]?.content).toContain('Claim 2\nWords: "the list"');
    expect(
      await createOllamaVerifier({ ollama: ollama(verdicts, 'length'), model: 'm' }).verify(claims),
    ).toEqual([true, true]);
  });
});
