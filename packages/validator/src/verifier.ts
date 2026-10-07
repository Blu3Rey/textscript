// The optional second opinion (ROADMAP.md S8): a cheap model call (Claude
// Haiku or Gemini Flash-Lite) that answers "do these words say this code?"
// for nodes the lexicon can't judge, such as an index or an assignment's
// shape. On by default in the eval, behind a flag at runtime until its cost
// and benefit are measured.

import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { FinishReason } from '@google/genai';
import type { GeminiModelsApi, MessagesApi } from '@textscript/translator';
import { z } from 'zod';
import type { Claim } from './validate';

export interface Verifier {
  readonly name: string;
  /** One verdict per claim: whether the words say the code. */
  verify(claims: readonly Claim[]): Promise<boolean[]>;
}

export const VERIFIER_MODEL = 'claude-haiku-4-5';

const INSTRUCTIONS = `You check a code translator's work. A candidate described a coding approach out loud, and the translator turned their words into Python. For each claim you get the words the code cites and one piece of the code.

Answer supported: true when the words state that code, directly or as a plain paraphrase ("bigger than" for >, "the length of nums" for len(nums), "nums at i" for nums[i]). Earlier code may be referred to by "it" or "that".

Answer supported: false when the code adds something the words don't state: a value, a condition, a name, an index, a bound or an operation the speaker left open. Leaving it out would leave a visible gap, and that is the right outcome when the words don't say it.

Judge each claim on its own words. Return one verdict for every claim.`;

const VERDICTS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: { type: 'integer' }, supported: { type: 'boolean' } },
        required: ['claim', 'supported'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

const VerdictsSchema = z.object({
  verdicts: z.array(z.object({ claim: z.number().int(), supported: z.boolean() })),
});

/**
 * Asks a model about claims through `ask`, which returns the answer's text
 * or undefined if there's no usable answer. If the call fails, or the
 * answer is unusable or leaves a claim out, the claim stands: the second
 * opinion only ever holds more back.
 */
function verifyWith(name: string, ask: (prompt: string) => Promise<string | undefined>): Verifier {
  return {
    name,
    async verify(claims) {
      if (claims.length === 0) return [];
      const prompt = claims
        .map(
          (claim, i) =>
            `Claim ${String(i + 1)}\nWords: ${JSON.stringify(claim.words)}\nCode: ${claim.code}`,
        )
        .join('\n\n');
      const verdicts = claims.map(() => true);
      let text: string | undefined;
      try {
        text = await ask(prompt);
      } catch {
        return verdicts;
      }
      if (text === undefined) return verdicts;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return verdicts;
      }
      const parsed = VerdictsSchema.safeParse(json);
      if (!parsed.success) return verdicts;
      for (const { claim, supported } of parsed.data.verdicts) {
        if (claim >= 1 && claim <= claims.length && !supported) verdicts[claim - 1] = false;
      }
      return verdicts;
    },
  };
}

export interface ClaudeVerifierOptions {
  messages: MessagesApi;
  model?: string;
  maxTokens?: number;
}

/** A verifier that asks Claude about all of a batch's claims in one call. */
export function createClaudeVerifier(options: ClaudeVerifierOptions): Verifier {
  const model = options.model ?? VERIFIER_MODEL;
  return verifyWith(`claude:${model}`, async (prompt) => {
    const params: MessageCreateParamsNonStreaming = {
      model,
      max_tokens: options.maxTokens ?? 4000,
      output_config: { format: { type: 'json_schema', schema: VERDICTS_JSON_SCHEMA } },
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: prompt }],
    };
    const reply = await options.messages.create(params);
    if (reply.stop_reason !== 'end_turn') return undefined;
    return reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  });
}

export const GEMINI_VERIFIER_MODEL = 'gemini-3.1-flash-lite';

export interface GeminiVerifierOptions {
  models: GeminiModelsApi;
  model?: string;
  maxTokens?: number;
}

/** A verifier that asks Gemini about all of a batch's claims in one call. */
export function createGeminiVerifier(options: GeminiVerifierOptions): Verifier {
  const model = options.model ?? GEMINI_VERIFIER_MODEL;
  return verifyWith(`gemini:${model}`, async (prompt) => {
    const reply = await options.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: INSTRUCTIONS,
        responseMimeType: 'application/json',
        responseJsonSchema: VERDICTS_JSON_SCHEMA,
        maxOutputTokens: options.maxTokens ?? 4000,
      },
    });
    const candidate = reply.candidates?.[0];
    if (candidate?.finishReason !== FinishReason.STOP) return undefined;
    return (candidate.content?.parts ?? [])
      .flatMap((part) => (part.thought === true || part.text === undefined ? [] : [part.text]))
      .join('');
  });
}
