import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeTranslator, type Effort } from '@textscript/translator';
import { examples } from '@textscript/translator/examples';
import { createClaudeVerifier, validatedTranslator } from '@textscript/validator';
import { createApp } from './app';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Starts the server. Credentials come from the environment, as the SDK
 * resolves them. Every batch is validated before it's returned; the
 * second-opinion verifier runs only with `TEXTSCRIPT_VERIFY=on`.
 */
export function start(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof serve> {
  const effort = EFFORTS.find((e) => e === env['TEXTSCRIPT_EFFORT']);
  const messages = new Anthropic().beta.messages;
  const translator = validatedTranslator(
    createClaudeTranslator({
      messages,
      examples,
      ...(env['TEXTSCRIPT_MODEL'] ? { model: env['TEXTSCRIPT_MODEL'] } : {}),
      ...(effort ? { effort } : {}),
    }),
    env['TEXTSCRIPT_VERIFY'] === 'on' ? { verifier: createClaudeVerifier({ messages }) } : {},
  );
  const port = Number(env['PORT'] ?? 8787);
  return serve({ fetch: createApp({ translator }).fetch, port }, (info) => {
    console.log(`TextScript server on http://localhost:${String(info.port)} (${translator.name})`);
  });
}
