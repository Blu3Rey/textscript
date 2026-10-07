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
pnpm eval examples --out packages/translator/src/examples.json
```

Translators:

- `empty` does nothing.
- `oracle` replays gold.
- `rules` is the phrase-pattern baseline.
- `filler` replays gold and fills every hole with made-up code.
- `claude` and `gemini` are the LLM translators, one per provider.

Every batch goes through the provenance validator first
([ADR-013](../../docs/adr/013-provenance-validator.md)). `--validator`
picks how:

- `lexical` is the default.
- `verified` adds a second opinion from a cheap model. It is the
  default for `claude` and `gemini` and needs an API key. `--verifier
  claude` uses Claude Haiku 4.5; `--verifier gemini` uses Gemini 3.1
  Flash-Lite. The default is the translator's provider, else whichever
  key is set.
- `off` skips validation.

With a validator, the report adds rejection, downgrade and false-rejection
rates. A false rejection is gold-supported output that was held back; the
target is under 5%. Failing steps also list what was held back.

`oracle` measures false rejections. `filler` measures how many invented
fills get through: its gap preservation should stay at 100%.

The rules translator is gated in CI by `pnpm check:eval` against
`corpus/baselines/rules.json`. After an intended change, record a new
baseline with `--write-baseline` and check the diff.

### The LLM translators

`claude` needs `ANTHROPIC_API_KEY` in the environment. `gemini` needs
`GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Both share the prompt, examples,
retry and salvage ([ADR-014](../../docs/adr/014-llm-providers.md)). Both
leave out the four training problems their few-shot examples come from.
For Gemini, `--effort` sets the thinking level.

Claude translates four walkthroughs at once. Gemini translates one at a
time, since its free tier allows only a few requests a minute; on a paid
key, raise it with `--concurrency 4`. The Gemini client retries rate
limits and server errors with backoff.

When batches are rejected (an API error, a refusal, a batch `apply` didn't
accept), the run prints the most common reasons.

```sh
pnpm eval run --translator claude --split test               # the held-out set
pnpm eval run --translator gemini --split test
pnpm eval run --translator claude --effort low --model claude-opus-5-5 --out eval-report
pnpm eval run --translator gemini --model gemini-3.1-pro-preview --effort high
pnpm eval sweep --split test --efforts low,medium,high --out sweep
pnpm eval sweep --translator gemini --split test
```

The report adds latency (p50, p95) and cost, including cost per 20
utterances. `sweep` prints one row per effort. To gate the LLM translator,
record `corpus/baselines/claude.json` or `corpus/baselines/gemini.json`
with `--write-baseline`. The manual **Eval (LLM)** workflow then fails if
it regresses.

From code:

```ts
import { loadCorpus, readCorpusDir, runEval, markdownReport } from '@textscript/eval';

const corpus = loadCorpus(readCorpusDir('corpus'));
const result = await runEval(corpus, { translator: myTranslator, filter: { split: 'train' } });
console.log(result.metrics.faithfulness.value, markdownReport(result));
```
