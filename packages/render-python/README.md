# @textscript/render-python

Renders the TextScript IR to Python, with tokens and a source map linking
every node to its text. Environment-agnostic. Design: [ADR-007](../../docs/adr/007-python-rendering.md).

```ts
import { render, nodeAtOffset, textOf } from '@textscript/render-python';

const result = render(program); // export mode: always parses as Python
const view = render(program, { mode: 'ui' }); // holes as ⟨reason⟩ chips

result.text; // the source
result.lines; // tokens per line, each tagged with the node that produced it
result.sourceMap.nodes.get(nodeId); // { start, end } with line, column, offset
nodeAtOffset(result, offset); // innermost node under a cursor
textOf(result, nodeId); // the text one node renders to
```

| Module | What it does |
|---|---|
| `render.ts` | Statements, expressions, precedence, holes, notes |
| `writer.ts` | Token accumulation, indentation, node ranges, TODO comments |
| `python.ts` | Keywords, builtins, string/number/name/comment formatting |
| `output.ts` | Language-neutral result types and lookups |

## Tests

- `test/cases.ts`: 45 golden cases, rendered to `test/golden/<name>.py`
  (export) and `<name>.ui.txt` (UI). Run `pnpm test -u` after an intended
  change and review the diff.
- `test/properties.test.ts`: on random programs, export parses with Python,
  minimal and full parentheses give the same Python AST, the source map
  covers and nests every node, and a one-node change only touches that
  node's lines. The Python checks need `python3` (CI always has it).
