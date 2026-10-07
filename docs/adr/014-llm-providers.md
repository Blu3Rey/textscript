# 014: LLM providers behind one translator loop

- **Status:** Accepted
- **Date:** 2026-10-07
- **Roadmap segment:** S7/S8 follow-up

## Context

The S7 translator and the S8 verifier called the Claude API directly. The
user also wanted Gemini to work with only a Gemini API key. ADR-012's
design doesn't depend on the provider: the model writes edit commands as
JSON in a flat schema, and our own code compiles and validates them. Only
three things are provider-specific:

- sending messages;
- reading the reply and its stop reason;
- appending a reply to the history when retrying.

## Decision

`llm.ts` holds what every LLM translator shares:

- reading the answer;
- the one retry with the error;
- salvage;
- the trace;
- `TranslatorError`;
- pricing.

A provider is an `LlmBackend`. Its `start(context)` returns a
`Conversation` with two methods:

- `send(feedback?)` makes the first call, or appends the last reply as it
  came plus the feedback. It returns the answer's text, or throws a
  `TranslatorError`.
- `usage()` reports the tokens used so far.

`createLlmTranslator(backend)` builds the translator.
`createClaudeTranslator` and `createGeminiTranslator` are thin wrappers
around it, so both behave the same.

The Gemini adapter uses the official `@google/genai` SDK
(`ai.models.generateContent`):

- **Prompt.** The system prompt goes in `systemInstruction`. The problem
  and the turn are the first user message.
- **Answer format.** The same answer schema goes in
  `responseJsonSchema`, with `responseMimeType: application/json`.
- **Effort.** It maps to `thinkingConfig.thinkingLevel`: `low` → `LOW`,
  `medium` → `MEDIUM`, `high`, `xhigh` and `max` → `HIGH`.
- **Errors.** A `promptFeedback.blockReason` or a safety-type
  `finishReason` (`SAFETY`, `RECITATION`, `BLOCKLIST`,
  `PROHIBITED_CONTENT`, `SPII`) is a refusal. `MAX_TOKENS` is a cut-off.
- **Retries.** A retry appends the candidate's content unchanged, so
  thought signatures go back to the model.
- **Thinking.** Thought parts are skipped when reading the answer, and
  thinking tokens are billed as output.
- **Default model.** `gemini-3.5-flash`.
- **Caching.** Gemini has no explicit cache markers here. The stable
  prefix (system instruction, then the problem) lets its implicit caching
  apply. Prices in `GEMINI_PRICES` treat cached input as plain input, so
  Gemini costs are an upper bound.

The validator's verifier is split the same way. `verifyWith` holds the
prompt, the verdict schema and the rule that a failed call lets claims
stand. `createGeminiVerifier` uses `gemini-3.1-flash-lite`.

Where providers are chosen:

- **Eval.** `--translator gemini` adds the second provider, and `sweep`
  takes `--translator`. `--verifier claude|gemini` picks who gives the
  second opinion. The default is the translator's provider, else whichever
  key is set.
- **Server.** `apps/server` reads `TEXTSCRIPT_PROVIDER`. Without it, it
  uses whichever key is set, Anthropic first.
- **Keys.** Gemini reads `GEMINI_API_KEY`, or `GOOGLE_API_KEY`.

## Consequences

- With only a Gemini key, the whole system runs: the server, the eval
  with `--translator gemini`, and the verified validator.
- Quality, latency and cost per provider are measured the same way
  (`pnpm eval run`, `pnpm eval sweep`), so the choice between them is
  data, not taste. Neither has been run here: there is no key in this
  environment.
- The prompt is shared. A prompt change has to be checked on every
  provider in use, since one prompt can suit two models differently.
- Each new provider is one adapter of about 100 lines plus a test with a
  fake client.

## Alternatives considered

- **An OpenAI-compatible endpoint for every provider.** It would lose
  provider features this design relies on: Claude's cache markers,
  server-side refusal fallback and effort, and Gemini's thinking levels
  and thought signatures.
- **A third-party multi-provider SDK.** It adds a dependency between us
  and both APIs, and lags behind new parameters. Each official SDK is
  only used through a narrow interface (`MessagesApi`,
  `GeminiModelsApi`) that tests fake.
