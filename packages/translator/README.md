# @textscript/translator

Turns one utterance into an edit batch. Its input is the utterance, the
solution so far, recent utterances and the problem; its output is a batch
(ROADMAP.md §2.1). It is the only part of TextScript that may use a
language model. Everything it returns still goes through `apply`. The
design is in [ADR-012](../../docs/adr/012-translator.md), and the
provider adapters are in [ADR-014](../../docs/adr/014-llm-providers.md).
Browser-safe.

| Translator | What it is |
|---|---|
| `emptyTranslator` | Translates nothing. |
| `rulesTranslator` | About 30 phrase patterns, no network. The eval floor and the offline fallback. It leaves holes rather than guess. |
| `createClaudeTranslator({ messages, model?, effort?, examples? })` | Claude writes edit commands (the console's language, see `@textscript/commands`) in a structured JSON answer. |
| `createGeminiTranslator({ models, model?, effort?, examples? })` | The same with Gemini (default `gemini-3.5-flash`). |
| `createLlmTranslator(backend)` | The loop both share, over any `LlmBackend`; a new provider only implements `start(context).send(feedback?)`. |
| `createRemoteTranslator({ url })` | For the browser: calls `apps/server`, which runs an LLM translator. |

The LLM translators work like this:

- **Caching.** The system prompt (instructions and few-shot examples) and
  the problem come first and stay the same for a session; only the turn
  varies (`packProblem`, `packTurn`). Claude caches them explicitly.
  Gemini's implicit caching can reuse the same prefix.
- **Effort.** It's set explicitly (default `medium`). For Gemini it is the
  thinking level: `xhigh` and `max` map to `HIGH`.
- **Stop reasons.** These raise a `TranslatorError`:
  - Claude: `refusal` and `max_tokens`. Claude's refusals first fall back
    server-side.
  - Gemini: a blocked prompt, a safety stop, and `MAX_TOKENS`.
- **Retry and salvage.** A failed answer goes back once with the error.
  If the second one fails too, the commands that work are kept.
- **Usage.** Tokens and cost are reported per translation. Gemini's
  thinking tokens count as output.

```ts
import { GoogleGenAI } from '@google/genai';
import { createGeminiTranslator } from '@textscript/translator';
import { examples } from '@textscript/translator/examples';

const translator = createGeminiTranslator({
  models: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).models,
  examples,
});
```

Words a translator can't encode come back as `unparsedSpans`. Apps call
`withUnparsedNotes(context, translation)` to keep them visible as notes.
Before applying a batch, run it through `@textscript/validator`
(`validatedTranslator`). That holds back what the words don't say and
lists it in `translation.heldBack`.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeTranslator, withUnparsedNotes } from '@textscript/translator';
import { examples } from '@textscript/translator/examples';

const translator = createClaudeTranslator({ messages: new Anthropic().beta.messages, examples });
const translation = withUnparsedNotes(context, await translator.translate(context));
```

`src/examples.json` is generated from training-split gold by `pnpm eval
examples --out packages/translator/src/examples.json`; a test fails if it
goes stale.
