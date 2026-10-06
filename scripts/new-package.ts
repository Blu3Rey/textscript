// Scaffolds a new workspace package under packages/.
//
// Usage: pnpm new-package <name> [--description "..."] [--node]
//
// --node marks the package as allowed to use Node.js APIs. Without it the
// package must stay environment-agnostic (see docs/adr/001).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';

export interface ScaffoldOptions {
  /** Repository root that contains packages/. */
  root: string;
  /** Directory name, also used as `@textscript/<name>`. Kebab-case. */
  name: string;
  description: string;
  /** Allow Node.js APIs in src/. */
  node: boolean;
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** Creates the package files and returns their paths relative to `root`. */
export async function scaffoldPackage({
  root,
  name,
  description,
  node,
}: ScaffoldOptions): Promise<string[]> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Package name must be kebab-case (e.g. "render-js"), got "${name}"`);
  }
  const dir = join(root, 'packages', name);
  if (existsSync(dir)) {
    throw new Error(`packages/${name} already exists`);
  }

  const files: Record<string, string> = {
    'package.json': json({
      name: `@textscript/${name}`,
      version: '0.0.0',
      private: true,
      description,
      type: 'module',
      exports: { '.': './src/index.ts' },
      ...(node ? { textscript: { runtime: 'node' } } : {}),
      scripts: {
        typecheck: node
          ? 'tsc -p tsconfig.json'
          : 'tsc -p tsconfig.json && tsc -p test/tsconfig.json',
        test: 'vitest run',
      },
    }),
    // A browser-safe package compiles src/ without Node types; its tests,
    // which may use Node, get their own tsconfig (docs/adr/001).
    'tsconfig.json': json(
      node
        ? {
            extends: '../../tsconfig.base.json',
            compilerOptions: { types: ['node'] },
            include: ['src', 'test'],
          }
        : { extends: '../../tsconfig.base.json', include: ['src'] },
    ),
    ...(node
      ? {}
      : {
          'test/tsconfig.json': json({
            extends: '../../../tsconfig.base.json',
            compilerOptions: { types: ['node'] },
            include: ['.', '../src'],
          }),
        }),
    'README.md': `# @textscript/${name}\n\n${description}\n`,
    'src/index.ts': `// Public API of @textscript/${name}.\nexport {};\n`,
    'test/index.test.ts': [
      "import { expect, it } from 'vitest';",
      '',
      "it('loads', async () => {",
      "  await expect(import('../src/index')).resolves.toBeDefined();",
      '});',
      '',
    ].join('\n'),
  };

  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  const created: string[] = [];
  for (const [file, contents] of Object.entries(files)) {
    const path = join(dir, file);
    // Format with the repo's Prettier config so new packages pass `pnpm format:check`.
    const options = (await resolveConfig(path)) ?? {};
    writeFileSync(path, await format(contents, { ...options, filepath: path }));
    created.push(relative(root, path));
  }
  return created;
}

async function cli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      description: { type: 'string', default: 'TODO: describe this package.' },
      node: { type: 'boolean', default: false },
    },
  });
  const [name] = positionals;
  if (name === undefined || positionals.length > 1) {
    console.error('Usage: pnpm new-package <name> [--description "..."] [--node]');
    return 2;
  }
  try {
    const created = await scaffoldPackage({
      root: join(import.meta.dirname, '..'),
      name,
      description: values.description,
      node: values.node,
    });
    console.log(`Created @textscript/${name}:`);
    for (const file of created) console.log(`  ${file}`);
    console.log('\nNext: run `pnpm install` to link it, then `pnpm check`.');
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await cli(process.argv.slice(2));
}
