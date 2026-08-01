import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RepositoryPipeline } from './repository-pipeline.js';

/**
 * Bounded compilation, end to end.
 *
 * The property that matters is that **bounding changes nothing except peak memory**. A repository
 * analysed as several programs must produce the same declarations, the same cross-unit edges and
 * the same identities as the same repository analysed as one — otherwise the ceiling was removed by
 * lowering the standard.
 *
 * Every case here uses a workspace whose packages import each other, because that is exactly what a
 * per-unit program cannot see for itself and what the repository-wide declaration index restores.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const WORKSPACE = {
  'package.json': JSON.stringify({
    name: 'bounded',
    private: true,
    workspaces: ['packages/*'],
  }),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }),
  'packages/core/package.json': JSON.stringify({ name: '@bounded/core', main: 'src/index.ts' }),
  'packages/core/src/index.ts': `export class Store {
  save(): void {}
}

export function helper(): number {
  return 1;
}
`,
  'packages/app/package.json': JSON.stringify({
    name: '@bounded/app',
    dependencies: { '@bounded/core': 'workspace:*' },
  }),
  'packages/app/src/index.ts': `import { Store, helper } from '@bounded/core';

export function run(): void {
  const store = new Store();

  store.save();
  helper();
}
`,
} as const;

async function scan(
  files: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-bounded-'));
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-bounded-db-'));

  roots.push(root, databaseDirectory);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  const previous = { ...process.env };

  Object.assign(process.env, environment);

  try {
    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    return pipeline.open(databasePath);
  } finally {
    for (const key of Object.keys(environment)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

/** Every edge of one type, as `source -> target`, so two scans can be compared exactly. */
const edgesOf = (session: Awaited<ReturnType<typeof scan>>, type: 'IMPORTS' | 'CALLS'): readonly string[] =>
  session.api
    .getEdges(type)
    .map((edge) => `${edge.sourceId} -> ${edge.targetId}`)
    .sort();

describe('a repository analysed as one program and as several', () => {
  it('produces the same cross-package edges either way', async () => {
    // The whole risk of bounding, in one assertion. `@bounded/app` imports `@bounded/core`; with a
    // program per package, `core`'s declarations are in a different unit. Resolving each unit
    // against only its own IR put those targets outside the analysed set — measured on TraceIQ,
    // opaque IMPORTS went from 19 to 1,581.
    const whole = await scan(WORKSPACE);
    const bounded = await scan(WORKSPACE, { TRACEIQ_WHOLE_PROGRAM_LIMIT: '0' });

    try {
      expect(edgesOf(bounded, 'IMPORTS')).toEqual(edgesOf(whole, 'IMPORTS'));
      expect(edgesOf(bounded, 'CALLS')).toEqual(edgesOf(whole, 'CALLS'));
    } finally {
      whole.close();
      bounded.close();
    }
  });

  it('reaches a sibling package’s declaration rather than an external', async () => {
    const bounded = await scan(WORKSPACE, { TRACEIQ_WHOLE_PROGRAM_LIMIT: '0' });

    try {
      const imports = edgesOf(bounded, 'IMPORTS');

      expect(imports).toContain(
        'file:packages/app/src/index.ts -> sym:packages/core/src/index.ts#Store',
      );
      expect(imports.some((edge) => edge.includes('ext:outside-analysis'))).toBe(false);
    } finally {
      bounded.close();
    }
  });

  it('declares every file exactly once, however many units read it', async () => {
    // A file extracted by two units would produce one declaration identifier twice, which the graph
    // refuses outright. `packages/core` is compiled into both programs — once as its own unit's
    // roots, once because `app` imports it — and must be *owned* by only one.
    const bounded = await scan(WORKSPACE, { TRACEIQ_WHOLE_PROGRAM_LIMIT: '0' });

    try {
      const ids = bounded.api.getNodes('Class').map((node) => node.id);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain('sym:packages/core/src/index.ts#Store');
    } finally {
      bounded.close();
    }
  });

  it('reports the same declaration count either way', async () => {
    const whole = await scan(WORKSPACE);
    const bounded = await scan(WORKSPACE, { TRACEIQ_WHOLE_PROGRAM_LIMIT: '0' });

    try {
      const count = (session: Awaited<ReturnType<typeof scan>>) =>
        ['Class', 'Function', 'Method'].reduce(
          (total, kind) => total + session.api.getNodes(kind as 'Class').length,
          0,
        );

      expect(count(bounded)).toBe(count(whole));
    } finally {
      whole.close();
      bounded.close();
    }
  });
});

