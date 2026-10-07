import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '@textscript/core';
import { formatCode } from '@textscript/cli';
import { PYTHON_BUILTINS } from '@textscript/render-python';
import { emptyTranslator, type Translator } from '@textscript/translator';
import { agreement } from './agreement';
import { STYLES, SPLITS, type CorpusIssue, type Split, type Style } from './corpus/corpus';
import { compileGold, parseGold, type CompiledGold } from './corpus/gold';
import { loadCorpus, readCorpusDir, type Corpus } from './corpus/load';
import { baselineOf, checkGate, type Baseline } from './gate';
import { percent, htmlReport, markdownReport } from './report/report';
import { oracleTranslator, runEval, type RunFilter } from './run';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const HELP = `Usage: textscript-eval <command> [options]

Commands:
  check                        Check the corpus: formats, gold that compiles,
                               two walkthroughs per problem. Prints counts.
  run                          Play walkthroughs through a translator and score
                               every step against gold.
  gold <walkthrough>           Show a walkthrough's gold: each utterance, the
                               expected code and its gaps. With --file <gold>,
                               show that annotation instead.
  agree [file.gold ...]        Compare second annotations with the corpus gold
                               (default: every file in <corpus>/agreement/).

Options:
  --corpus <dir>               Corpus directory (default: corpus)
  --translator <name>          empty or oracle (default: empty)
  --split <train|test>         Only this split
  --problem <id,...>           Only these problems
  --style <style,...>          Only these styles (${STYLES.join(', ')})
  --walkthrough <id,...>       Only these walkthroughs
  --out <dir>                  Write report.md, report.html and results.json
  --baseline <file>            Fail if faithfulness or gap preservation drops below it
  --write-baseline <file>      Record this run's scores as the baseline
  -h, --help                   Show this help
`;

class UsageError extends Error {}

interface Args {
  command: string;
  positional: string[];
  options: Map<string, string>;
}

const VALUE_OPTIONS = new Set([
  'corpus',
  'translator',
  'split',
  'problem',
  'style',
  'walkthrough',
  'out',
  'baseline',
  'write-baseline',
  'file',
]);

function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '-h' || arg === '--help') return { command: 'help', positional, options };
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option '${arg}'`);
      const value = rest[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      options.set(name, value);
    } else {
      positional.push(arg);
    }
  }
  return {
    command: command === '-h' || command === '--help' ? 'help' : command,
    positional,
    options,
  };
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatIssue(issue: CorpusIssue): string {
  return `${issue.file}${issue.line === undefined ? '' : `:${String(issue.line)}`}: ${issue.message}`;
}

function filterFrom(options: Map<string, string>): RunFilter {
  const split = options.get('split');
  if (split !== undefined && !SPLITS.some((s) => s === split))
    throw new UsageError(`unknown split '${split}'`);
  const styles = list(options.get('style'));
  const knownStyles: Style[] = [];
  for (const style of styles ?? []) {
    const known = STYLES.find((s) => s === style);
    if (known === undefined) throw new UsageError(`unknown style '${style}'`);
    knownStyles.push(known);
  }
  const problems = list(options.get('problem'));
  const walkthroughs = list(options.get('walkthrough'));
  const splitValue: Split | undefined = SPLITS.find((s) => s === split);
  return {
    ...(splitValue ? { split: splitValue } : {}),
    ...(problems ? { problems } : {}),
    ...(styles ? { styles: knownStyles } : {}),
    ...(walkthroughs ? { walkthroughs } : {}),
  };
}

function translatorFrom(name: string): Translator | ((gold: CompiledGold) => Translator) {
  switch (name) {
    case 'empty':
      return emptyTranslator;
    case 'oracle':
      return oracleTranslator;
    default:
      throw new UsageError(`unknown translator '${name}'; S6 has empty and oracle`);
  }
}

function count<T>(items: Iterable<T>, key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ${String(n)}`)
    .join(', ');
}

