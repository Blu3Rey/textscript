// The optional second opinion (ROADMAP.md S8): a cheaper model call that
// answers "do these words say this code?" for nodes the lexicon can't
// judge, such as an index or an assignment's shape. On by default in the
// eval, behind a flag at runtime until its cost and benefit are measured.

import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { MessagesApi } from '@textscript/translator';
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

export interface ClaudeVerifierOptions {
  messages: MessagesApi;
  model?: string;
  maxTokens?: number;
}

/**
 * A verifier that asks Claude about all of a batch's claims in one call.
 * If the call fails, is refused or is cut off, or leaves a claim out, the
 * claim stands: the second opinion only ever holds more back.
 */
export function createClaudeVerifier(options: ClaudeVerifierOptions): Verifier {
  const model = options.model ?? VERIFIER_MODEL;
  return {
    name: `claude:${model}`,
    async verify(claims) {
      if (claims.length === 0) return [];
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: options.maxTokens ?? 4000,
        output_config: { format: { type: 'json_schema', schema: VERDICTS_JSON_SCHEMA } },
        system: INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: claims
              .map(
                (claim, i) =>
                  `Claim ${String(i + 1)}\nWords: ${JSON.stringify(claim.words)}\nCode: ${claim.code}`,
              )
              .join('\n\n'),
          },
        ],
      };
      const verdicts = claims.map(() => true);
      let reply;
      try {
        reply = await options.messages.create(params);
      } catch {
        return verdicts;
      }
      if (reply.stop_reason !== 'end_turn') return verdicts;
      const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
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
