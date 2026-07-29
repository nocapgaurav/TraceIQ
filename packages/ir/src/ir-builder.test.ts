import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProjectHost } from '@traceiq/project-host';
import { afterEach, describe, expect, it } from 'vitest';

import { IrBuildError, IrBuilder } from './ir-builder.js';
import { IrFixture, type FixtureFiles } from './ir-fixture.test-helper.js';

const fixtures: IrFixture[] = [];

async function repository(files: FixtureFiles): Promise<IrFixture> {
  const created = await IrFixture.create(files);

  fixtures.push(created);

  return created;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((created) => created.remove()));
});

describe('repository metadata', () => {
  it('names the repository after its root directory', async () => {
    const fixture = await repository({ 'src/a.ts': 'export const a = 1;\n' });

    expect(fixture.ir.repository.name).toBe(path.basename(fixture.rootPath));
    expect(fixture.ir.repository.rootPath).toBe(fixture.rootPath);
  });
});

describe('files', () => {
  it('records one entry per source file, in the order the context listed them', async () => {
    const fixture = await repository({
      'src/b.ts': 'export const b = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/c.ts': 'export const c = 1;\n',
    });

    expect(fixture.ir.files.map((file) => file.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('identifies files with the contract format and repository-relative paths', async () => {
    const fixture = await repository({ 'src/nested/deep.ts': 'export const d = 1;\n' });

    expect(fixture.ir.files[0]).toEqual({
      id: 'file:src/nested/deep.ts',
      path: 'src/nested/deep.ts',
      isDeclarationFile: false,
    });
  });

  it('flags declaration files', async () => {
    const fixture = await repository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.d.ts': 'export declare const b: number;\n',
    });

    expect(fixture.ir.files.map((file) => file.isDeclarationFile)).toEqual([false, true]);
  });

  it('handles a repository with no source files', async () => {
    const fixture = await repository({});

    expect(fixture.ir).toMatchObject({
      files: [],
      declarations: [],
      imports: [],
      exports: [],
    });
  });

  it('handles a file with no declarations at all', async () => {
    const fixture = await repository({ 'src/empty.ts': '// nothing here\n' });

    expect(fixture.ir.files).toHaveLength(1);
    expect(fixture.ir.declarations).toEqual([]);
  });
});

describe('determinism', () => {
  it('produces an identical IR when built twice from the same sources', async () => {
    const files = {
      'src/a.ts': 'export class A { m(): void {} }\nexport const x = 1;\n',
      'src/b.ts': "import { A } from './a';\nexport { A };\n",
    };

    const first = await repository(files);
    const second = await repository(files);

    // Root paths differ per temporary directory, so compare everything else.
    expect(second.ir.files).toEqual(first.ir.files);
    expect(second.ir.declarations).toEqual(first.ir.declarations);
    expect(second.ir.imports).toEqual(first.ir.imports);
    expect(second.ir.exports).toEqual(first.ir.exports);
  });

  it('orders declarations by file, then by position within the file', async () => {
    const fixture = await repository({
      'src/a.ts': 'export const first = 1;\nexport const second = 2;\n',
      'src/b.ts': 'export const third = 3;\n',
    });

    expect(fixture.ir.declarations.map((entry) => entry.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('orders a file’s exports with declaration modifiers before export statements', async () => {
    const fixture = await repository({
      'src/a.ts': 'export const inline = 1;\nconst other = 2;\nexport { other };\n',
    });

    expect(fixture.ir.exports.map((entry) => entry.kind)).toEqual(['declaration', 'named']);
  });
});

describe('language independence', () => {
  it('produces a result that survives a JSON round trip', async () => {
    const fixture = await repository({
      'src/a.ts': `export class A {
  #p = 1;
  get v(): number { return 1; }
  set v(x: number) {}
}
export interface I { m(): void; m(a: string): void }
export namespace N.M { export const x = 1; }
import './a';
export * from './a';
`,
    });

    // A structure that round-trips through JSON holds no class instances, no
    // compiler nodes and no functions, which is what language independence means
    // in practice.
    expect(JSON.parse(JSON.stringify(fixture.ir))).toEqual(fixture.ir);
  });

  it('exposes no compiler object on any declaration', async () => {
    const fixture = await repository({ 'src/a.ts': 'export class A { m(): void {} }\n' });

    for (const declaration of fixture.ir.declarations) {
      for (const value of Object.values(declaration)) {
        expect(typeof value).not.toBe('function');
      }

      expect(Object.getPrototypeOf(declaration)).toBe(Object.prototype);
    }
  });
});

describe('failure modes', () => {
  it('fails rather than dropping a file that is not addressable within the root', async () => {
    // A hand-built inventory can name a file outside the root, which the scanner
    // would never produce. The IR must refuse it rather than quietly omit it.
    const root = await mkdtemp(path.join(tmpdir(), 'traceiq-ir-stray-'));

    try {
      await mkdir(path.join(root, 'nested'), { recursive: true });
      await writeFile(path.join(root, 'nested', 'inside.ts'), 'export const i = 1;\n', 'utf8');
      await writeFile(path.join(root, 'stray.ts'), 'export const s = 1;\n', 'utf8');

      const context = new ProjectHost().load({
        name: 'stray',
        rootPath: path.join(root, 'nested'),
        language: 'typescript',
        framework: 'unknown',
        packageManager: 'unknown',
        sourceFiles: ['inside.ts', '../stray.ts'],
        directories: [],
        tsconfigPath: null,
        packageJsonPath: null,
        lockfile: null,
        entryPoints: [],
        ignoredPaths: [],
      });

      try {
        expect(() => new IrBuilder().build(context)).toThrow(IrBuildError);
        expect(() => new IrBuilder().build(context)).toThrow(/not addressable/);
      } finally {
        context.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the type checker is not consulted', () => {
  it('extracts declarations from a file that does not type-check', async () => {
    const fixture = await repository({
      'src/broken.ts': `export class Broken {
  method(): number { return 'not a number'; }
}
export const wrong: string = 42;
import { nothing } from './does-not-exist';
`,
    });

    expect(fixture.declaration('src/broken.ts', 'Broken.method')?.kind).toBe('method');
    expect(fixture.declaration('src/broken.ts', 'wrong')?.kind).toBe('variable');
    expect(fixture.importsIn('src/broken.ts')[0]?.moduleSpecifier).toBe('./does-not-exist');
  });

  it('records an import whose module does not exist', async () => {
    const fixture = await repository({
      'src/a.ts': "import x from 'package-that-is-not-installed';\nexport const a = x;\n",
    });

    expect(fixture.importsIn('src/a.ts')[0]).toMatchObject({
      moduleSpecifier: 'package-that-is-not-installed',
    });
  });
});
