import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { createUtterance, emptySession, type EditOp } from '@textscript/core';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_JSON_SCHEMA,
  createClaudeTranslator,
  encodeAnswer,
  packProblem,
  packTurn,
  salvageAnswer,
  splitCommands,
  systemPrompt,
  TranslatorError,
  withUnparsedNotes,
  type Answer,
  type MessagesApi,
  type ModelReply,
  type TranslationContext,
} from '../src/index';
import { examples } from '../src/examples';

const problem = {
  id: 'dup',
  title: 'Contains Duplicate',
  statement: 'Find a repeat in nums.',
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

function reply(answer: Answer | string, stop: ModelReply['stop_reason'] = 'end_turn'): ModelReply {
  return {
    content: [
      {
        type: 'text',
        text: typeof answer === 'string' ? answer : JSON.stringify(answer),
        citations: null,
      },
    ],
    stop_reason: stop,
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
  };
}

/** A fake `messages` API that answers from a list and records requests. */
function fake(
  ...replies: ModelReply[]
): MessagesApi & { requests: MessageCreateParamsNonStreaming[] } {
  const requests: MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    create(params) {
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

describe('the Claude translator', () => {
  it('sends a cached prompt, the problem and the turn, with structured outputs, effort and fallbacks', async () => {
    const api = fake(reply(loop));
    await createClaudeTranslator({ messages: api, examples, effort: 'low' }).translate(context());
    const [request] = api.requests;
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMA } },
      system: [
        { type: 'text', text: systemPrompt(examples), cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: packProblem(problem), cache_control: { type: 'ephemeral' } },
            { type: 'text', text: packTurn(context()) },
          ],
        },
      ],
    });
    expect(request).not.toHaveProperty('thinking');
  });

  it('turns the answer into a batch with the cited words as provenance', async () => {
    const translation = await createClaudeTranslator({ messages: fake(reply(loop)) }).translate(
      context(),
    );
    const [op] = translation.batch.ops;
    expect(op?.op).toBe('add_stmt');
    expect(op?.op === 'add_stmt' ? op.stmt.provenance : undefined).toEqual([
      { utteranceId: 'u1', start: 0, end: 6 },
    ]);
    expect(translation.trace).toEqual({ attempts: 1, salvaged: false, errors: [] });
    expect(translation.usage).toEqual({
      inputTokens: 1100,
      outputTokens: 50,
      costUsd: (100 * 4 + 50 * 20 + 1000 * 0.2) / 1e6,
    });
  });

  it('sends the error back once, appending the reply as it came', async () => {
    const bad: Answer = { commands: [{ command: 'fill h1: x', words: [] }], unparsed: [] };
    const api = fake(reply(bad), reply(loop));
    const translation = await createClaudeTranslator({ messages: api }).translate(context());
    expect(translation.trace?.attempts).toBe(2);
    expect(translation.trace?.errors[0]).toMatch(
      /^Command 1 \("fill h1: x"\) failed: bad-ref: There is no hole h1/,
    );
    const second = api.requests[1];
    expect(second?.messages.slice(1)).toEqual([
      { role: 'assistant', content: reply(bad).content },
      {
        role: 'user',
        content: `${translation.trace?.errors[0] ?? ''}\nReturn the whole answer again, corrected.`,
      },
    ]);
  });

  it('salvages what compiles after two failures, keeping the rest as notes', async () => {
    const mixed: Answer = {
      commands: [
        { command: 'add root: seen = set()', words: [0, 2] },
        { command: 'remove n99', words: [3, 5] },
      ],
      unparsed: [],
    };
    const translation = await createClaudeTranslator({
      messages: fake(reply(mixed), reply(mixed)),
    }).translate(context('A set called seen, then drop it.'));
    expect(translation.trace).toMatchObject({ attempts: 2, salvaged: true });
    expect(translation.batch.ops.map((op) => op.op)).toEqual(['add_stmt']);
    expect(translation.unparsedSpans).toEqual([{ utteranceId: 'u1', start: 3, end: 5 }]);
  });

  it('retries an answer that is not valid JSON, and gives up if neither is', async () => {
    const recovered = await createClaudeTranslator({
      messages: fake(reply('{oops'), reply(loop)),
    }).translate(context());
    expect(recovered.trace?.errors).toEqual(['The answer was not valid JSON.']);
    await expect(
      createClaudeTranslator({ messages: fake(reply('{"commands": 3}'), reply('nope')) }).translate(
        context(),
      ),
    ).rejects.toMatchObject({ code: 'no-answer' });
  });

  it('reports refusals and truncated answers', async () => {
    await expect(
      createClaudeTranslator({ messages: fake(reply(loop, 'refusal')) }).translate(context()),
    ).rejects.toBeInstanceOf(TranslatorError);
    await expect(
      createClaudeTranslator({ messages: fake(reply(loop, 'max_tokens')) }).translate(context()),
    ).rejects.toMatchObject({ code: 'max-tokens' });
  });

  it('names itself after model and effort, and leaves cost out for unknown models', async () => {
    const translator = createClaudeTranslator({
      messages: fake(reply(loop)),
      model: 'claude-x',
      effort: 'high',
    });
    expect(translator.name).toBe('claude:claude-x:high');
    expect((await translator.translate(context())).usage).toEqual({
      inputTokens: 1100,
      outputTokens: 50,
    });
  });

  it('accepts the real SDK client', () => {
    const typed = (client: Anthropic): MessagesApi => client.beta.messages;
    expect(typed).toBeTypeOf('function');
  });
});

