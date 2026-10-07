// Few-shot examples for the LLM translator, generated from the corpus with
// `pnpm eval examples` (packages/eval/src/examples.ts). Don't edit
// examples.json by hand.

import data from './examples.json' with { type: 'json' };
import type { Example } from './prompt';

export const examples: readonly Example[] = data;
