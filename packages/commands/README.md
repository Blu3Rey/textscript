# @textscript/commands

The text language for edits, compiled to edit operations. A command is
`add`, `fill`, `set`, `replace`, `wrap`, `ask` or one of the others, often
with a Python snippet that uses `?` for holes. The developer console, the
corpus gold and the LLM translator all use it
([ADR-010](../../docs/adr/010-developer-console.md),
[ADR-012](../../docs/adr/012-translator.md)). Browser-safe.

```ts
import { compileCommands } from '@textscript/commands';

const result = compileCommands(document, [{ text: 'add root: seen = set()' }], {
  utteranceId: 'u1',
  provenance: [{ utteranceId: 'u1', start: 0, end: 4 }],
});
if (result.ok) document = result.document; // result.batch is what to apply or log
else console.log(`command ${result.index + 1}: ${result.code}: ${result.message}`);
```

`compileCommands` applies commands one by one, so a later command can
refer to nodes and holes an earlier one created. It also exports:

- `parseStatements`, `parseExpression` and `parseCondition`: the snippet
  parser;
- `resolveRef`: references such as `n3`, `h2`, `@label` and `n5.orelse`;
- `formatCode`, `formatDiagnostics` and `formatCoverage`: the text views
  the console and the translator's context share.
