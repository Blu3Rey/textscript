# @textscript/validator

Checks every edit against the words that caused it, and holds back what
those words don't say ([ADR-013](../../docs/adr/013-provenance-validator.md)).
It runs between the translator and `apply`. Browser-safe.

```ts
import { validate } from '@textscript/validator';

const result = validate({ document, batch, utterances, inputs: ['nums'] });
apply(document, result.batch); // unsupported parts are now holes
result.heldBack; // [{ code: 'VAL003', proposed: 'num > 0', message: 'The words "…" don\'t say `num > 0`', … }]
```

It runs three checks:

1. **Structural:** created nodes cite valid spans, or name an inference
   rule.
2. **Inference:** inferred nodes fit their rules.
3. **Lexical:** the cue lexicon in `src/lexicon.ts` checks names,
   literals, operators and statement keywords. Operators must be said near
   their operands, and operands must be said too.

What is held back depends on what it is:

- an expression becomes a hole of the matching kind;
- a statement is removed;
- a field change, rename or label is dropped.

| Code | Meaning |
|---|---|
| VAL001 | Cites no words and names no inference rule |
| VAL002 | Cites words outside this and earlier utterances |
| VAL003 | The cited words don't say it |
| VAL004 | Marked as inferred, but doesn't fit the rule |
| VAL005 | A second opinion found the words don't say it |

The lexicon can't judge some nodes, such as an index or an assignment's
shape. These come back as `claims`. `checkBatch(input, { verifier })` asks
a verifier about them and holds back what it rejects:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeVerifier, validatedTranslator } from '@textscript/validator';

const verifier = createClaudeVerifier({ messages: new Anthropic().beta.messages }); // Claude Haiku 4.5
const translator = validatedTranslator(claudeTranslator, { verifier });
// translation.heldBack lists what was held back, for the UI
```

Tune the lexicon against the eval, not by gut feel:

```sh
pnpm eval run --translator oracle    # false rejections: gold the validator blocks
pnpm eval run --translator filler    # gap preservation against a translator that fills every hole
```
