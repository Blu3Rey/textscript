// Scenario scripts: console commands plus expectations, run as end-to-end
// tests (docs/adr/010).
//
// A command starts at the beginning of a line; indented lines below it
// continue it. Lines starting with `#` at the beginning of a line are
// comments and are echoed into the transcript. A command error counts as a
// failure unless the next command is `expect error <code>`.

import { Console, type FileSystem } from './console';

export interface ScriptCommand {
  /** 1-based line number of the command's first line. */
  line: number;
  text: string;
}

export type ScriptItem = ScriptCommand | { line: number; comment: string };

function isCommand(item: ScriptItem): item is ScriptCommand {
  return 'text' in item;
}

export function splitScript(text: string): ScriptItem[] {
  const items: ScriptItem[] = [];
  let current: ScriptCommand | undefined;
  let blanks = 0;
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') {
      if (current) blanks++;
      continue;
    }
    if (/^\s/.test(line) && current) {
      current.text += '\n'.repeat(blanks + 1) + line.trimEnd();
      blanks = 0;
      continue;
    }
    current = undefined;
    blanks = 0;
    if (line.startsWith('#')) {
      items.push({ line: i + 1, comment: line.trimEnd() });
    } else {
      current = { line: i + 1, text: line.trim() };
      items.push(current);
    }
  }
  return items;
}

export interface ScriptResult {
  transcript: string;
  failures: number;
}

export function runScript(
  text: string,
  options: { fs: FileSystem; inputs?: string[] },
): ScriptResult {
  const console = new Console(options);
  const items = splitScript(text);
  const out: string[] = [];
  let failures = 0;
  for (const [i, item] of items.entries()) {
    if (!isCommand(item)) {
      out.push(item.comment);
      continue;
    }
    out.push(...item.text.split('\n').map((line) => `> ${line}`.trimEnd()));
    const result = console.execute(item.text);
    out.push(...result.output);
    if (result.status === 'mismatch') {
      failures++;
      out.push(`! line ${String(item.line)}: expectation not met`);
    } else if (result.status === 'error') {
      const next = items.slice(i + 1).find(isCommand);
      if (!next?.text.startsWith('expect error')) {
        failures++;
        out.push(`! line ${String(item.line)}: unexpected error`);
      }
    } else if (result.status === 'quit') {
      break;
    }
    out.push('');
  }
  const summary = failures === 0 ? 'ok' : `${String(failures)} failure${failures === 1 ? '' : 's'}`;
  return { transcript: `${out.join('\n').trimEnd()}\n\n-- ${summary}\n`, failures };
}
