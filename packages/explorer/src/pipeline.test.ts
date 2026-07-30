import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CallGraphResolver } from '@traceiq/call-graph';
import { FrameworkExtractor } from '@traceiq/framework';
import { GraphBuilder, GraphStore, SqliteGraphApi } from '@traceiq/graph';
import { IrBuilder } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { Resolver } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';
import type { NodeId } from '@traceiq/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RepositoryExplorer } from './repository-explorer.js';

/**
 * The explorer against a real graph, produced by the whole pipeline.
 *
 * The unit suites run against an in-memory `RepositoryGraphApi` and prove the read layer needs no
 * database. This one runs scanner → host → IR → resolver → call graph → framework → graph builder →
 * SQLite → Graph API → explorer, so a passing unit test cannot be an artefact of the fake.
 *
 * The fixture is a two-package layout with a mutual import cycle, a mutual call cycle, recursion, an
 * orphan module, a route chain, an environment variable and an external package.
 *
 * Everything below `@traceiq/graph-api` is a **dev** dependency, used only to build the fixture.
 */
const FILES = {
  'packages/api/src/app.ts': `import express from 'express';
import authRoutes from './routes';
const app = express();
app.use('/api', authRoutes);
export default app;
`,
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { AuthService } from '../../core/src/service';
const router = Router();
const service = new AuthService();
router.post('/login', requireAuth, doLogin);
export function requireAuth(): void {}
export function doLogin(): string | undefined { return service.verify(); }
export default router;
`,
  'packages/core/src/service.ts': `import { helper } from './cycle.a';
export class AuthService {
  verify(): string | undefined {
    helper();
    missingHelper();
    return process.env.JWT_SECRET;
  }
}
export function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }
`,
  'packages/core/src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'packages/core/src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
  'packages/core/src/orphan.ts': `export function nobodyImportsThis(): void {}
