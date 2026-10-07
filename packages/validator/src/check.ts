// Validation with an optional second opinion, and a translator wrapper that
// validates every batch before anyone applies it (docs/adr/013).

import type { HeldBackNotice, Translator } from '@textscript/translator';
import { validate, type HeldBack, type ValidationInput, type ValidationResult } from './validate';
import type { Verifier } from './verifier';

export interface CheckOptions {
  /** Asked about the nodes the lexicon can't judge. Off when absent. */
  verifier?: Verifier;
}

/** `validate`, then the verifier on what's left unjudged, then `validate` again with its verdicts. */
export async function checkBatch(
  input: ValidationInput,
  options: CheckOptions = {},
): Promise<ValidationResult> {
  const first = validate(input);
  if (options.verifier === undefined || first.claims.length === 0) return first;
  const verdicts = await options.verifier.verify(first.claims);
  const rejected = new Set(first.claims.filter((_, i) => verdicts[i] === false).map((c) => c.node));
  return rejected.size === 0 ? first : validate({ ...input, rejected });
}

export function heldBackNotice(held: HeldBack): HeldBackNotice {
  return { code: held.code, proposed: held.proposed, message: held.message, spans: held.spans };
}

/** A translator whose batches are validated; what was held back comes back as `heldBack`. */
export function validatedTranslator(
  translator: Translator,
  options: CheckOptions = {},
): Translator {
  return {
    name: translator.name,
    async translate(context) {
      const translation = await translator.translate(context);
      const result = await checkBatch(
        {
          document: context.document,
          batch: translation.batch,
          utterances: [...context.recent, context.utterance],
          inputs: context.problem.inputs,
        },
        options,
      );
      return {
        ...translation,
        batch: result.batch,
        ...(result.heldBack.length > 0 ? { heldBack: result.heldBack.map(heldBackNotice) } : {}),
      };
    },
  };
}
