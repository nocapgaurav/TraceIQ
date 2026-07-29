import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_COMPILER_OPTIONS } from './compiler-options.js';
import { ProjectContextDisposedError } from './project-context.js';
import { ProjectHost, ProjectHostError } from './project-host.js';
import {
  FIXTURE_TSCONFIG,
  ProjectFixture,
  type FixtureFiles,
} from './project-fixture.test-helper.js';

/**
 * Note on approach: several tests reach into the exposed type checker to ask for
 * the type of a declaration. That is the *test* exercising what the host hands
 * out — the host itself inspects no symbols. Asking the checker a real question is
 * the only way to prove the program was assembled correctly, because a
 * misconfigured program produces `any` rather than an error.
 */

const fixtures: ProjectFixture[] = [];
const host = new ProjectHost();

async function fixture(files: FixtureFiles = {}): Promise<ProjectFixture> {
  const created = await ProjectFixture.create(files);

  fixtures.push(created);

  return created;
}

/** A small project whose imports cross a file boundary and a package boundary. */
const PROJECT_FILES: FixtureFiles = {
  'tsconfig.json': FIXTURE_TSCONFIG,
  'src/greeting.ts': 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
  'src/index.ts':
    "import { greet } from './greeting';\n\nexport const message = greet('world');\n",
  'src/uses-lib.ts': "import { shout } from 'tiny-lib';\n\nexport const loud = shout('x');\n",
  'node_modules/tiny-lib/package.json': JSON.stringify({
    name: 'tiny-lib',
    version: '1.0.0',
    main: 'index.js',
    types: 'index.d.ts',
  }),
  'node_modules/tiny-lib/index.d.ts': 'export declare function shout(text: string): string;\n',
};

const PROJECT_SOURCES = ['src/greeting.ts', 'src/index.ts', 'src/uses-lib.ts'];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((created) => created.remove()));
});

describe('ProjectHost: loading', () => {
  it('exposes the inventory source files, in inventory order', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    expect(context.sourceFiles).toHaveLength(3);
    expect(context.sourceFiles.map((file) => file.getBaseName())).toEqual([
      'greeting.ts',
      'index.ts',
      'uses-lib.ts',
    ]);
  });

  it('records the repository root and tsconfig path', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(context.rootPath).toBe(created.rootPath);
    expect(context.tsconfigPath).toBe('tsconfig.json');
  });

  it('loads a project with no source files at all', async () => {
    const created = await fixture({ 'tsconfig.json': FIXTURE_TSCONFIG });
    const context = host.load(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(context.sourceFiles).toEqual([]);
    expect(context.typeChecker).toBeDefined();
  });

  it('looks a source file up by its repository-relative path', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    expect(context.findSourceFile('src/greeting.ts')?.getBaseName()).toBe('greeting.ts');
  });

  it('returns undefined for a path that was not loaded', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    expect(context.findSourceFile('src/absent.ts')).toBeUndefined();
  });
});

describe('ProjectHost: compiler options', () => {
  it('takes options from the repository tsconfig', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(context.compilerOptions.strict).toBe(true);
    expect(context.compilerOptions.skipLibCheck).toBe(true);
  });

  it('falls back to documented defaults with no tsconfig', async () => {
    const created = await fixture({ 'src/index.ts': 'export const x = 1;\n' });
    const context = host.load(created.inventory({ sourceFiles: ['src/index.ts'] }));

    expect(context.tsconfigPath).toBeNull();
    expect(context.compilerOptions.strict).toBe(DEFAULT_COMPILER_OPTIONS.strict);
    expect(context.compilerOptions.target).toBe(DEFAULT_COMPILER_OPTIONS.target);
  });

  it('hands out a frozen copy, so a consumer cannot change how the checker behaves', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(Object.isFrozen(context.compilerOptions)).toBe(true);
  });

  it('freezes the default options too', () => {
    expect(Object.isFrozen(DEFAULT_COMPILER_OPTIONS)).toBe(true);
  });
});

describe('ProjectHost: the type checker', () => {
  it('resolves an import across two source files', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    const declaration = context
      .findSourceFile('src/index.ts')
      ?.getVariableDeclarationOrThrow('message');

    expect(declaration?.getType().getText()).toBe('string');
  });

  it('resolves an import into a declaration file under node_modules', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    const declaration = context
      .findSourceFile('src/uses-lib.ts')
      ?.getVariableDeclarationOrThrow('loud');

    expect(declaration?.getType().getText()).toBe('string');
  });

  it('keeps node_modules out of the analysed source set while remaining resolvable', async () => {
    const created = await fixture(PROJECT_FILES);
    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    const paths = context.sourceFiles.map((file) => file.getFilePath());

    expect(paths.some((filePath) => filePath.includes('node_modules'))).toBe(false);
  });
});

