import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const root = import.meta.dirname;

// Packages opt into Node.js APIs with `"textscript": { "runtime": "node" }` in
// their package.json. Every other package must run unchanged in a browser
// (see docs/adr/001), so its src/ may not touch Node or DOM APIs.
const nodePackageGlobs = readdirSync(join(root, 'packages'))
  .filter((name) => {
    const manifest = join(root, 'packages', name, 'package.json');
    if (!existsSync(manifest)) return false;
    return JSON.parse(readFileSync(manifest, 'utf8')).textscript?.runtime === 'node';
  })
  .map((name) => `packages/${name}/**`);

const environmentMessage =
  'Engine packages must stay environment-agnostic. Mark the package with "textscript": { "runtime": "node" } if it really needs this.';

export default defineConfig(
  { ignores: ['**/node_modules/', '**/dist/', 'coverage/', '**/golden/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: [
      '*.{js,ts}',
      'scripts/**',
      'packages/*/bin/**',
      'packages/*/test/**',
      ...nodePackageGlobs,
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: nodePackageGlobs,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({ name, message: environmentMessage })),
          patterns: [{ group: ['node:*'], message: environmentMessage }],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['process', 'Buffer', '__dirname', '__filename', 'require', 'global'].map((name) => ({
          name,
          message: environmentMessage,
        })),
        ...['window', 'document', 'navigator', 'localStorage'].map((name) => ({
          name,
          message: environmentMessage,
        })),
      ],
    },
  },
  prettier,
);
