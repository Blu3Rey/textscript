// The walkthrough corpus (corpus/README.md): problem statements, walkthroughs
// made of utterances, and gold annotations of what each utterance should do.
//
// Problems and walkthroughs are text files with a small header:
//
//   ---
//   key: value
//   ---
//   body
//
// Parsing never throws; every problem is reported as an issue with its file
// and line, so `eval check` can list them all at once.

export const STYLES = ['terse', 'rambling', 'corrective', 'incomplete'] as const;
export type Style = (typeof STYLES)[number];

export const SPLITS = ['train', 'test'] as const;
export type Split = (typeof SPLITS)[number];

export interface Problem {
  id: string;
  title: string;
  /** Names the problem gives as inputs. */
  inputs: string[];
  /** `test` problems are scored but never used to tune prompts. */
  split: Split;
  tags: string[];
  statement: string;
}

export interface Walkthrough {
  /** `<problem>.<style>`, with `-2`, `-3` for a second walkthrough in the same style. */
  id: string;
  problem: string;
  style: Style;
  /** One utterance per line, in the order they're said. */
  utterances: string[];
}

export interface CorpusIssue {
  file: string;
  line?: number;
  message: string;
}

/** The corpus as text, keyed by file name without its extension. */
export interface CorpusFiles {
  problems: ReadonlyMap<string, string>;
  walkthroughs: ReadonlyMap<string, string>;
  gold: ReadonlyMap<string, string>;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WALKTHROUGH_ID_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z]+)(?:-(\d+))?$/;

interface Document {
  fields: Map<string, { value: string; line: number }>;
  body: string;
  /** Line number of the body's first line. */
  bodyLine: number;
}

function parseHeader(text: string, file: string, issues: CorpusIssue[]): Document | undefined {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    issues.push({ file, line: 1, message: 'Expected a "---" header line' });
    return undefined;
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    issues.push({ file, line: 1, message: 'The header has no closing "---"' });
    return undefined;
  }
  const fields = new Map<string, { value: string; line: number }>();
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? '';
    const match = /^([a-z]+):\s*(.*)$/.exec(line);
    if (match === null) {
      issues.push({ file, line: i + 1, message: `Expected "key: value", found "${line}"` });
      continue;
    }
    const [, key = '', value = ''] = match;
    if (fields.has(key)) issues.push({ file, line: i + 1, message: `"${key}" is given twice` });
    fields.set(key, { value: value.trim(), line: i + 1 });
  }
  return { fields, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unknownFields(
  doc: Document,
  allowed: readonly string[],
  file: string,
  issues: CorpusIssue[],
) {
  for (const [key, { line }] of doc.fields) {
    if (!allowed.includes(key))
      issues.push({ file, line, message: `Unknown header field "${key}"` });
  }
}

export function parseProblem(id: string, text: string, issues: CorpusIssue[]): Problem | undefined {
  const file = `problems/${id}.md`;
  if (!ID_PATTERN.test(id))
    issues.push({ file, message: 'Problem IDs are lowercase words joined by dashes' });
  const doc = parseHeader(text, file, issues);
  if (doc === undefined) return undefined;
  unknownFields(doc, ['title', 'inputs', 'split', 'tags'], file, issues);
  const title = doc.fields.get('title')?.value ?? '';
  if (title === '') issues.push({ file, message: 'A problem needs a title' });
  const split = doc.fields.get('split')?.value ?? 'train';
  const knownSplit = SPLITS.find((s) => s === split);
  if (knownSplit === undefined) {
    const line = doc.fields.get('split')?.line;
    issues.push({
      file,
      ...(line === undefined ? {} : { line }),
      message: `Split must be train or test, not "${split}"`,
    });
  }
  const inputs = list(doc.fields.get('inputs')?.value);
  if (inputs.length === 0)
    issues.push({ file, message: 'A problem needs its inputs ("inputs: nums, target")' });
  const statement = doc.body.trim();
  if (statement === '') issues.push({ file, message: 'The statement is empty' });
  return {
    id,
    title,
    inputs,
    split: knownSplit ?? 'train',
    tags: list(doc.fields.get('tags')?.value),
    statement,
  };
}

export function parseWalkthrough(
  id: string,
  text: string,
  issues: CorpusIssue[],
): Walkthrough | undefined {
  const file = `walkthroughs/${id}.txt`;
  const doc = parseHeader(text, file, issues);
  if (doc === undefined) return undefined;
  unknownFields(doc, ['problem', 'style'], file, issues);
  const problem = doc.fields.get('problem')?.value ?? '';
  const styleText = doc.fields.get('style')?.value ?? '';
  const style = STYLES.find((s) => s === styleText);
  if (style === undefined) {
    issues.push({ file, message: `Style must be one of ${STYLES.join(', ')}, not "${styleText}"` });
    return undefined;
  }
  const match = WALKTHROUGH_ID_PATTERN.exec(id);
  if (match?.[1] !== problem || match[2] !== style) {
    issues.push({
      file,
      message: `The file should be named ${problem}.${style}.txt (or ${problem}.${style}-2.txt, …)`,
    });
  }
  const utterances = doc.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (utterances.length === 0)
    issues.push({ file, message: 'A walkthrough needs at least one utterance' });
  return { id, problem, style, utterances };
}
