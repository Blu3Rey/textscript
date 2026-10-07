import { readFileSync, writeFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { IR_SCHEMA_VERSION } from '@textscript/core';
import pkg from '../package.json' with { type: 'json' };
import type { FileSystem } from './console/console';
import { runRepl } from './console/repl';
import { runScript } from './console/script';

export interface Io {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  fs?: FileSystem;
}

export const nodeFileSystem: FileSystem = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, text) => {
    writeFileSync(path, text);
  },
};

const HELP = `Usage: textscript [--inputs <a,b>]
       textscript run [--quiet] [--inputs <a,b>] <script>...

Developer console for the TextScript engine. With no command, starts the
interactive console; type :help there for its commands.

Commands:
  run <script>...  Run scenario scripts and print their transcripts.
                   Exits 1 if any expectation fails.

Options:
  --inputs <a,b>   Names the problem gives as inputs (for the analyzer)
  --quiet          With run, print only a summary line per script
  -h, --help       Show this help
  -v, --version    Show version information
`;

class UsageError extends Error {}

interface Args {
  command: 'repl' | 'run' | 'help' | 'version';
  files: string[];
  inputs: string[];
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: 'repl', files: [], inputs: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') return { ...args, command: 'help' };
    if (arg === '-v' || arg === '--version') return { ...args, command: 'version' };
    if (arg === '--quiet') {
      args.quiet = true;
    } else if (arg === '--inputs') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--inputs needs a value');
      args.inputs = value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option '${arg}'`);
    } else if (arg === 'run' && args.command === 'repl' && args.files.length === 0) {
      args.command = 'run';
    } else if (args.command === 'run') {
      args.files.push(arg);
    } else {
      throw new UsageError(`unexpected argument '${arg}'`);
    }
  }
  if (args.command === 'run' && args.files.length === 0)
    throw new UsageError('run needs a script file');
  return args;
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`textscript: ${error.message}\n\n${HELP}`);
    return 2;
  }
  const fs = io.fs ?? nodeFileSystem;
  switch (args.command) {
    case 'help':
      io.stdout.write(HELP);
      return 0;
    case 'version':
      io.stdout.write(`textscript ${pkg.version} (IR schema v${String(IR_SCHEMA_VERSION)})\n`);
      return 0;
    case 'repl':
      await runRepl({ input: io.stdin, output: io.stdout, fs, inputs: args.inputs });
      return 0;
    case 'run': {
      let failed = 0;
      for (const file of args.files) {
        let text: string;
        try {
          text = fs.readFile(file);
        } catch {
          io.stderr.write(`textscript: can't read ${file}\n`);
          return 2;
        }
        const result = runScript(text, { fs, inputs: args.inputs });
        if (!args.quiet) io.stdout.write(result.transcript);
        const summary = result.failures === 0 ? 'ok' : `${String(result.failures)} failed`;
        io.stdout.write(`${file}: ${summary}\n`);
        if (result.failures > 0) failed++;
      }
      return failed > 0 ? 1 : 0;
    }
  }
}
