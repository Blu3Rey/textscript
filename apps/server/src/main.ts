import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeTranslator, type Effort } from '@textscript/translator';
import { examples } from '@textscript/translator/examples';
import { createApp } from './app';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Starts the server. Credentials come from the environment, as the SDK resolves them. */
export function start(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof serve> {
  const effort = EFFORTS.find((e) => e === env['TEXTSCRIPT_EFFORT']);
  const translator = createClaudeTranslator({
    messages: new Anthropic().beta.messages,
    examples,
    ...(env['TEXTSCRIPT_MODEL'] ? { model: env['TEXTSCRIPT_MODEL'] } : {}),
    ...(effort ? { effort } : {}),
  });
  const port = Number(env['PORT'] ?? 8787);
  return serve({ fetch: createApp({ translator }).fetch, port }, (info) => {
    console.log(`TextScript server on http://localhost:${String(info.port)} (${translator.name})`);
  });
}
