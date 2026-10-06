# Architecture decision records

Each ADR records one significant decision: the context, what was decided,
and what it costs. ADRs are never edited after they're accepted except to
change their status. To change a decision, write a new ADR that supersedes
the old one.

| # | Title | Status |
|---|---|---|
| [001](001-typescript-monorepo.md) | TypeScript monorepo with source-exporting packages | Accepted |
| [002](002-ir-first-architecture.md) | IR-first architecture | Accepted |
| [003](003-python-first-output-language.md) | Python as the first output language | Accepted |
| [004](004-faithfulness-contract.md) | Faithfulness contract and allowed-inference policy | Accepted |
| [005](005-event-sourced-history.md) | Event-sourced session history | Accepted |
| [006](006-ir-schema-and-validation.md) | IR schema definition and validation | Accepted |
| [007](007-python-rendering.md) | Rendering the IR as Python | Accepted |
| [008](008-edit-operations-and-sessions.md) | Edit operations, inverses and the session log | Accepted |

## Writing a new ADR

1. Copy [`000-template.md`](000-template.md) to `NNN-short-title.md` using the next number.
2. Fill it in. Keep it short: a page is plenty.
3. Add it to the table above in the same pull request as the change it describes.
