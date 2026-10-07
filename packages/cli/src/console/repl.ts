// The interactive console. A line ending in ":" (other than a meta command
// or `wrap`) continues on the following lines until a blank one.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Console, type FileSystem } from './console';

export interface ReplOptions {
  input: Readable;
  output: Writable;
  fs: FileSystem;
  inputs?: string[];
}

const BANNER =
  'TextScript console. Start with "say <what you would say>"; :help lists commands, :quit leaves.\n';

function continues(line: string): boolean {
  const text = line.trim();
  return text.endsWith(':') && !text.startsWith(':') && !text.startsWith('wrap ');
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { input, output } = options;
  const terminal = 'isTTY' in output && output.isTTY === true;
  const console = new Console(options);
  const lines = createInterface({ input, ...(terminal ? { output, terminal } : {}) });
  const prompt = (text: string) => {
    if (terminal) {
      lines.setPrompt(text);
      lines.prompt();
    } else {
      output.write(text);
    }
  };

  output.write(BANNER);
  prompt('ts> ');
  let buffer: string[] = [];
  for await (const line of lines) {
    if (buffer.length > 0 ? line.trim() !== '' : continues(line)) {
      buffer.push(line);
      prompt('... ');
      continue;
    }
    const command = buffer.length > 0 ? buffer.join('\n') : line;
    buffer = [];
    const result = console.execute(command);
    if (result.output.length > 0) output.write(`${result.output.join('\n')}\n`);
    if (result.status === 'quit') break;
    prompt('ts> ');
  }
  lines.close();
}
