# @textscript/server

A stateless HTTP API that runs an LLM translator (Claude or Gemini), so
the API key stays on the server and never reaches the browser
([ADR-012](../../docs/adr/012-translator.md),
[ADR-014](../../docs/adr/014-llm-providers.md)).

```sh
ANTHROPIC_API_KEY=… pnpm --filter @textscript/server start
GEMINI_API_KEY=… pnpm --filter @textscript/server start
```

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Claude key, read by the Anthropic SDK |
| `GEMINI_API_KEY` | | Gemini key (`GOOGLE_API_KEY` also works) |
| `TEXTSCRIPT_PROVIDER` | the provider whose key is set, Anthropic first | `anthropic` or `gemini` |
| `TEXTSCRIPT_MODEL` | `claude-opus-5-5` or `gemini-3.5-flash` | Model |
| `TEXTSCRIPT_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` (Gemini's thinking level) |
| `PORT` | `8787` | Port to listen on |
| `TEXTSCRIPT_VERIFY` | off | `on` adds the validator's second opinion (Claude Haiku 4.5 or Gemini 3.1 Flash-Lite, one call per batch with claims) |

## Routes

- `GET /health` returns `{ "ok": true, "translator": "claude:claude-opus-5-5:medium" }`.
- `POST /translate` takes a translation context as JSON: `utterance`,
  `document`, `recent` and `problem`. It returns a translation: `batch`,
  `unparsedSpans`, `usage`, `trace` and `heldBack`. The document is
  validated against the IR schema before anything else. Every batch also
  goes through the provenance validator
  ([ADR-013](../../docs/adr/013-provenance-validator.md)). What it held
  back is in `heldBack`, and those parts of the batch are holes.

Errors are JSON `{ "error": "…" }`:

- **400:** bad JSON or a bad context. The response lists the issues.
- **502:** the model refused, ran out of tokens or gave no usable answer.
  The response adds a `code`.
- **500:** anything else. No internal detail is included.

Browsers use `createRemoteTranslator({ url })` from
`@textscript/translator`, which validates the answer the same way.

`createApp({ translator })` takes any `Translator`, so tests run it with a
fake.
