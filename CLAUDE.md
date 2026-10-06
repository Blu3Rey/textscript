# CLAUDE.md

Guidance for AI coding assistants working in this repository.

## What this is

TextScript turns a plain-English walkthrough of a coding approach into code
that shows only what was said. Gaps stay visible as holes. Read
`ROADMAP.md` §1–3 before making design changes, and `docs/adr/` for settled
decisions.

## Commands

- `pnpm check`: run before finishing any change; it's exactly what CI runs.
- `pnpm test`, `pnpm --filter @textscript/<pkg> test`, `pnpm test -u` (rewrite goldens).
- `pnpm new-package <name> [--node]` to add a package.

## Rules

- **Never make the engine "helpful".** Code that infers values, conditions,
  returns or data structures the user didn't state violates ADR-004. Leave a
  hole instead. The allowed-inference list is ROADMAP.md §3.5.
- `packages/core` and `packages/render-python` must stay environment-agnostic:
  no Node built-ins, no `process`/`Buffer`, no DOM globals in `src/`. Lint
  enforces it; don't disable the rule.
- Internal packages export TypeScript source (`src/index.ts`); don't add
  build steps or `dist/` outputs.
- Renderer changes must keep the property tests in
  `packages/render-python/test/properties.test.ts` passing: export parses,
  minimal and full parentheses give the same Python AST, and a one-node change
  only touches that node's lines (ADR-007).
- Golden files in `test/golden/` are compared byte for byte. Update them with
  `pnpm test -u` only for intended output changes, and check the diff.
- Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
  Narrow types instead of using `!` or `as`.
- TypeScript is pinned to `~6.0` because typescript-eslint doesn't support 7
  yet. Don't bump it without checking that.
- **Changing the IR** means editing `ir/types.ts` and `ir/schema.ts` together
  (typecheck fails if they disagree), updating `CHILD_FIELDS` for new child
  fields, and the builder. If valid documents change, bump
  `IR_SCHEMA_VERSION`, add a migration with tests, and review the
  `ir-document.schema.json` golden diff. See ADR-006.
- **The only way to change a document is `apply(document, batch)`.** A new
  operation needs a schema in `ops/schema.ts`, a case in the `Executor`,
  unit tests for success and every failure, and a generator case in
  `test/op-arbitraries.ts` so the inverse property covers it (ADR-008).
- Significant decisions get an ADR in `docs/adr/`.
- Match the surrounding code's style and comment density. Prettier formats
  code; Markdown is hand-formatted.
