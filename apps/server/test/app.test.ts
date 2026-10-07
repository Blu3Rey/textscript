import { createUtterance, emptySession } from '@textscript/core';
import { createRemoteTranslator, TranslatorError, type Translator } from '@textscript/translator';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const context = {
  utterance: createUtterance('u1', 'Loop through the numbers.'),
  document: emptySession().document,
  recent: [],
  problem: { id: 'p', title: 'P', statement: 'S', inputs: ['nums'] },
};

const echo: Translator = {
  name: 'echo',
  translate: (c) =>
    Promise.resolve({
      batch: {
        utteranceId: c.utterance.id,
        ops: [{ op: 'ask_clarification', question: c.utterance.text, candidates: [] }],
      },
      unparsedSpans: [],
    }),
};

function post(app: ReturnType<typeof createApp>, body: string) {
  return app.request('/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('the server', () => {
  it('reports its health and translator', async () => {
    const response = await createApp({ translator: echo }).request('/health');
    expect(await response.json()).toEqual({ ok: true, translator: 'echo' });
  });

  it('translates a valid context', async () => {
    const response = await post(createApp({ translator: echo }), JSON.stringify(context));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ batch: { utteranceId: 'u1' } });
  });

  it('rejects bodies that are not a translation context', async () => {
    const app = createApp({ translator: echo });
    const notJson = await post(app, 'nope');
    expect(notJson.status).toBe(400);
    const bad = await post(app, JSON.stringify({ ...context, document: { schemaVersion: 1 } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: expect.stringContaining('document:') as string,
    });
    const missing = await post(app, JSON.stringify({ utterance: context.utterance }));
    expect(missing.status).toBe(400);
  });

  it('maps translator errors to 502 and anything else to 500', async () => {
    const refusing: Translator = {
      name: 'r',
      translate: () => Promise.reject(new TranslatorError('refusal', 'declined')),
    };
    const refused = await post(createApp({ translator: refusing }), JSON.stringify(context));
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'declined', code: 'refusal' });
    const broken: Translator = {
      name: 'b',
      translate: () => Promise.reject(new Error('secret detail')),
    };
    const failed = await post(createApp({ translator: broken }), JSON.stringify(context));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('secret');
  });

  it('works with the remote translator', async () => {
    const app = createApp({ translator: echo });
    const remote = createRemoteTranslator({
      url: '/translate',
      fetch: (url, init) => Promise.resolve(app.request(url, init)),
    });
    const translation = await remote.translate(context);
    expect(translation.batch.ops).toEqual([
      { op: 'ask_clarification', question: 'Loop through the numbers.', candidates: [] },
    ]);
    const refusing = createApp({
      translator: {
        name: 'r',
        translate: () => Promise.reject(new TranslatorError('refusal', 'declined')),
      },
    });
    const failing = createRemoteTranslator({
      url: '/translate',
      fetch: (url, init) => Promise.resolve(refusing.request(url, init)),
    });
    await expect(failing.translate(context)).rejects.toMatchObject({
      status: 502,
      message: 'declined',
    });
  });
});
