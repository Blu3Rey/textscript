# @textscript/core

The deterministic engine: the IR, edit operations, the session log and gap
analysis. Environment-agnostic; Zod is the only runtime dependency.

## The IR (segment S1)

| Module | What it provides |
|---|---|
| `ir/types.ts` | The node interfaces: the readable spec of what a solution is |
| `ir/schema.ts` | Zod schemas for every node kind, and `irDocumentJsonSchema()` |
| `ir/invariants.ts` | `checkInvariants`: rules that span nodes (IDs, provenance, holes) |
| `ir/serialize.ts` | `serialize`, `deserialize`, `parseDocument` (canonical JSON) |
| `ir/migrations.ts` | `migrate` and the registry for future schema versions |
| `ir/build.ts` | `createBuilder`: a constructor for every node kind |
| `ir/ids.ts` | `createIdAllocator`: increasing IDs that are never reused |
| `ir/tree.ts` | `walk`, `children`, `findNode`, `pathTo`, `parentOf`, `updateNode`, … |
| `ir/symbols.ts` | `buildSymbolTable`: scopes, definitions and uses, Python rules |

```ts
import { createBuilder, serialize } from '@textscript/core';

const b = createBuilder();
const said = (start: number, end: number) => ({ provenance: [{ utteranceId: 'u1', start, end }] });

// "Loop through the numbers." Nothing was said about the body.
const doc = b.document(
  b.program([
    b.forEach(
      {
        target: b.name('num', { inferred: 'INF-LOOPVAR' }),
        iterable: b.name('nums', said(3, 4)),
        body: b.block([b.blockHole('body not described')]),
      },
      said(0, 4),
    ),
  ]),
);

serialize(doc); // throws if the document breaks a schema rule or invariant
```

## Edits and sessions (segment S3)

| Module | What it provides |
|---|---|
| `ops/types.ts` | The edit operations and batches |
| `ops/apply.ts` | `apply(document, batch)`: atomic, returns the inverse batch |
| `ops/schema.ts` | Zod schemas for batches, and `editBatchJsonSchema()` for S7 |
| `ops/transaction.ts` | The four primitives and their inverses |
| `ops/temp-ids.ts` | Temporary IDs (`t1`) for nodes a batch creates |
| `ir/diff.ts` | `diffPrograms`: added, removed, changed and moved nodes |
| `session/session.ts` | Events, `applyEvent`, undo/redo/revert, `replay`, log persistence |
| `session/tokenize.ts` | Utterance tokens, which provenance spans count |

```ts
import { applyEvent, createUtterance, emptySession } from '@textscript/core';

const state = emptySession();
const utterance = createUtterance('u1', 'Loop through the numbers.');
const result = applyEvent(state, {
  type: 'edit',
  utterance,
  batch: {
    utteranceId: 'u1',
    ops: [
      {
        op: 'add_stmt',
        parent: state.document.program.id,
        position: { at: 'end' },
        stmt: {
          kind: 'ForEach',
          id: 't1',
          target: { kind: 'Name', id: 't2', name: 'num', provenance: [], inferred: 'INF-LOOPVAR' },
          iterable: { kind: 'Name', id: 't3', name: 'nums', provenance: [{ utteranceId: 'u1', start: 3, end: 4 }] },
          body: {
            kind: 'Block',
            id: 't4',
            stmts: [{ kind: 'BlockHole', id: 't5', reason: 'body not described', provenance: [] }],
            provenance: [],
          },
          provenance: [{ utteranceId: 'u1', start: 0, end: 4 }],
        },
      },
    ],
  },
});
// result.state.document now holds the loop; applyEvent(result.state, { type: 'undo' }) takes it back.
```

## Gap analysis (segment S4)

| Module | What it provides |
|---|---|
| `analyze/analyze.ts` | `analyze(program, options)`: diagnostics and the coverage summary |
| `analyze/diagnostics.ts` | `DIAGNOSTICS`: every code, its name, severity and summary |
| `analyze/inference-rules.ts` | `INFERENCE_RULES` and `fitsInferenceRule` |
| `analyze/flow.ts` | `completesNormally`, `fallsThrough` |

```ts
import { analyze } from '@textscript/core';
import { PYTHON_BUILTINS } from '@textscript/render-python';

const { diagnostics, coverage } = analyze(state.document.program, {
  builtins: PYTHON_BUILTINS, // len(), range() … aren't gaps
  inputs: ['nums'], // the problem's inputs
  utterances: state.utterances, // fills in each diagnostic's quotes
});
```

Design decisions are in [ADR-006](../../docs/adr/006-ir-schema-and-validation.md)
(the IR), [ADR-008](../../docs/adr/008-edit-operations-and-sessions.md)
(edits and sessions) and [ADR-009](../../docs/adr/009-gap-analysis.md) (gap
analysis).
Expected outputs are in `test/golden/`: the exported JSON Schema and the
ROADMAP §3.6 worked example as canonical JSON.
