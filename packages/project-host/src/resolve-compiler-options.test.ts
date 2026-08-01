import type { WorkspacePackage } from '@traceiq/scanner';
import { ts } from 'ts-morph';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectFixture, type FixtureFiles } from './project-fixture.test-helper.js';
import { ProjectHost } from './project-host.js';
import { resolveCompilerOptions } from './resolve-compiler-options.js';

let fixture: ProjectFixture | null = null;

afterEach(async () => {
  await fixture?.remove();
  fixture = null;
});

const workspacePackage = (overrides: Partial<WorkspacePackage>): WorkspacePackage => ({
  name: '@scope/thing',
  directory: 'packages/thing',
  sourceDirectory: 'packages/thing/src',
  entryFile: 'packages/thing/src/index.ts',
  tsconfigPath: null,
  ...overrides,
});

async function repository(files: FixtureFiles) {
  fixture = await ProjectFixture.create(files);

  return fixture;
}

describe('layering', () => {
  it('uses built-in defaults when the repository has no tsconfig', async () => {
    const created = await repository({});
    const resolved = resolveCompilerOptions(created.inventory({}));

    expect(resolved.options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);
    expect(resolved.notes).toContain('no tsconfig.json at the repository root; using built-in defaults');
  });

  it("takes the root tsconfig's own options", async () => {
    const created = await repository({
      'tsconfig.json': '{"compilerOptions":{"strict":false,"target":"ES2015"}}',
    });

    const resolved = resolveCompilerOptions(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(resolved.options.target).toBe(ts.ScriptTarget.ES2015);
    expect(resolved.options.strict).toBe(false);
  });

  it('keeps defaults beneath a solution-style root that declares no options', async () => {
    // The case that made this necessary: a monorepo root of `files: []` plus
    // `references` configures nothing, so the whole repository was previously analysed
    // under TypeScript's own defaults — ES5 and classic module resolution.
    const created = await repository({
      'tsconfig.json': '{"files":[],"references":[{"path":"./packages/thing"}]}',
    });

    const resolved = resolveCompilerOptions(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(resolved.options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);
    expect(resolved.options.target).toBe(ts.ScriptTarget.ES2022);
    expect(resolved.notes.some((note) => note.includes('solution-style'))).toBe(true);
  });

  it('follows an extends chain, so a package configured through a shared base is not seen as empty', async () => {
    const created = await repository({
      'base.json': '{"compilerOptions":{"target":"ES2017"}}',
      'tsconfig.json': '{"extends":"./base.json"}',
    });

    const resolved = resolveCompilerOptions(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(resolved.options.target).toBe(ts.ScriptTarget.ES2017);
  });

  it('reports an unreadable root tsconfig rather than silently using defaults', async () => {
    const created = await repository({ 'tsconfig.json': '{ not json' });

    expect(
      resolveCompilerOptions(created.inventory({ tsconfigPath: 'tsconfig.json' }))
        .rootTsconfigUnreadable,
    ).toBe(true);
  });

  it('drops emit options, which a merged analysis program cannot honour', async () => {
    const created = await repository({
      'tsconfig.json': '{"compilerOptions":{"outDir":"dist","rootDir":"src","composite":true}}',
    });

    const resolved = resolveCompilerOptions(created.inventory({ tsconfigPath: 'tsconfig.json' }));

    expect(resolved.options.outDir).toBeUndefined();
    expect(resolved.options.rootDir).toBeUndefined();
    expect(resolved.options.composite).toBeUndefined();
  });
});

describe('workspace path mappings', () => {
  it('maps every workspace package onto its sources', async () => {
    const created = await repository({});

    const resolved = resolveCompilerOptions(
      created.inventory({ workspacePackages: [workspacePackage({})] }),
    );

    expect(resolved.options.paths?.['@scope/thing']).toEqual([
      created.path('packages/thing/src/index.ts'),
    ]);
    expect(resolved.options.paths?.['@scope/thing/*']).toEqual([
      created.path('packages/thing/src/*'),
    ]);
  });

  it('never sets baseUrl, which would make bare specifiers resolve against the root', async () => {
    const created = await repository({});

    const resolved = resolveCompilerOptions(
      created.inventory({ workspacePackages: [workspacePackage({})] }),
    );

    expect(resolved.options.baseUrl).toBeUndefined();
  });

  it('sets no paths at all for a repository that is not a workspace', async () => {
    const created = await repository({});

    expect(resolveCompilerOptions(created.inventory({})).options.paths).toBeUndefined();
  });
});

describe('options merged from package tsconfigs', () => {
  it("merges a package's path aliases, rebased to its own directory", async () => {
    const created = await repository({
      'apps/web/tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    });

    const resolved = resolveCompilerOptions(
      created.inventory({
        workspacePackages: [
          workspacePackage({
            name: 'web',
            directory: 'apps/web',
            sourceDirectory: 'apps/web/src',
            entryFile: null,
            tsconfigPath: 'apps/web/tsconfig.json',
          }),
        ],
      }),
    );

    expect(resolved.options.paths?.['@/*']).toEqual([created.path('apps/web/src/*')]);
  });

  it('takes jsx from a package that declares it', async () => {
    const created = await repository({
      'apps/web/tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx"}}',
    });

    const resolved = resolveCompilerOptions(
      created.inventory({
        workspacePackages: [
          workspacePackage({ tsconfigPath: 'apps/web/tsconfig.json', directory: 'apps/web' }),
        ],
      }),
    );

    expect(resolved.options.jsx).toBe(ts.JsxEmit.ReactJSX);
  });

  it('unions lib across packages, so a DOM app and a Node service both resolve', async () => {
    const created = await repository({
      'apps/web/tsconfig.json': '{"compilerOptions":{"lib":["ES2022","DOM"]}}',
      'apps/api/tsconfig.json': '{"compilerOptions":{"lib":["ES2023"]}}',
    });

    const resolved = resolveCompilerOptions(
      created.inventory({
        workspacePackages: [
          workspacePackage({ name: 'api', tsconfigPath: 'apps/api/tsconfig.json' }),
          workspacePackage({ name: 'web', tsconfigPath: 'apps/web/tsconfig.json' }),
        ],
      }),
    );

    expect(resolved.options.lib).toEqual(['lib.dom.d.ts', 'lib.es2022.d.ts', 'lib.es2023.d.ts']);
  });

  it('does not merge options that change what type checking means', async () => {
    // A package's `strict` is its authors' choice about their own code. Applying it to
    // the whole repository would analyse other packages under rules nobody chose.
    const created = await repository({
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'packages/loose/tsconfig.json': '{"compilerOptions":{"strict":false}}',
    });

    const resolved = resolveCompilerOptions(
      created.inventory({
        tsconfigPath: 'tsconfig.json',
        workspacePackages: [workspacePackage({ tsconfigPath: 'packages/loose/tsconfig.json' })],
      }),
    );

    expect(resolved.options.strict).toBe(true);
  });

  it('skips a package tsconfig that cannot be read, without failing the repository', async () => {
    const created = await repository({ 'packages/broken/tsconfig.json': '{ not json' });

    const resolved = resolveCompilerOptions(
      created.inventory({
        workspacePackages: [workspacePackage({ tsconfigPath: 'packages/broken/tsconfig.json' })],
      }),
    );

    expect(resolved.rootTsconfigUnreadable).toBe(false);
    expect(resolved.notes.some((note) => note.includes('could not be read'))).toBe(true);
  });
});

describe('jsx fallback', () => {
  it('defaults to preserve when .tsx sources exist and no tsconfig declares jsx', async () => {
    // Without a jsx option the compiler cannot parse JSX at all, so every .tsx file in
    // the repository would contribute nothing.
    const created = await repository({});

    const resolved = resolveCompilerOptions(
      created.inventory({ sourceFiles: ['src/app.tsx'] }),
    );

    expect(resolved.options.jsx).toBe(ts.JsxEmit.Preserve);
  });

  it('leaves jsx unset when there are no .tsx sources', async () => {
    const created = await repository({});

    expect(resolveCompilerOptions(created.inventory({ sourceFiles: ['src/a.ts'] })).options.jsx)
      .toBeUndefined();
  });

  it('does not override a declared jsx', async () => {
    const created = await repository({
      'tsconfig.json': '{"compilerOptions":{"jsx":"react"}}',
    });

    const resolved = resolveCompilerOptions(
      created.inventory({ tsconfigPath: 'tsconfig.json', sourceFiles: ['src/app.tsx'] }),
    );

    expect(resolved.options.jsx).toBe(ts.JsxEmit.React);
  });
});

describe('through the Project Host', () => {
  it('resolves a sibling import to source rather than to published types', async () => {
    // The defect this milestone exists to fix. `packages/consumer` imports `@scope/thing`,
    // which node resolution would take to `packages/thing/dist/index.d.ts` — build output
    // the scan ignores, leaving the reference outside the analysed file set entirely.
    const created = await repository({
      'packages/thing/package.json':
        '{"name":"@scope/thing","types":"./dist/index.d.ts","exports":{".":"./dist/index.js"}}',
      'packages/thing/src/index.ts': 'export class Thing { run(): void {} }',
      'packages/thing/dist/index.d.ts': 'export declare class Thing { run(): void; }',
      'packages/consumer/src/index.ts':
        "import { Thing } from '@scope/thing';\nexport const thing = new Thing();",
    });

    const context = new ProjectHost().load(
      created.inventory({
        sourceFiles: ['packages/consumer/src/index.ts', 'packages/thing/src/index.ts'],
        workspacePackages: [workspacePackage({})],
      }),
    );

    try {
      const consumer = context.findSourceFile('packages/consumer/src/index.ts');
      const resolvedTo = consumer
        ?.getImportDeclarations()[0]
        ?.getModuleSpecifierSourceFile()
        ?.getFilePath();

      expect(resolvedTo).toBe(created.path('packages/thing/src/index.ts'));
    } finally {
      context.dispose();
    }
  });

  it('resolves a subpath export to source through the wildcard mapping', async () => {
    const created = await repository({
      'packages/thing/package.json': '{"name":"@scope/thing"}',
      'packages/thing/src/index.ts': 'export const main = 1;',
      'packages/thing/src/testing.ts': 'export const helper = 2;',
      'packages/consumer/src/index.ts':
        "import { helper } from '@scope/thing/testing';\nexport const used = helper;",
    });

    const context = new ProjectHost().load(
      created.inventory({
        sourceFiles: [
          'packages/consumer/src/index.ts',
          'packages/thing/src/index.ts',
          'packages/thing/src/testing.ts',
        ],
        workspacePackages: [workspacePackage({})],
      }),
    );

    try {
      const consumer = context.findSourceFile('packages/consumer/src/index.ts');
      const resolvedTo = consumer
        ?.getImportDeclarations()[0]
        ?.getModuleSpecifierSourceFile()
        ?.getFilePath();

      expect(resolvedTo).toBe(created.path('packages/thing/src/testing.ts'));
    } finally {
      context.dispose();
    }
  });

  it('records how the options were arrived at', async () => {
    const created = await repository({
      'tsconfig.json': '{"files":[],"references":[]}',
    });

    const context = new ProjectHost().load(
      created.inventory({
        tsconfigPath: 'tsconfig.json',
        workspacePackages: [workspacePackage({})],
      }),
    );

    try {
      expect(context.configurationNotes.some((note) => note.includes('solution-style'))).toBe(true);
      expect(
        context.configurationNotes.some((note) => note.includes('1 workspace package(s)')),
      ).toBe(true);
    } finally {
      context.dispose();
    }
  });

  it('still refuses an inventory naming a tsconfig it cannot parse', async () => {
    const created = await repository({ 'tsconfig.json': '{ not json' });

    expect(() =>
      new ProjectHost().load(created.inventory({ tsconfigPath: 'tsconfig.json' })),
    ).toThrow(/tsconfig/);
  });
});
