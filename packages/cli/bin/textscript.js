#!/usr/bin/env node
// Workspace packages export TypeScript source (see docs/adr/001), so the
// CLI registers tsx before loading it instead of requiring a build step.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
