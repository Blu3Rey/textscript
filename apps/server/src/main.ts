import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import {
  createClaudeTranslator,
  createGeminiTranslator,
  GEMINI_HTTP_OPTIONS,
  type Effort,
  type Translator,
} from '@textscript/translator';
import { examples } from '@textscript/translator/examples';
import {
  createClaudeVerifier,
  createGeminiVerifier,
  validatedTranslator,
  type Verifier,
} from '@textscript/validator';
import { createApp } from './app';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type Provider = 'anthropic' | 'gemini';

/**
 * Which model provider to use: `TEXTSCRIPT_PROVIDER` if set, else Anthropic
 * when its key is set, else Gemini when its key is.
 */
export function providerFrom(env: NodeJS.ProcessEnv): Provider {
  const asked = env['TEXTSCRIPT_PROVIDER'];
  if (asked === 'anthropic' || asked === 'gemini') return asked;
  if (asked !== undefined && asked !== '')
    throw new Error(`TEXTSCRIPT_PROVIDER must be anthropic or gemini, not "${asked}"`);
  if (env['ANTHROPIC_API_KEY']) return 'anthropic';
  if (env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY']) return 'gemini';
  throw new Error('Set ANTHROPIC_API_KEY or GEMINI_API_KEY');
}

/** The validated translator the server runs, for the provider the environment picks. */
export function translatorFrom(env: NodeJS.ProcessEnv): Translator {
  const effort = EFFORTS.find((e) => e === env['TEXTSCRIPT_EFFORT']);
  const model = env['TEXTSCRIPT_MODEL'];
  const settings = { examples, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  const verify = env['TEXTSCRIPT_VERIFY'] === 'on';
  let translator: Translator;
  let verifier: Verifier | undefined;
  if (providerFrom(env) === 'anthropic') {
    const messages = new Anthropic().beta.messages;
    translator = createClaudeTranslator({ messages, ...settings });
    if (verify) verifier = createClaudeVerifier({ messages });
  } else {
    const models = new GoogleGenAI({
      apiKey: env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'] ?? '',
      httpOptions: GEMINI_HTTP_OPTIONS,
    }).models;
    translator = createGeminiTranslator({ models, ...settings });
    if (verify) verifier = createGeminiVerifier({ models });
  }
  return validatedTranslator(translator, verifier ? { verifier } : {});
}

/**
 * Starts the server. Credentials come from the environment. Every batch is
 * validated before it's returned; the second-opinion verifier runs only
 * with `TEXTSCRIPT_VERIFY=on`.
 */
export function start(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof serve> {
  const translator = translatorFrom(env);
  const port = Number(env['PORT'] ?? 8787);
  return serve({ fetch: createApp({ translator }).fetch, port }, (info) => {
    console.log(`TextScript server on http://localhost:${String(info.port)} (${translator.name})`);
  });
}
