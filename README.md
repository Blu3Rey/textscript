# TextScript

Turn a plain-English walkthrough of a coding approach into code that shows
exactly what was said, and nothing more. Gaps in the explanation stay
visible as holes instead of being filled in, so you can see what your
approach covers and go back to refine it.

Built for practicing the "walk me through your approach" part of coding
interviews.

## Status

Milestone M1, the deterministic engine, is done (segments S0–S5): the IR,
the Python renderer, edit operations with undo and the session log, the
analyzer that reports gaps, and a developer console that drives all of it by
hand. Milestone M2 has started: S6 added a corpus of 30 interview problems
with annotated walkthroughs ([corpus/](corpus/README.md)) and the runner
that scores a translator against it. Next is S7, the translator itself.
See [ROADMAP.md](ROADMAP.md) for the architecture and the full plan.

## Getting started

Requires Node 22, pnpm 10 (`corepack enable`) and Python 3.12+.

```sh
pnpm install
pnpm check            # typecheck, lint, format, tests, Python golden parse
pnpm textscript       # the developer console; type :help
```

[packages/cli/README.md](packages/cli/README.md) walks through a first
console session.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, conventions and how to
add a package, and [docs/adr/](docs/adr/README.md) for design decisions.
