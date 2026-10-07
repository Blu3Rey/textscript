// The API proxy (ROADMAP.md §2.2): one endpoint that runs the translator
// server-side, so the API key never reaches the browser. It's stateless
// and keeps no transcripts: nothing from a request is stored or logged.

import { Hono } from 'hono';
import { parseTranslationContext, TranslatorError, type Translator } from '@textscript/translator';

export interface AppOptions {
  translator: Translator;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, translator: options.translator.name }));

  app.post('/translate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'The body must be JSON' }, 400);
    }
    const context = parseTranslationContext(body);
    if (!context.ok) return c.json({ error: `Bad context: ${context.issues.join('; ')}` }, 400);
    try {
      return c.json(await options.translator.translate(context.value));
    } catch (error) {
      if (error instanceof TranslatorError)
        return c.json({ error: error.message, code: error.code }, 502);
      throw error;
    }
  });

  app.onError((_error, c) => c.json({ error: 'The translator failed' }, 500));

  return app;
}
