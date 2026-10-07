// Gold annotations (corpus/ANNOTATION.md): for each utterance of a
// walkthrough, the edits that capture it, written as developer-console
// commands (docs/adr/010).
//
//   step 1
//   add root: def two_sum(nums, target):
//       ...
//   step 2
//   fill h1: seen = {}
//   or
//   fill h1:
//       seen = {}
//       ...
//
// `or` starts another acceptable answer for the same step. A step with no
// commands means the utterance should change nothing. `expect` lines check
// the alternative they follow, so the annotator can pin down what must stay
// a hole.
//
// Compiling a gold file runs each alternative in the console, starting from
// the state the step's first alternative left before it. The first
// alternative is canonical: it's the state later steps build on.

import { Console, splitScript, type FileSystem } from '@textscript/cli';
import {
  emptySession,
  type Clarification,
  type EditBatch,
  type IrDocument,
  type SessionEvent,
  type SessionState,
  type Utterance,
} from '@textscript/core';
import type { CorpusIssue, Walkthrough } from './corpus';

export interface GoldCommand {
  line: number;
  text: string;
}

export interface GoldStepSource {
  /** 1-based, as written after `step`. */
  number: number;
  line: number;
  /** Each acceptable answer's commands. Never empty; an answer may have no commands. */
  alternatives: GoldCommand[][];
}

export interface GoldAlternative {
  batch: EditBatch;
  after: IrDocument;
  clarifications: Clarification[];
}

export interface GoldStep {
  /** 0-based index into the walkthrough's utterances. */
  index: number;
  utterance: Utterance;
  /** Earlier utterances, oldest first. */
  recent: Utterance[];
  /** The canonical state before this step. */
  before: IrDocument;
  /** The first is canonical. */
  alternatives: GoldAlternative[];
}

export interface CompiledGold {
  walkthrough: Walkthrough;
  /** False if a step failed; `steps` then holds the steps before it. */
  complete: boolean;
  steps: GoldStep[];
  /** The canonical session after the last step. */
  final: SessionState;
}

/** Console commands a gold step may use: edits and expectations, no history or files. */
const GOLD_COMMANDS: ReadonlySet<string> = new Set([
  'add',
  'fill',
  'set',
  'replace',
  'remove',
  'move',
  'wrap',
  'rename',
  'label',
  'unlabel',
  'note',
  'unnote',
  'ask',
  'op',
  'expect',
]);

const noFiles: FileSystem = {
  readFile: () => {
    throw new Error('Gold steps have no files');
  },
  writeFile: () => {
    throw new Error('Gold steps have no files');
  },
};

export function parseGold(id: string, text: string, issues: CorpusIssue[]): GoldStepSource[] {
  const file = `gold/${id}.gold`;
  const steps: GoldStepSource[] = [];
  for (const item of splitScript(text)) {
    if (!('text' in item)) continue;
    const { line, text: command } = item;
    const stepMatch = /^step\s+(\d+)$/.exec(command);
    const current = steps.at(-1);
    if (stepMatch !== null) {
      const number = Number(stepMatch[1]);
      if (number !== steps.length + 1) {
        issues.push({
          file,
          line,
          message: `Expected step ${String(steps.length + 1)}, found step ${String(number)}`,
        });
      }
      steps.push({ number, line, alternatives: [[]] });
    } else if (current === undefined) {
      issues.push({ file, line, message: 'Commands must come after a "step <n>" line' });
    } else if (command === 'or') {
      current.alternatives.push([]);
    } else {
      const word = command.split(/\s/, 1)[0] ?? '';
      if (!GOLD_COMMANDS.has(word)) {
        issues.push({
          file,
          line,
          message: `"${word}" can't be used in gold; use edit commands and expect`,
        });
      }
      current.alternatives.at(-1)?.push({ line, text: command });
    }
  }
  return steps;
}

/**
 * Runs a gold file against its walkthrough. If a command fails or an
 * expectation isn't met, it adds issues and returns the steps before that
 * one with `complete: false`, so annotators can see where they are.
 */
export function compileGold(
  walkthrough: Walkthrough,
  inputs: readonly string[],
  sources: readonly GoldStepSource[],
  issues: CorpusIssue[],
): CompiledGold {
  const file = `gold/${walkthrough.id}.gold`;
  const before = issues.length;
  if (sources.length !== walkthrough.utterances.length) {
    issues.push({
      file,
      message: `The walkthrough has ${String(walkthrough.utterances.length)} utterances but the gold has ${String(sources.length)} steps`,
    });
  }
  let state = emptySession();
  let events: readonly SessionEvent[] = [];
  const steps: GoldStep[] = [];
  const recent: Utterance[] = [];

  for (const [index, source] of sources.entries()) {
    const text = walkthrough.utterances[index];
    if (text === undefined) break;
    const alternatives: GoldAlternative[] = [];
    let canonical: { state: SessionState; events: readonly SessionEvent[] } | undefined;
    let utterance: Utterance | undefined;

    for (const commands of source.alternatives) {
      const console = new Console({ fs: noFiles, inputs: [...inputs], session: { state, events } });
      console.execute(`say ${text}`);
      let failed = false;
      for (const command of commands) {
        const result = console.execute(command.text);
        if (result.status === 'error' || result.status === 'mismatch') {
          const detail = result.output
            .filter((line) => line.startsWith('✗') || line.startsWith('  '))
            .join('\n');
          issues.push({
            file,
            line: command.line,
            message: `Step ${String(source.number)}: ${detail}`,
          });
          failed = true;
          break;
        }
      }
      if (failed) continue;
      const committed = console.execute(':commit');
      const event = console.events.at(-1);
      if (committed.status !== 'ok' || event?.type !== 'edit') {
        issues.push({
          file,
          line: source.line,
          message: `Step ${String(source.number)} couldn't be committed`,
        });
        continue;
      }
      utterance ??= event.utterance;
      alternatives.push({
        batch: event.batch,
        after: console.state.document,
        clarifications: console.state.clarifications,
      });
      canonical ??= { state: console.state, events: console.events };
    }

    if (
      canonical === undefined ||
      utterance === undefined ||
      alternatives.length !== source.alternatives.length
    ) {
      return { walkthrough, complete: false, steps, final: state };
    }
    steps.push({ index, utterance, recent: [...recent], before: state.document, alternatives });
    recent.push(utterance);
    ({ state, events } = canonical);
  }
  return { walkthrough, complete: issues.length === before, steps, final: state };
}
