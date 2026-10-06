import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldPackage } from './new-package';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'textscript-scaffold-'));
  mkdirSync(join(root, 'packages'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readJson(...parts: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ...parts), 'utf8')) as Record<string, unknown>;
}

describe('scaffoldPackage', () => {
  it('creates an environment-agnostic package by default', async () => {
    const files = await scaffoldPackage({
      root,
      name: 'render-js',
      description: 'Renders JS.',
      node: false,
    });

    expect(files.sort()).toEqual(
      [
        'packages/render-js/README.md',
        'packages/render-js/package.json',
        'packages/render-js/src/index.ts',
        'packages/render-js/test/index.test.ts',
        'packages/render-js/test/tsconfig.json',
        'packages/render-js/tsconfig.json',
      ].sort(),
    );
    const pkg = readJson('packages', 'render-js', 'package.json');
    expect(pkg['name']).toBe('@textscript/render-js');
    expect(pkg['description']).toBe('Renders JS.');
    expect(pkg).not.toHaveProperty('textscript');
    expect(readJson('packages', 'render-js', 'tsconfig.json')).toEqual({
      extends: '../../tsconfig.base.json',
      include: ['src'],
    });
    expect(readJson('packages', 'render-js', 'test', 'tsconfig.json')).toMatchObject({
      compilerOptions: { types: ['node'] },
    });
  });

  it('marks --node packages and gives them Node types', async () => {
    await scaffoldPackage({ root, name: 'server-utils', description: 'x', node: true });

    expect(readJson('packages', 'server-utils', 'package.json')['textscript']).toEqual({
      runtime: 'node',
    });
    expect(readJson('packages', 'server-utils', 'tsconfig.json')['compilerOptions']).toEqual({
      types: ['node'],
    });
  });

  it.each(['Core', 'render_js', '9lives', 'trailing-', ''])('rejects the name %j', async (name) => {
    await expect(scaffoldPackage({ root, name, description: 'x', node: false })).rejects.toThrow(
      /kebab-case/,
    );
  });

  it('refuses to overwrite an existing package', async () => {
    await scaffoldPackage({ root, name: 'core', description: 'x', node: false });
    await expect(
      scaffoldPackage({ root, name: 'core', description: 'x', node: false }),
    ).rejects.toThrow(/already exists/);
  });
});
