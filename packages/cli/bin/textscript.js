#!/usr/bin/env node
// Workspace packages export TypeScript source (see docs/adr/001), so the
// CLI registers tsx before loading it instead of requiring a build step.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
