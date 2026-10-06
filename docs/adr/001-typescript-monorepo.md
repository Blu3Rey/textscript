# 001: TypeScript monorepo with source-exporting packages

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S0

## Context

TextScript has a deterministic engine (IR, edit operations, renderer,
analyzer) and several consumers: a developer CLI, an evaluation runner, a web
UI and a thin API server. The engine should run in the browser so rendering,
undo and gap analysis are instant; only the translator needs the network.
The IR types are shared by every part of the system and must never drift.

## Decision

- **One language:** TypeScript in strict mode for the engine, tools and UI.
- **One repository:** a pnpm workspace with packages in `packages/` and
  deployable apps in `apps/`.
- **No build step for internal packages.** Each package's `exports` points at
  `src/index.ts`. Vitest, Vite and tsx consume TypeScript directly; the CLI
  binary registers tsx at startup. A package gets a build only when it has to
  ship outside the repo.
- **Environment-agnostic by default.** A package's `src/` may not use Node.js
  or DOM APIs unless its `package.json` contains
  `"textscript": { "runtime": "node" }`. ESLint enforces this, and those
  packages don't get Node types, so the compiler enforces it too.
- **Toolchain:** Node 22, TypeScript pinned to `~6.0` (typescript-eslint does
  not yet support TypeScript 7), Vitest, ESLint with type-aware
  `strictTypeChecked` rules, Prettier.

## Consequences

- IR types are written once and shared by the engine, UI and translator.
- Changing a package is immediately visible to its dependents, with no
  rebuild or watch process.
- The engine's environment-agnostic rule must be respected. When a package
  genuinely needs Node, it is marked explicitly and reviewed.
- Revisit the TypeScript pin when typescript-eslint supports TypeScript 7.

## Alternatives considered

- **Python engine + TypeScript UI.** Python is the output language, but the
  IR would be defined twice and the engine couldn't run in the browser.
- **Built packages (`tsc -b` to `dist/`).** Adds watch processes and stale
  builds for no benefit while nothing is published.
- **Separate repositories.** Coordinated changes to the IR would span repos.