describe('answers', () => {
  it('report unparsed words, which withUnparsedNotes keeps as notes', () => {
    const said = context('Loop through the numbers, it is linear.');
    const result = encodeAnswer(said, {
      commands: [],
      unparsed: [
        { start: 5, end: 8 },
        { start: 9, end: 2 },
      ],
    });
    if (!result.ok) throw new Error('encode failed');
    expect(result.translation.batch.ops).toEqual([]);
    expect(withUnparsedNotes(said, result.translation).batch.ops).toEqual([
      {
        op: 'add_note',
        node: 'n1',
        text: 'Not encoded: "it is linear"',
        tag: 'general',
        provenance: [{ utteranceId: 'u1', start: 5, end: 8 }],
      } satisfies EditOp,
    ]);
  });

  it('use the whole utterance when the cited words are out of range', () => {
    const result = encodeAnswer(context(), {
      commands: [{ command: 'add root: x = 1', words: [3, 99] }],
      unparsed: [],
    });
    const [op] = result.ok ? result.translation.batch.ops : [];
    expect(op?.op === 'add_stmt' ? op.provenance : undefined).toEqual([
      { utteranceId: 'u1', start: 0, end: 7 },
    ]);
  });

  it('split commands written into one string', () => {
    expect(splitCommands('add root: prev = 0\nadd root: curr = 0')).toEqual([
      'add root: prev = 0',
      'add root: curr = 0',
    ]);
    // Body lines, and Python that starts with a command word, stay put.
    expect(splitCommands('add root:\n    for x in xs:\n        ...\nadd = 1')).toEqual([
      'add root:\n    for x in xs:\n        ...\nadd = 1',
    ]);
    const result = encodeAnswer(context(), {
      commands: [{ command: 'add root: x = 1\nremove n99', words: [] }],
      unparsed: [],
    });
    expect(result).toMatchObject({ ok: false, index: 1, command: 'remove n99' });
  });

  it('salvage keeps commands that depend on earlier kept ones', () => {
    const translation = salvageAnswer(context(), {
      commands: [
        { command: 'add root: for num in nums:\n    ...', words: [] },
        { command: 'frobnicate', words: [] },
        { command: 'fill h1: print(num)', words: [] },
      ],
      unparsed: [],
    });
    expect(translation.batch.ops.map((op) => op.op)).toEqual(['add_stmt', 'fill_hole']);
    expect(translation.unparsedSpans).toEqual([{ utteranceId: 'u1', start: 0, end: 7 }]);
  });
});