function check(corpus: Corpus, io: Io): number {
  for (const issue of corpus.issues) io.stderr(`${formatIssue(issue)}\n`);
  const walkthroughs = [...corpus.walkthroughs.values()];
  const steps = [...corpus.gold.values()].flatMap((g) => g.steps);
  io.stdout(
    [
      `Problems: ${String(corpus.problems.size)} (${count(corpus.problems.values(), (p) => p.split)})`,
      `Walkthroughs: ${String(walkthroughs.length)} (${count(walkthroughs, (w) => w.style)})`,
      `Annotated: ${String(corpus.gold.size)} walkthroughs, ${String(steps.length)} utterances, ${String(
        steps.filter((s) => s.alternatives.length > 1).length,
      )} with more than one acceptable answer`,
      corpus.issues.length === 0 ? 'No issues.' : `${String(corpus.issues.length)} issues.`,
      '',
    ].join('\n'),
  );
  return corpus.issues.length === 0 ? 0 : 1;
}

async function run(corpus: Corpus, options: Map<string, string>, io: Io): Promise<number> {
  if (corpus.issues.length > 0) {
    for (const issue of corpus.issues) io.stderr(`${formatIssue(issue)}\n`);
    io.stderr('textscript-eval: the corpus has issues; fix them first (see `check`)\n');
    return 2;
  }
  const result = await runEval(corpus, {
    translator: translatorFrom(options.get('translator') ?? 'empty'),
    filter: filterFrom(options),
  });
  const report = markdownReport(result);
  const out = options.get('out');
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'report.md'), report);
    writeFileSync(join(out, 'report.html'), htmlReport(result));
    writeFileSync(join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  // The metrics table and breakdowns, without the failure details.
  io.stdout(`${report.split('\n## Steps that')[0]?.trimEnd() ?? ''}\n`);
  const failing = result.steps.length - result.metrics.exact.numerator;
  io.stdout(
    `\n${String(failing)} steps don't match${out === undefined ? '; use --out for details' : `; details in ${join(out, 'report.md')}`}.\n`,
  );

  const written = options.get('write-baseline');
  if (written !== undefined) {
    writeFileSync(written, `${JSON.stringify(baselineOf(result), null, 2)}\n`);
    io.stdout(`Baseline written to ${written}.\n`);
  }
  const baselinePath = options.get('baseline');
  if (baselinePath !== undefined) {
    const parsed: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (!isBaseline(parsed)) {
      io.stderr(`textscript-eval: ${baselinePath} is not a baseline\n`);
      return 2;
    }
    const gate = checkGate(result, parsed);
    io.stdout(`\nGate against ${baselinePath}:\n${gate.lines.join('\n')}\n`);
    return gate.passed ? 0 : 1;
  }
  return 0;
}

function isBaseline(value: unknown): value is Baseline {
  if (typeof value !== 'object' || value === null) return false;
  const numeric = (key: string) => {
    const field: unknown = Reflect.get(value, key);
    return field === null || typeof field === 'number';
  };
  return (
    typeof Reflect.get(value, 'translator') === 'string' &&
    ['faithfulness', 'gapPreservation', 'gapPreservationIncomplete', 'coverage'].every(numeric)
  );
}

function showGold(
  corpus: Corpus,
  id: string | undefined,
  file: string | undefined,
  io: Io,
): number {
  let gold = id === undefined ? undefined : (corpus.gold.get(id) ?? corpus.drafts.get(id));
  let issues = corpus.issues.filter((issue) => issue.file === `gold/${id ?? ''}.gold`);
  const walkthrough = id === undefined ? undefined : corpus.walkthroughs.get(id);
  if (file !== undefined && walkthrough !== undefined) {
    // Another annotation of the same walkthrough, such as a second annotator's.
    issues = [];
    const inputs = corpus.problems.get(walkthrough.problem)?.inputs ?? [];
    gold = compileGold(
      walkthrough,
      inputs,
      parseGold(walkthrough.id, readFileSync(file, 'utf8'), issues),
      issues,
    );
  }
  if (gold === undefined) {
    io.stderr(`textscript-eval: no gold for '${id ?? ''}'\n`);
    return 2;
  }
  const inputs = corpus.problems.get(gold.walkthrough.problem)?.inputs ?? [];
  for (const step of gold.steps) {
    const canonical = step.alternatives[0];
    if (canonical === undefined) continue;
    const words = step.utterance.tokens.map((t, i) => `${String(i)}:${t.text}`).join(' ');
    const gaps = analyze(canonical.after.program, {
      builtins: PYTHON_BUILTINS,
      inputs,
      utterances: [...step.recent, step.utterance],
    }).diagnostics.filter((d) => d.severity !== 'info');
    io.stdout(
      [
        `Step ${String(step.index + 1)} (${step.utterance.id}): ${words}`,
        `  ${String(step.alternatives.length)} acceptable answer${step.alternatives.length === 1 ? '' : 's'}; ops: ${
          canonical.batch.ops.map((op) => op.op).join(', ') || 'none'
        }`,
        ...formatCode(canonical.after.program).map((line) => `  ${line}`),
        `  gaps: ${gaps.map((d) => d.code).join(' ') || 'none'}`,
        '',
      ].join('\n'),
    );
  }
  for (const issue of issues) io.stderr(`${formatIssue(issue)}\n`);
  if (!gold.complete) {
    io.stderr(`Stopped after step ${String(gold.steps.length)}.\n`);
    return 1;
  }
  return 0;
}

