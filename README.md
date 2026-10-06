# TextScript

Turn a plain-English walkthrough of a coding approach into code that shows
exactly what was said, and nothing more. Gaps in the explanation stay
visible as holes instead of being filled in, so you can see what your
approach covers and go back to refine it.

Built for practicing the "walk me through your approach" part of coding
interviews.

## Status

Segments S0–S4 are done: project foundations, the IR, the Python renderer,
edit operations with undo and the session log, and the analyzer that reports
gaps. Next is S5, the developer console that completes the deterministic
engine (milestone M1).
See [ROADMAP.md](ROADMAP.md) for the architecture and the full plan.

## Getting started

Requires Node 22, pnpm 10 (`corepack enable`) and Python 3.12+.

```sh
pnpm install
pnpm check            # typecheck, lint, format, tests, Python golden parse
pnpm textscript --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, conventions and how to
add a package, and [docs/adr/](docs/adr/README.md) for design decisions.
