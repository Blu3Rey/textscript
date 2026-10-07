// Loads and checks the whole corpus. `readCorpusDir` reads it from disk;
// `loadCorpus` works on text, so tests can use small in-memory corpora.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseProblem,
  parseWalkthrough,
  type CorpusFiles,
  type CorpusIssue,
  type Problem,
  type Walkthrough,
} from './corpus';
import { compileGold, parseGold, type CompiledGold } from './gold';

export interface Corpus {
  problems: Map<string, Problem>;
  walkthroughs: Map<string, Walkthrough>;
  /** Compiled gold, by walkthrough ID. Missing for walkthroughs whose gold has issues. */
  gold: Map<string, CompiledGold>;
  /** Gold that stopped at a failing step: the steps before it. */
  drafts: Map<string, CompiledGold>;
  issues: CorpusIssue[];
}

/** Each problem needs at least this many walkthroughs (ROADMAP.md S6). */
export const MIN_WALKTHROUGHS_PER_PROBLEM = 2;

export function loadCorpus(files: CorpusFiles): Corpus {
  const issues: CorpusIssue[] = [];
  const problems = new Map<string, Problem>();
  const walkthroughs = new Map<string, Walkthrough>();
  const gold = new Map<string, CompiledGold>();
  const drafts = new Map<string, CompiledGold>();

  for (const [id, text] of files.problems) {
    const problem = parseProblem(id, text, issues);
    if (problem) problems.set(id, problem);
  }
  for (const [id, text] of files.walkthroughs) {
    const walkthrough = parseWalkthrough(id, text, issues);
    if (walkthrough === undefined) continue;
    walkthroughs.set(id, walkthrough);
    if (!files.problems.has(walkthrough.problem)) {
      issues.push({
        file: `walkthroughs/${id}.txt`,
        message: `No problem "${walkthrough.problem}"`,
      });
    }
  }
  for (const id of files.gold.keys()) {
    if (!files.walkthroughs.has(id))
      issues.push({ file: `gold/${id}.gold`, message: `No walkthrough "${id}"` });
  }
  for (const [id, walkthrough] of walkthroughs) {
    const text = files.gold.get(id);
    if (text === undefined) {
      issues.push({ file: `walkthroughs/${id}.txt`, message: 'This walkthrough has no gold file' });
      continue;
    }
    const sources = parseGold(id, text, issues);
    const inputs = problems.get(walkthrough.problem)?.inputs ?? [];
    const compiled = compileGold(walkthrough, inputs, sources, issues);
    (compiled.complete ? gold : drafts).set(id, compiled);
  }
  for (const problem of problems.values()) {
    const count = [...walkthroughs.values()].filter((w) => w.problem === problem.id).length;
    if (count < MIN_WALKTHROUGHS_PER_PROBLEM) {
      issues.push({
        file: `problems/${problem.id}.md`,
        message: `Has ${String(count)} walkthrough${count === 1 ? '' : 's'}; every problem needs at least ${String(MIN_WALKTHROUGHS_PER_PROBLEM)}`,
      });
    }
  }
  return { problems, walkthroughs, gold, drafts, issues };
}

function readDir(dir: string, extension: string): Map<string, string> {
  const files = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names.sort()) {
    if (name.endsWith(extension)) {
      files.set(name.slice(0, -extension.length), readFileSync(join(dir, name), 'utf8'));
    }
  }
  return files;
}

export function readCorpusDir(root: string): CorpusFiles {
  return {
    problems: readDir(join(root, 'problems'), '.md'),
    walkthroughs: readDir(join(root, 'walkthroughs'), '.txt'),
    gold: readDir(join(root, 'gold'), '.gold'),
  };
}
