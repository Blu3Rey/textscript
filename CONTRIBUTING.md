# Contributing to TextScript

## Principles

Every change is judged against these. They come from
[ROADMAP.md §1](ROADMAP.md#1-product-principles); the reasoning is in
[ADR-004](docs/adr/004-faithfulness-contract.md).

1. **Faithful over helpful.** Never add logic the user didn't describe. When
   in doubt, leave a hole and say what's missing.
2. **Gaps are a feature.** Holes are first-class data, not error states.
3. **Every line has a source.** Generated code without provenance is a bug.
4. **Edits, not regeneration.** Code the user didn't touch stays byte-identical.
5. **Deterministic core, AI at the edge.** Only the translator uses a model.
6. **Nothing said is lost.** Text that can't be encoded becomes a note.

## Setup

Requirements: Node 22 (see `.nvmrc`), pnpm 10 (`corepack enable` installs the
pinned version), Python 3.12+ (only for `pnpm check:python`).

```sh
pnpm install
pnpm check
```

## Commands

| Command | What it does |
|---|---|
| `pnpm check` | Everything CI runs: typecheck, lint, format check, tests with coverage, Python golden parse, eval gate |
| `pnpm typecheck` | `tsc` for root files and every package |
| `pnpm lint` | ESLint with type-aware rules; warnings fail |
| `pnpm format` / `pnpm format:check` | Prettier (Markdown is excluded) |
| `pnpm test` / `pnpm test:watch` | Vitest for the whole workspace |
| `pnpm test:coverage` | Tests with coverage; fails under 80% |
| `pnpm --filter @textscript/core test` | Tests for one package |
| `pnpm check:python` | Parses every golden `.py` file with Python's `ast` |
| `pnpm new-package <name>` | Scaffolds a package (`--node` to allow Node APIs) |
| `pnpm textscript --help` | Runs the developer CLI |
| `pnpm eval check` | Checks the walkthrough corpus (see [corpus/README.md](corpus/README.md)) |
| `pnpm check:eval` | The eval gate: the corpus is valid and the rules translator doesn't regress against `corpus/baselines/rules.json` |
| `pnpm eval run --translator claude` | Scores the LLM translator (needs `ANTHROPIC_API_KEY`; `--translator gemini` needs `GEMINI_API_KEY`; see [packages/eval/README.md](packages/eval/README.md)) |

## Repository layout

```
packages/          libraries; each exports TypeScript source from src/index.ts
  core/            IR, edit operations, history, analysis (only dependency: Zod)
  render-python/   IR → Python source + source map
  commands/        the edit-command language: console commands → edit operations
  cli/             developer console
  translator/      the Translator interface, the rules baseline and the Claude translator
  validator/       checks edits against the words that caused them; holds back the rest
  eval/            corpus loader, evaluation runner, metrics, reports
apps/              deployable apps; each exports TypeScript source from src/index.ts
  server/          HTTP API that calls Claude, so the key stays server-side
corpus/            interview problems, walkthroughs, gold annotations, eval baselines
docs/adr/          architecture decision records
scripts/           repo tooling
```

## Rules the tooling enforces

- **Engine packages are environment-agnostic.** `src/` may not import Node
  built-ins or use Node or DOM globals. A package that truly needs Node is
  marked with `"textscript": { "runtime": "node" }` in its `package.json`
  ([ADR-001](docs/adr/001-typescript-monorepo.md)). Tests may use Node.
- **Tests may use Node; browser-safe source may not.** Such a package has
  two tsconfigs: `tsconfig.json` compiles `src/` without Node types, and
  `test/tsconfig.json` adds them for the tests. `pnpm new-package` sets this up.
- **Strict TypeScript.** `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are on. Prefer narrowing over `!` and `as`.
- **Coverage stays at or above 80%** for `packages/*/src` and `apps/*/src`.

## Tests

- Tests live in `packages/<name>/test/` and end in `.test.ts`.
- **Golden files** hold expected renderer output in `test/golden/`. Compare
  with `await expect(text).toMatchFileSnapshot('./golden/name.py')`. After an
  intended output change, run `pnpm test -u` and review the golden diff like
  code. CI never writes goldens, and every golden `.py` must parse as Python.
- **Scenario scripts** in `packages/cli/scenarios/` drive the whole engine
  through the developer console. Each must pass its `expect` lines, and its
  transcript is a golden in `packages/cli/test/golden/`. See
  [packages/cli/README.md](packages/cli/README.md#scenario-scripts).
- Each bug fix comes with a test that fails without the fix.

## Adding a package

```sh
pnpm new-package render-js --description "Renders the IR to JavaScript."
pnpm install
pnpm check
```

Add `--node` only if the package's source needs Node.js APIs.

## Decisions

Record significant decisions as ADRs in [`docs/adr/`](docs/adr/README.md):
anything that changes the IR contract, the faithfulness rules, a public
package API, or the toolchain. To reverse a decision, write a new ADR that
supersedes it.

## Workflow

- Work happens in roadmap segments (S0, S1, …). Keep each pull request to one
  segment or a coherent part of one.
- `pnpm check` must pass before you open a pull request; CI runs the same steps.
- Commit messages: imperative subject line under 72 characters, then a body
  explaining why.
