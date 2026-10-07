# @textscript/eval

Loads the walkthrough corpus (`corpus/`), plays every walkthrough through a
translator, and scores each step against gold. Uses Node.js APIs. How
scoring works is in [ADR-011](../../docs/adr/011-corpus-and-evaluation.md);
how to write corpus entries is in [corpus/README.md](../../corpus/README.md)
and [corpus/ANNOTATION.md](../../corpus/ANNOTATION.md).

```sh
pnpm eval check                              # the corpus is consistent
pnpm eval gold two-sum.terse                 # gold, step by step, with node IDs
pnpm eval run --translator oracle            # replays gold: 100% everywhere
pnpm eval run --out eval-report              # report.md, report.html, results.json
pnpm eval run --split test --style incomplete
pnpm eval run --write-baseline baseline.json
pnpm eval run --baseline baseline.json       # exit 1 if faithfulness or gap preservation drop
pnpm eval agree                              # second annotations vs gold
```

S6 has two translators: `empty` (does nothing) and `oracle` (replays gold).
S7 adds the baseline and LLM translators.

From code:

```ts
import { loadCorpus, readCorpusDir, runEval, markdownReport } from '@textscript/eval';

const corpus = loadCorpus(readCorpusDir('corpus'));
const result = await runEval(corpus, { translator: myTranslator, filter: { split: 'train' } });
console.log(result.metrics.faithfulness.value, markdownReport(result));
```