function agree(corpus: Corpus, root: string, files: string[], io: Io): number {
  const dir = join(root, 'agreement');
  const paths =
    files.length > 0
      ? files
      : (() => {
          try {
            return readdirSync(dir)
              .filter((name) => name.endsWith('.gold'))
              .sort()
              .map((name) => join(dir, name));
          } catch {
            return [];
          }
        })();
  if (paths.length === 0) {
    io.stderr('textscript-eval: no second annotations to compare\n');
    return 2;
  }
  let failed = false;
  const rows: string[] = [];
  let exact = 0;
  let same = 0;
  let steps = 0;
  let f1 = 0;
  let holesBoth = 0;
  let holesEither = 0;
  for (const path of paths) {
    const id = (path.split('/').at(-1) ?? '').replace(/\.gold$/, '');
    const mine = corpus.gold.get(id);
    const walkthrough = corpus.walkthroughs.get(id);
    if (mine === undefined || walkthrough === undefined) {
      io.stderr(`${path}: no compiled corpus gold for '${id}'\n`);
      failed = true;
      continue;
    }
    const issues: CorpusIssue[] = [];
    const inputs = corpus.problems.get(walkthrough.problem)?.inputs ?? [];
    const theirs = compileGold(
      walkthrough,
      inputs,
      parseGold(id, readFileSync(path, 'utf8'), issues),
      issues,
    );
    if (!theirs.complete) {
      for (const issue of issues) io.stderr(`${path}: ${formatIssue(issue)}\n`);
      failed = true;
      continue;
    }
    const result = agreement(mine, theirs);
    exact += result.exact.numerator;
    same += result.sameAnswers.numerator;
    steps += result.steps.length;
    f1 += result.steps.reduce((total, s) => total + s.f1, 0);
    holesBoth += result.holes.numerator;
    holesEither += result.holes.denominator;
    rows.push(
      `${id}: ${String(result.exact.numerator)}/${String(result.steps.length)} steps identical, ${String(
        result.sameAnswers.numerator,
      )} with the same acceptable answers, node F1 ${result.f1.toFixed(2)}, holes in common ${percent(result.holes)}`,
    );
  }
  io.stdout(`${rows.join('\n')}\n`);
  if (steps > 0) {
    io.stdout(
      `\nOverall: ${String(exact)}/${String(steps)} steps identical (${((exact / steps) * 100).toFixed(1)}%), ${String(
        same,
      )} with the same acceptable answers (${((same / steps) * 100).toFixed(1)}%), mean node F1 ${(
        f1 / steps
      ).toFixed(
        3,
      )}, holes in common ${holesEither === 0 ? '–' : `${((holesBoth / holesEither) * 100).toFixed(1)}%`}\n`,
    );
  }
  return failed ? 1 : 0;
}

/** Runs the eval CLI and returns the process exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
    if (args.command === 'help') {
      io.stdout(HELP);
      return 0;
    }
    const root = args.options.get('corpus') ?? 'corpus';
    const corpus = loadCorpus(readCorpusDir(root));
    switch (args.command) {
      case 'check':
        return check(corpus, io);
      case 'run':
        return await run(corpus, args.options, io);
      case 'gold':
        return showGold(corpus, args.positional[0], args.options.get('file'), io);
      case 'agree':
        return agree(corpus, root, args.positional, io);
      default:
        throw new UsageError(`unknown command '${args.command}'`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`textscript-eval: ${error.message}\n\n${HELP}`);
    return 2;
  }
}
