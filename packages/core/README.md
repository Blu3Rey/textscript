# @textscript/core

The deterministic engine: the IR, and (in later segments) edit operations,
session history and gap analysis. Environment-agnostic; Zod is the only
runtime dependency.

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

Design decisions are in [ADR-006](../../docs/adr/006-ir-schema-and-validation.md).
Expected outputs are in `test/golden/`: the exported JSON Schema and the
ROADMAP §3.6 worked example as canonical JSON.
