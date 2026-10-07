// Evaluation reports: a Markdown file to attach to a pull request, and a
// self-contained HTML page with the same content. Both list the metrics,
// breakdowns by style, split and problem, and every step that didn't fully
// match, with the reasons and a diff of the code.

import { VALIDATION_CODES } from '@textscript/validator';
import { isExact, type Metrics, type Ratio } from '../metrics';
import { breakdown, type RunResult, type StepResult } from '../run';
import { diffLines } from './diff';
import { explain } from './explain';

/** ROADMAP.md §6.1 targets for milestone M2. */
export const M2_TARGETS = {
  faithfulness: 0.99,
  gapPreservation: 1,
  coverage: 0.85,
  placement: 0.9,
  clarificationPrecision: 0.8,
  clarificationRecall: 0.8,
  stability: 1,
} as const;

type RatioKey = keyof typeof M2_TARGETS;

const METRIC_ROWS: { key: RatioKey | 'exact'; name: string; meaning: string }[] = [
  { key: 'faithfulness', name: 'Faithfulness', meaning: 'produced nodes a gold answer supports' },
  { key: 'gapPreservation', name: 'Gap preservation', meaning: 'gaps in gold left open' },
  { key: 'coverage', name: 'Coverage', meaning: 'gold nodes produced' },
  { key: 'placement', name: 'Placement', meaning: 'refinements made to the right nodes' },
  {
    key: 'clarificationPrecision',
    name: 'Clarification precision',
    meaning: 'questions that were needed',
  },
  { key: 'clarificationRecall', name: 'Clarification recall', meaning: 'needed questions asked' },
  { key: 'stability', name: 'Stability', meaning: 'untouched lines kept byte-identical' },
  { key: 'exact', name: 'Exact steps', meaning: 'steps matching a gold answer completely' },
];

export function percent(r: Ratio): string {
  return r.value === null ? '–' : `${(r.value * 100).toFixed(1)}%`;
}

function fraction(r: Ratio): string {
  return r.value === null
    ? 'nothing to measure'
    : `${String(r.numerator)}/${String(r.denominator)}`;
}

function ms(value: number | null): string {
  return value === null ? '–' : `${value.toFixed(value < 10 ? 2 : 0)} ms`;
}

/** ✓ or ✗ against the M2 target, or nothing when there's no target or no value. */
function verdict(key: RatioKey | 'exact', r: Ratio): string {
  if (key === 'exact' || r.value === null) return '';
  return r.value >= M2_TARGETS[key] ? '✓' : '✗';
}

function target(key: RatioKey | 'exact'): string {
  if (key === 'exact') return '';
  const value = M2_TARGETS[key];
  return value === 1 ? '100%' : `≥ ${String(value * 100)}%`;
}

export function failingSteps(result: RunResult): StepResult[] {
  return result.steps.filter((step) => !isExact(step));
}

export function gapPreservationOn(result: RunResult, style: string): Ratio | undefined {
  return breakdown(result.steps, (s) => s.style).get(style)?.gapPreservation;
}

// Markdown ------------------------------------------------------------------------

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ];
}

function breakdownRows(groups: Map<string, Metrics>): string[][] {
  return [...groups.entries()].map(([name, m]) => [
    name,
    String(m.walkthroughs),
    String(m.steps),
    percent(m.faithfulness),
    percent(m.gapPreservation),
    percent(m.coverage),
    percent(m.placement),
    percent(m.exact),
  ]);
}

const BREAKDOWN_HEADER = [
  '',
  'Walkthroughs',
  'Steps',
  'Faithful',
  'Gaps kept',
  'Coverage',
  'Placement',
  'Exact',
];

const FALSE_REJECTION_TARGET = 0.05;

/** The validator's rates, if one ran (docs/adr/013). */
function validationRows(m: RunResult['metrics']): string[][] {
  const v = m.validation;
  if (v === null) return [];
  return [
    [
      'Rejection rate: batches with something held back',
      percent(v.rejection),
      fraction(v.rejection),
      '',
      '',
    ],
    [
      'Downgrade rate: checked nodes and changes held back',
      percent(v.downgrade),
      fraction(v.downgrade),
      '',
      '',
    ],
    [
      'False rejections: gold-supported units held back',
      percent(v.falseRejection),
      fraction(v.falseRejection),
      '< 5%',
      v.falseRejection.value === null
        ? ''
        : v.falseRejection.value < FALSE_REJECTION_TARGET
          ? '✓'
          : '✗',
    ],
  ];
}

const CODE_HEADER = [
  'Code',
  'Meaning',
  'Held back',
  'Of those, gold supports',
  'Gold units held back',
];

/**
 * What was held back, by validation code: whether false rejections come
 * from the lexicon (VAL003) or the second opinion (VAL005) decides what to
 * tune.
 */
function codeRows(result: RunResult): string[][] {
  const codes = new Map<string, { held: number; supported: number; units: number }>();
  for (const step of result.steps) {
    for (const held of step.validation?.heldBack ?? []) {
      const entry = codes.get(held.code) ?? { held: 0, supported: 0, units: 0 };
      entry.held++;
      if (held.falseRejection) entry.supported++;
      entry.units += held.falselyHeld;
      codes.set(held.code, entry);
    }
  }
  return [...codes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, e]) => [
      code,
      Object.entries(VALIDATION_CODES).find(([key]) => key === code)?.[1].summary ?? '',
      String(e.held),
      String(e.supported),
      String(e.units),
    ]);
}

function validationSection(result: RunResult): string[] {
  const rows = validationRows(result.metrics);
  if (rows.length === 0) return [];
  const codes = codeRows(result);
  return [
    '## Validator',
    '',
    ...table(['Metric', 'Value', 'Count', 'S8 target', ''], rows),
    '',
    ...(codes.length === 0 ? [] : [...table(CODE_HEADER, codes), '']),
  ];
}

