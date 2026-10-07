#!/usr/bin/env node
// Workspace packages export TypeScript source (see docs/adr/001), so the
// server registers tsx before loading it instead of requiring a build step.
import { register } from 'tsx/esm/api';

register();
const { start } = await import('../src/main.ts');
start();