describe('ProjectHost: the inventory decides scope', () => {
  it('does not load a file the inventory omitted, even though tsconfig would include it', async () => {
    const created = await fixture({
      ...PROJECT_FILES,
      'src/omitted.ts': 'export const omitted = 1;\n',
    });

    const context = host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );

    expect(context.sourceFiles).toHaveLength(3);
    expect(context.findSourceFile('src/omitted.ts')).toBeUndefined();
  });
});

describe('ProjectHost: one project per context', () => {
  it('gives each context its own program rather than sharing one', async () => {
    const created = await fixture(PROJECT_FILES);
    const inventory = created.inventory({
      tsconfigPath: 'tsconfig.json',
      sourceFiles: PROJECT_SOURCES,
    });

    const first = host.load(inventory);
    const second = host.load(inventory);

    expect(first).not.toBe(second);
    expect(first.findSourceFile('src/index.ts')).not.toBe(second.findSourceFile('src/index.ts'));
  });

  it('leaves a second context working after the first is disposed', async () => {
    const created = await fixture(PROJECT_FILES);
    const inventory = created.inventory({
      tsconfigPath: 'tsconfig.json',
      sourceFiles: PROJECT_SOURCES,
    });

    const first = host.load(inventory);
    const second = host.load(inventory);

    first.dispose();

    expect(first.isDisposed).toBe(true);
    expect(second.isDisposed).toBe(false);
    expect(second.sourceFiles).toHaveLength(3);
  });
});

describe('ProjectContext: lifecycle', () => {
  async function loadedContext(): Promise<ReturnType<ProjectHost['load']>> {
    const created = await fixture(PROJECT_FILES);

    return host.load(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: PROJECT_SOURCES }),
    );
  }

  it('reports itself alive before disposal', async () => {
    expect((await loadedContext()).isDisposed).toBe(false);
  });

  it('reports itself disposed afterwards', async () => {
    const context = await loadedContext();

    context.dispose();

    expect(context.isDisposed).toBe(true);
  });

  it('can be disposed more than once', async () => {
    const context = await loadedContext();

    context.dispose();

    expect(() => context.dispose()).not.toThrow();
  });

  it.each([
    ['sourceFiles', (context: Awaited<ReturnType<typeof loadedContext>>) => context.sourceFiles],
    ['typeChecker', (context: Awaited<ReturnType<typeof loadedContext>>) => context.typeChecker],
    [
      'compilerOptions',
      (context: Awaited<ReturnType<typeof loadedContext>>) => context.compilerOptions,
    ],
    [
      'findSourceFile',
      (context: Awaited<ReturnType<typeof loadedContext>>) =>
        context.findSourceFile('src/index.ts'),
    ],
  ])('rejects %s after disposal rather than serving a released program', async (_name, access) => {
    const context = await loadedContext();

    context.dispose();

    expect(() => access(context)).toThrow(ProjectContextDisposedError);
  });

  it('names the repository in the disposal error', async () => {
    const context = await loadedContext();

    context.dispose();

    expect(() => context.sourceFiles).toThrow(context.rootPath);
  });
});

describe('ProjectHost: failure modes', () => {
  it('refuses an inventory that is not TypeScript', async () => {
    const created = await fixture(PROJECT_FILES);

    expect(() => host.load(created.inventory({ language: 'unknown' }))).toThrow(ProjectHostError);
  });

  it('says which language it was given', async () => {
    const created = await fixture(PROJECT_FILES);

    expect(() => host.load(created.inventory({ language: 'unknown' }))).toThrow(/'unknown'/);
  });

  it('refuses a relative repository root', async () => {
    const created = await fixture(PROJECT_FILES);

    expect(() => host.load(created.inventory({ rootPath: 'relative/path' }))).toThrow(
      /not absolute/,
    );
  });

  it('refuses an inventory naming a file that is not on disk', async () => {
    const created = await fixture(PROJECT_FILES);

    expect(() =>
      host.load(
        created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: ['src/vanished.ts'] }),
      ),
    ).toThrow(ProjectHostError);
  });

  it('names the file that could not be loaded', async () => {
    const created = await fixture(PROJECT_FILES);

    expect(() =>
      host.load(
        created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: ['src/vanished.ts'] }),
      ),
    ).toThrow(/src\/vanished\.ts/);
  });

  it('refuses a malformed tsconfig rather than silently falling back to defaults', async () => {
    const created = await fixture({
      'tsconfig.json': '{ not json',
      'src/index.ts': 'export const x = 1;\n',
    });

    expect(() =>
      host.load(
        created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: ['src/index.ts'] }),
      ),
    ).toThrow(ProjectHostError);
  });

  it('refuses an inventory naming a tsconfig that is not on disk', async () => {
    const created = await fixture({ 'src/index.ts': 'export const x = 1;\n' });

    expect(() =>
      host.load(
        created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: ['src/index.ts'] }),
      ),
    ).toThrow(/tsconfig/);
  });

  it('names the repository root in every failure', async () => {
    const created = await fixture(PROJECT_FILES);

    expect(() => host.load(created.inventory({ language: 'unknown' }))).toThrow(
      created.rootPath,
    );
  });
});