`,
};

const SERVICE = 'sym:packages/core/src/service.ts#AuthService' as NodeId;
const VERIFY = 'sym:packages/core/src/service.ts#AuthService.verify' as NodeId;
const DO_LOGIN = 'sym:packages/api/src/routes.ts#doLogin' as NodeId;
const CORE_FILE = 'file:packages/core/src/service.ts' as NodeId;

let root: string;
let api: SqliteGraphApi;
let explorer: RepositoryExplorer;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-explorer-'));

  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: false,
        skipLibCheck: true,
      },
    }),
    ...FILES,
  };

  for (const [relativePath, contents] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents, 'utf8');
  }

  const inventory: RepositoryInventory = {
    name: 'explorer-fixture',
    rootPath: root,
    language: 'typescript',
    framework: 'express',
    packageManager: 'unknown',
    sourceFiles: Object.keys(FILES).sort(),
    directories: [],
    tsconfigPath: 'tsconfig.json',
    packageJsonPath: null,
    lockfile: null,
    entryPoints: [],
    ignoredPaths: [],
  };

  const context = new ProjectHost().load(inventory);
  const ir = new IrBuilder().build(context);
  const resolved = new Resolver().resolve({ ir, context });
  const callGraph = new CallGraphResolver().resolve({ ir, resolved });
  const annotations = new FrameworkExtractor().extract({ ir, resolved });
  const graph = new GraphBuilder().build({ ir, resolved, annotations, callGraph });

  context.dispose();

  const databaseFile = path.join(root, 'graph.db');
  const store = GraphStore.open(databaseFile);

  store.write(graph, '2026-07-29T00:00:00.000Z');
  store.close();

  api = SqliteGraphApi.open(databaseFile);
  explorer = new RepositoryExplorer(api);
});

afterAll(async () => {
  api.close();
  await rm(root, { recursive: true, force: true });
});

describe('overview over a real graph', () => {
  it('reports the fixture files and declarations', () => {
    const overview = explorer.overview();

    expect(overview.repository.files).toBe(Object.keys(FILES).length);
    expect(overview.repository.declarations).toBeGreaterThan(5);
  });

  it('derives the two packages from the real paths', () => {
    expect(explorer.overview().packages.entries.map((entry) => entry.name)).toEqual([
      'packages/api',
      'packages/core',
    ]);
  });

  it('reports the health summary from Repository Health', () => {
    const health = explorer.overview().health;

    expect(health.callGraphCoverage).toBeGreaterThan(0);
    expect(health.limitationCodes).toContain('call-coverage-partial');
  });

  it('states that the package boundary is derived from paths', () => {
    expect(explorer.overview().limitations.map((entry) => entry.code)).toContain(
      'package-boundary-is-derived-from-paths',
    );
  });
});

describe('navigation over a real graph', () => {
  it('browses a real file', () => {
    const view = explorer.browseFile(CORE_FILE);

    expect(view?.packageName).toBe('packages/core');
    expect(view?.declarations.entries.map((entry) => entry.id)).toContain(SERVICE);
    expect(view?.imports.total).toBeGreaterThan(0);
  });

  it('browses a real symbol through Explain Symbol', () => {
    const view = explorer.browseSymbol(VERIFY);

    expect(view?.explain.kind).toBe('Method');
    expect(view?.explain.enclosingDeclaration?.declaration?.id).toBe(SERVICE);
    expect(view?.packageName).toBe('packages/core');
  });

  it('lists the children of a real class', () => {
    expect(explorer.browseSymbol(SERVICE)?.children.entries.map((entry) => entry.id)).toContain(VERIFY);
  });

  it('summarises real impact through Impact Analysis', () => {
    const view = explorer.browseSymbol(VERIFY);

    expect(view?.impact.directlyAffected).toBeGreaterThan(0);
  });

  it('finds the recursive declaration', () => {
    const view = explorer.browseSymbol('sym:packages/core/src/service.ts#countdown' as NodeId);

    expect(view?.health.recursive).toBe(true);
  });

  it('reports the route reaching a real handler', () => {
    const routes = explorer.browseFile('file:packages/api/src/routes.ts' as NodeId)?.routes;

    expect(routes?.entries.map((entry) => entry.path)).toContain('/login');
  });

  it('reports the environment variable a real file reads', () => {
    expect(explorer.browseFile(CORE_FILE)?.environmentVariables.entries.map((entry) => entry.name)).toContain(
      'JWT_SECRET',
    );
  });
});

describe('packages over a real graph', () => {
  it('lists the files in a real package', () => {
    expect(explorer.browsePackage('packages/core')?.files.total).toBe(4);
  });

  it('lists the external packages a real package imports', () => {
    expect(explorer.browsePackage('packages/api')?.externalPackages.total).toBeGreaterThan(0);
  });

  it('returns null for a package that does not exist', () => {
    expect(explorer.browsePackage('packages/nowhere')).toBeNull();
  });
});

describe('dependencies over a real graph', () => {
  it('reports direct callers and callees of a real declaration', () => {
    const view = explorer.dependencies(VERIFY);

    expect(view?.direct.callers.entries.map((entry) => entry.edge.sourceId)).toContain(DO_LOGIN);
    expect(view?.direct.callees.total).toBeGreaterThan(0);
  });

  it('reports both closures for a real declaration', () => {
    const view = explorer.dependencies(VERIFY);

    expect(view?.indirect.forward.total).toBeGreaterThan(0);
    expect(view?.indirect.reverse.total).toBeGreaterThan(0);
  });

  it('reports the cycles a real declaration takes part in', () => {
    const view = explorer.dependencies('sym:packages/core/src/cycle.a.ts#helper' as NodeId);

    expect(view?.indirect.cycles.length).toBeGreaterThan(0);
  });
});

describe('cycles over a real graph', () => {
  it('finds the mutual call cycle', () => {
    const members = explorer.cycles().callCycles.entries.flatMap((cycle) => cycle.nodes.map((entry) => entry.id));

    expect(members).toContain('sym:packages/core/src/cycle.a.ts#helper');
    expect(members).toContain('sym:packages/core/src/cycle.b.ts#partner');
  });

  it('finds the mutual import cycle between the two files', () => {
    const members = explorer.cycles().importCycles.entries.flatMap((cycle) => cycle.nodes.map((entry) => entry.id));

    expect(members).toContain('file:packages/core/src/cycle.a.ts');
    expect(members).toContain('file:packages/core/src/cycle.b.ts');
  });

  it('returns every cycle rather than counting them', () => {
    const report = explorer.cycles();

    expect(report.callCycles.entries.length).toBe(report.totals.call);
    expect(report.importCycles.entries.length).toBe(report.totals.import);
  });

  it('carries the edges forming each real cycle', () => {
    for (const cycle of explorer.cycles().importCycles.entries) {
      expect(cycle.edges.total).toBeGreaterThan(0);
    }
  });
});

describe('hotspots and architecture over a real graph', () => {
  it('reports the most referenced declarations', () => {
    expect(explorer.hotspots().mostReferenced.total).toBeGreaterThan(0);
  });

  it('groups real declarations by kind', () => {
    const view = explorer.architecture();

    expect(view.classes.total).toBeGreaterThanOrEqual(1);
    expect(view.functions.total).toBeGreaterThan(1);
  });

  it('finds the roles the Framework Extractor attributed', () => {
    expect(explorer.architecture().services.total).toBeGreaterThanOrEqual(1);
  });
});

describe('search over a real graph', () => {
  it('finds a real declaration by prefix', () => {
    expect(explorer.search({ text: 'AuthService' }).declarations.entries.map((entry) => entry.id)).toContain(SERVICE);
  });

  it('finds real declarations by path', () => {
    expect(explorer.search({ path: 'packages/core' }).declarations.total).toBeGreaterThan(0);
  });

  it('finds a real route', () => {
    expect(explorer.search({ route: '/login' }).routes.total).toBe(1);
  });

  it('finds a real environment variable', () => {
    expect(explorer.search({ environmentVariable: 'JWT' }).environmentVariables.total).toBe(1);
  });
});

describe('reuse, determinism and isolation over a real graph', () => {
  it('reuses one graph read across every capability', () => {
    const fresh = new RepositoryExplorer(api);
    const first = fresh.profile('overview', (inner) => inner.overview());

    expect(first.profile.graphApiCalls).toBeGreaterThan(0);

    const symbol = fresh.profile('browseSymbol', (inner) => inner.browseSymbol(VERIFY));

    // Explain Symbol, Impact Analysis and the health index all read through the shared cache, so
    // this asks the database for very little beyond what the overview already read.
    expect(symbol.profile.cacheHits).toBeGreaterThan(symbol.profile.graphApiCalls);
  });

  it('answers identically on repeated calls', () => {
    expect(explorer.overview()).toEqual(explorer.overview());
    expect(explorer.cycles()).toEqual(explorer.cycles());
    expect(explorer.browseSymbol(VERIFY)).toEqual(explorer.browseSymbol(VERIFY));
  });

  it('answers identically from a second explorer over the same database', () => {
    const other = new RepositoryExplorer(api);

    expect(other.overview()).toEqual(explorer.overview());
    expect(other.search({ text: 'Auth' })).toEqual(explorer.search({ text: 'Auth' }));
  });

  it('returns plain data with no storage object attached', () => {
    for (const result of [explorer.overview(), explorer.cycles(), explorer.browseSymbol(VERIFY)]) {
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it('carries no connection, statement or database path anywhere in a response', () => {
    const serialised = JSON.stringify([
      explorer.overview(),
      explorer.browseFile(CORE_FILE),
      explorer.browseSymbol(VERIFY),
      explorer.hotspots(),
    ]);

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('sqlite');
  });

  it('reports every node it returns as a node the database holds', () => {
    for (const entry of explorer.architecture().classes.entries) {
      expect(api.exists(entry.id)).toBe(true);
    }
  });
});
