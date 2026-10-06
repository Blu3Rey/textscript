import { IR_SCHEMA_VERSION } from '@textscript/core';
import pkg from '../package.json' with { type: 'json' };

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const HELP = `Usage: textscript [option]

Developer console for the TextScript engine. The interactive console
arrives in roadmap segment S5.

Options:
  -h, --help     Show this help
  -v, --version  Show version information
`;

/** Runs the CLI and returns the process exit code. */
export function main(argv: readonly string[], io: Io): number {
  const [arg, extra] = argv;
  if (extra !== undefined) {
    io.stderr(`textscript: unexpected argument '${extra}'\n`);
    return 2;
  }
  switch (arg) {
    case undefined:
    case '-h':
    case '--help':
      io.stdout(HELP);
      return 0;
    case '-v':
    case '--version':
      io.stdout(`textscript ${pkg.version} (IR schema v${String(IR_SCHEMA_VERSION)})\n`);
      return 0;
    default:
      io.stderr(`textscript: unknown option '${arg}'\n\n${HELP}`);
      return 2;
  }
}