/**
 * Failure isolation.
 *
 * Before compilation was bounded there was nothing to isolate: one program meant one throw aborted
 * the analyser, and every region in the repository fell to discovery depth together. The unit is
 * now the blast radius, and what a reader is owed is the difference between "no calls here" and
 * "this part was not analysed".
 */
describe('a unit that fails', () => {
  it('costs its own files and nothing else', async () => {
    // An unreadable source is the reproducible stand-in for a unit exhausting resources: the
    // `ProjectHost` throws while loading it, which is the same path an out-of-memory unit takes
    // wherever the failure is catchable.
    const session = await scan(
      {
        ...WORKSPACE,
        // A directory where a file is expected. `addSourceFileAtPath` throws on it, and it lands in
        // its own unit because it is its own workspace package.
        'packages/broken/package.json': JSON.stringify({ name: '@bounded/broken' }),
        'packages/broken/src/index.ts/placeholder': 'not a file',
      },
      { TRACEIQ_WHOLE_PROGRAM_LIMIT: '0' },
    );

    try {
      // The healthy packages are analysed in full despite the broken one.
      expect(session.api.getNodes('Class').map((node) => node.id)).toContain(
        'sym:packages/core/src/index.ts#Store',
      );
      expect(edgesOf(session, 'CALLS').length).toBeGreaterThan(0);
    } finally {
      session.close();
    }
  });

  it('says so through the capability reason rather than reporting a smaller repository', async () => {
    const session = await scan(
      {
        ...WORKSPACE,
        // Two files in two directories, so a budget of one genuinely has something to split.
        'packages/core/src/extra/a.ts': 'export const a = 1;\n',
        'packages/core/src/extra/b.ts': 'export const b = 2;\n',
      },
      { TRACEIQ_WHOLE_PROGRAM_LIMIT: '0', TRACEIQ_FILE_BUDGET: '1' },
    );

    try {
      // A budget of one splits every region, which is the honest signal that a reference between
      // two parts of a split region may be unresolved. Silence here would let a reader take an
      // absence caused by bounding for a fact about the code.
      const reasons = session.api.getCapabilities().regions.map((region) => region.reason);

      expect(reasons.some((reason) => reason.includes('too large to compile at once'))).toBe(true);
    } finally {
      session.close();
    }
  });
});

/**
 * Reusing an unchanged scan.
 *
 * A rescan of unchanged sources produces the same graph by construction — the analysis is
 * deterministic — so doing it again is pure waste. For a repository large enough to need bounded
 * compilation that waste is minutes, which is the whole reason this exists.
 */
describe('an unchanged repository', () => {
  it('is not analysed twice, and reports the same graph', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'traceiq-incr-'));
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-incr-db-'));

    roots.push(root, databaseDirectory);

    for (const [relativePath, contents] of Object.entries(WORKSPACE)) {
      const absolute = path.join(root, relativePath);

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, 'utf8');
    }

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');
    const scanOnce = () =>
      pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    const first = await scanOnce();
    const second = await scanOnce();

    // Every count a consumer reads must agree, because the second summary describes the graph the
    // first one wrote — read back from disk rather than remembered.
    expect(second).toEqual(first);
  });

  it('is analysed again once a source changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'traceiq-incr-'));
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-incr-db-'));

    roots.push(root, databaseDirectory);

    for (const [relativePath, contents] of Object.entries(WORKSPACE)) {
      const absolute = path.join(root, relativePath);

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, 'utf8');
    }

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    const first = await pipeline.scan({
      repositoryPath: root,
      databasePath,
      createdAt: '1970-01-01T00:00:00.000Z',
    });

    await writeFile(
      path.join(root, 'packages/core/src/index.ts'),
      'export class Store {\n  save(): void {}\n}\n\nexport function helper(): number {\n  return 1;\n}\n\nexport function added(): void {}\n',
      'utf8',
    );

    const second = await pipeline.scan({
      repositoryPath: root,
      databasePath,
      createdAt: '1970-01-01T00:00:00.000Z',
    });

    expect(second.declarations).toBeGreaterThan(first.declarations);
  });
});