export function markdownReport(
  result: RunResult,
  title = `Evaluation: ${result.translator}`,
): string {
  const m = result.metrics;
  const failing = failingSteps(result);
  const lines: string[] = [
    `# ${title}`,
    '',
    `${String(m.walkthroughs)} walkthroughs, ${String(m.steps)} steps. Each step starts from the gold state before it.`,
    '',
    '## Metrics',
    '',
    ...table(
      ['Metric', 'Value', 'Count', 'M2 target', ''],
      METRIC_ROWS.map((row) => {
        const r = m[row.key];
        return [
          `${row.name}: ${row.meaning}`,
          percent(r),
          fraction(r),
          target(row.key),
          verdict(row.key, r),
        ];
      }),
    ),
    '',
    `Rejected batches: ${String(m.rejected)}. Latency p50 ${ms(m.latencyMs.p50)}, p95 ${ms(m.latencyMs.p95)}.` +
      (m.usage.costUsd === null
        ? ''
        : ` Cost $${m.usage.costUsd.toFixed(4)} ($${(m.usage.costPer20 ?? 0).toFixed(4)} per 20 utterances).`),
    '',
    ...validationSection(result),
    '## By style',
    '',
    ...table(BREAKDOWN_HEADER, breakdownRows(breakdown(result.steps, (s) => s.style))),
    '',
    '## By split',
    '',
    ...table(BREAKDOWN_HEADER, breakdownRows(breakdown(result.steps, (s) => s.split))),
    '',
    '## By problem',
    '',
    ...table(BREAKDOWN_HEADER, breakdownRows(breakdown(result.steps, (s) => s.problem))),
    '',
    `## Steps that don't match (${String(failing.length)})`,
    '',
  ];
  if (failing.length === 0) lines.push('None.', '');
  for (const step of failing) {
    lines.push(
      `### ${step.walkthrough}, step ${String(step.index + 1)}`,
      '',
      `> ${step.utterance}`,
      '',
      ...explain(step).map((reason) => `- ${reason.text}`),
      '',
      'Expected (`-`) and produced (`+`) code:',
      '',
      '```diff',
      ...diffLines(step.code.expected, step.code.produced).map((line) =>
        `${line.type === 'same' ? ' ' : line.type === 'removed' ? '-' : '+'} ${line.text}`.trimEnd(),
      ),
      '```',
      '',
    );
  }
  return lines.join('\n');
}

// HTML ----------------------------------------------------------------------------

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function htmlTable(header: string[], rows: string[][]): string {
  return `<table><thead><tr>${header.map((h) => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const STYLE = `
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --add: #e6f4ea; --del: #fde8e8; --code: #f5f5f7; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f7; --muted: #a1a1a6; --line: #3a3a3c; --add: #1e3a26; --del: #44201f; --code: #2c2c2e; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: left; }
details { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
summary { cursor: pointer; font-weight: 600; }
blockquote { color: var(--muted); margin: 8px 0; }
pre { background: var(--code); padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
.added { background: var(--add); display: block; } .removed { background: var(--del); display: block; }
.muted { color: var(--muted); }
`;

export function htmlReport(result: RunResult, title = `Evaluation: ${result.translator}`): string {
  const m = result.metrics;
  const failing = failingSteps(result);
  const metricRows = METRIC_ROWS.map((row) => {
    const r = m[row.key];
    return [row.name, row.meaning, percent(r), fraction(r), target(row.key), verdict(row.key, r)];
  });
  const sections = [
    ['By style', breakdown(result.steps, (s) => s.style)],
    ['By split', breakdown(result.steps, (s) => s.split)],
    ['By problem', breakdown(result.steps, (s) => s.problem)],
  ] as const;
  const failures = failing.map((step) => {
    const diff = diffLines(step.code.expected, step.code.produced)
      .map((line) => {
        const marker = line.type === 'same' ? ' ' : line.type === 'removed' ? '-' : '+';
        const text = escape(`${marker} ${line.text}`);
        return line.type === 'same' ? `${text}\n` : `<span class="${line.type}">${text}</span>`;
      })
      .join('');
    return `<details><summary>${escape(step.walkthrough)}, step ${String(step.index + 1)}</summary>
<blockquote>${escape(step.utterance)}</blockquote>
<ul>${explain(step)
      .map((reason) => `<li>${escape(reason.text)}</li>`)
      .join('')}</ul>
<p class="muted">Expected (−) and produced (+) code:</p><pre>${diff}</pre></details>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body>
<h1>${escape(title)}</h1>
<p class="muted">${String(m.walkthroughs)} walkthroughs, ${String(m.steps)} steps. Each step starts from the gold state before it.
Rejected batches: ${String(m.rejected)}. Latency p50 ${ms(m.latencyMs.p50)}, p95 ${ms(m.latencyMs.p95)}.</p>
<h2>Metrics</h2>
${htmlTable(['Metric', 'Meaning', 'Value', 'Count', 'M2 target', ''], metricRows)}
${m.validation === null ? '' : `<h2>Validator</h2>\n${htmlTable(['Metric', 'Value', 'Count', 'S8 target', ''], validationRows(m))}\n${codeRows(result).length === 0 ? '' : htmlTable(CODE_HEADER, codeRows(result))}`}
${sections.map(([name, groups]) => `<h2>${name}</h2>\n${htmlTable(BREAKDOWN_HEADER, breakdownRows(groups))}`).join('\n')}
<h2>Steps that don't match (${String(failing.length)})</h2>
${failures.length === 0 ? '<p>None.</p>' : failures.join('\n')}
</body></html>
`;
}
