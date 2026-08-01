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

import { RepositoryNavigator } from './repository-navigator.js';

/**
 * Navigation against a real graph, produced by the whole pipeline.
 *
 * The unit suite runs against an in-memory `RepositoryGraphApi` and proves the layer needs no
 * database. This one runs scanner → host → IR → resolver → call graph → framework → graph builder →
 * SQLite → Graph API → explorer → navigator, so a passing unit test cannot be an artefact of the fake.
 *
 * The fixture is a real Express layout: a mounted router, a three-link chain with middleware, a
 * handler written as a member expression that cannot be linked, an environment variable read in the
 * service rather than the handler, a mutual import cycle and an external package.
 *
 * Everything below `@traceiq/explorer` is a **dev** dependency, used only to build the fixture.
 */
const FILES = {
  'packages/api/src/app.ts': `import express from 'express';
import userRoutes from './routes';
const app = express();
app.use('/api', userRoutes);
export default app;
`,
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { UserService } from '../../core/src/service';
const router = Router();
const service = new UserService();
const controller = { create() {} };
router.get('/users/:id', requireAuth, getUser);
router.post('/users', controller.create);
export function requireAuth(): void {}
export function getUser(): string | undefined { return service.find('1'); }
export default router;
`,
  'packages/core/src/service.ts': `import { UserRepository } from './repository';
import { helper } from './cycle.a';
export class UserService {
  find(id: string): string | undefined {
    const repo = new UserRepository();
    helper();
    repo.load(id);
    return process.env.JWT_SECRET;
  }
}
`,
  'packages/core/src/repository.ts': `export class UserRepository {
  load(id: string): string { return id; }
}
`,
  'packages/core/src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'packages/core/src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
};

const GET_USER = 'sym:packages/api/src/routes.ts#getUser' as NodeId;
const SERVICE = 'sym:packages/core/src/service.ts#UserService' as NodeId;
const FIND = 'sym:packages/core/src/service.ts#UserService.find' as NodeId;
const API_FILE = 'file:packages/api/src/routes.ts' as NodeId;

let root: string;
let api: SqliteGraphApi;
let navigator: RepositoryNavigator;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-navigation-'));

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
    name: 'navigation-fixture',
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
    workspacePackages: [],
      files: [],
      languages: [],
      manifests: [],
      regions: [],
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
  navigator = new RepositoryNavigator(api);
});

afterAll(async () => {
  api.close();
  await rm(root, { recursive: true, force: true });
});

describe('routes over a real graph', () => {
  it('lists the routes the fixture registers', () => {
    expect(navigator.routes().entries.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      'GET /users/:id',
      'POST /users',
    ]);
  });

  it('explains a route selected by method and path', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.route.path).toBe('/users/:id');
    expect(view?.method).toBe('GET');
  });

  it('returns null for a path the fixture never registers', () => {
    expect(navigator.explainRoute({ method: 'GET', path: '/api/users/:id' })).toBeNull();
  });
});

describe('explainRoute over a real graph', () => {
  it('reports the real chain in running order', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.chain.map((step) => step.declaration?.name)).toEqual(['requireAuth', 'getUser']);
    expect(view?.handler?.declaration?.id).toBe(GET_USER);
  });

  it('carries a real Explain Symbol result for the handler', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.handler?.explain?.kind).toBe('Function');
    expect(view?.handler?.explain?.sourceFile?.path).toBe('packages/api/src/routes.ts');
  });

  it('names the service and repository the real chain reaches', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.services.map((entry) => entry.ref.id)).toContain(SERVICE);
    expect(view?.repositories.map((entry) => entry.ref.id)).toContain(
      'sym:packages/core/src/repository.ts#UserRepository',
    );
  });

  it('reports the environment variable read through the service', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.environmentVariables.entries.map((entry) => entry.name)).toContain('JWT_SECRET');
  });

  it('reports the external package the route files import', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.externalPackages.entries.map((entry) => entry.id)).toContain('ext:npm:express');
  });

  it('states that the mounted prefix could not be composed', () => {
    // app.ts writes app.use('/api', userRoutes), so the real path is /api/users/:id — and nothing in
    // the graph records that. The route must not be reported under the composed path.
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.pathComposition.composed).toBe(false);
    expect(view?.route.effectivePath).toBe('/users/:id');
    expect(view?.limitations.map((entry) => entry.code)).toContain('route-prefix-composition-unsupported');
  });

  it('reports the handler written as a member expression as unlinked', () => {
    const view = navigator.explainRoute({ method: 'POST', path: '/users' });

    expect(view?.unresolvedHandlers.map((entry) => entry.text)).toContain('controller.create');
    expect(view?.health.handlersUnlinked).toBeGreaterThan(0);
    expect(view?.limitations.map((entry) => entry.code)).toContain('route-handler-not-linked');
  });

  it('summarises impact and the call graph for a real chain', () => {
    const view = navigator.explainRoute({ method: 'GET', path: '/users/:id' });

    expect(view?.callGraph.callees).toBeGreaterThan(0);
    expect(view?.callGraph.reached).toBeGreaterThan(0);
    expect(view?.impact.directlyAffected).toBeGreaterThanOrEqual(0);
  });
});

describe('architecture over a real graph', () => {
  it('derives the two packages and nests files under them', () => {
    const tree = navigator.architecture().packageTree.entries;

    expect(tree.map((entry) => entry.name)).toEqual(['packages/api', 'packages/core']);
    expect(tree.find((entry) => entry.name === 'packages/core')?.files.total).toBe(4);
  });

  it('carries every class in the architecture tree', () => {
    const classes = navigator.architecture().architectureTree.entries.find((group) => group.group === 'Class');

    expect(classes?.entries.total).toBeGreaterThanOrEqual(2);
  });

  it('builds a role tree from the roles the Framework Extractor attributed', () => {
    const roles = navigator.architecture().roleTree.entries.map((entry) => entry.role);

    expect(roles).toContain('Service');
    expect(roles).toContain('Repository');
  });

  it('groups a role by the package its declarations sit in', () => {
    const services = navigator.architecture().roleTree.entries.find((entry) => entry.role === 'Service');

    expect(services?.packages.entries.map((entry) => entry.name)).toContain('packages/core');
  });

  it('builds an architecture tree with real groups', () => {
    const groups = navigator.architecture().architectureTree.entries;

    expect(groups.some((group) => group.category === 'role')).toBe(true);
    expect(groups.some((group) => group.group === 'Class')).toBe(true);
  });
});

describe('dependencies over a real graph', () => {
  it('navigates a real declaration', () => {
    const view = navigator.dependencies(FIND);

    expect(view?.subject.kind).toBe('declaration');
    expect(view?.callGraph.incoming.entries.map((entry) => entry.sourceId)).toContain(GET_USER);
  });

  it('navigates a real file', () => {
    const view = navigator.dependencies(API_FILE);

    expect(view?.subject.kind).toBe('file');
    expect(view?.importGraph.outgoing.total).toBeGreaterThan(0);
  });

  it('navigates a real package', () => {
    const view = navigator.dependencies({ package: 'packages/core' });

    expect(view?.subject).toMatchObject({ kind: 'package', name: 'packages/core' });
    expect(view?.subject.files.total).toBe(4);
  });

  it('navigates a real route through its handlers', () => {
    const view = navigator.dependencies('route:GET:/users/:id' as NodeId);

    expect(view?.subject.kind).toBe('route');
    expect(view?.closure.total).toBeGreaterThan(0);
  });

  it('reports the real mutual import cycle', () => {
    const view = navigator.dependencies({ package: 'packages/core' });
    const members = view?.cycles.flatMap((cycle) => cycle.nodes.map((entry) => entry.id)) ?? [];

    expect(members).toContain('file:packages/core/src/cycle.a.ts');
  });

  it('reports both closures with shortest depth over a real chain', () => {
    const view = navigator.dependencies(GET_USER);

    expect(view?.closure.entries.find((entry) => entry.node.id === FIND)?.depth).toBe(1);
    expect(view?.reverseClosure.total).toBeGreaterThanOrEqual(0);
  });
});

describe('reuse, determinism and isolation over a real graph', () => {
  it('reads nothing from the database on a repeated operation', () => {
    // The reuse guarantee is that nothing is read twice — not that a new question is cheap. A first
    // call may legitimately ask something no earlier operation did.
    const fresh = new RepositoryNavigator(api);

    expect(fresh.profile('architecture', (inner) => inner.architecture()).profile.graphApiCalls).toBeGreaterThan(0);
    expect(fresh.profile('architecture', (inner) => inner.architecture()).profile.graphApiCalls).toBe(0);

    fresh.explainRoute({ method: 'GET', path: '/users/:id' });

    const repeated = fresh.profile('explainRoute', (inner) =>
      inner.explainRoute({ method: 'GET', path: '/users/:id' }),
    );

    expect(repeated.profile.graphApiCalls).toBe(0);
    expect(repeated.profile.cacheHits).toBeGreaterThan(0);
  });

  it('reports reuse of the explorer and the Query Engine', () => {
    const profiled = navigator.profile('explainRoute', (inner) =>
      inner.explainRoute({ method: 'GET', path: '/users/:id' }),
    );

    expect(profiled.profile.explorerCalls).toBeGreaterThan(0);
    expect(profiled.profile.queryEngineCalls).toBeGreaterThan(0);
  });

  it('answers identically on repeated calls', () => {
    expect(navigator.architecture()).toEqual(navigator.architecture());
    expect(navigator.explainRoute({ method: 'GET', path: '/users/:id' })).toEqual(
      navigator.explainRoute({ method: 'GET', path: '/users/:id' }),
    );
  });

  it('answers identically from a second navigator over the same database', () => {
    const other = new RepositoryNavigator(api);

    expect(other.routes()).toEqual(navigator.routes());
    expect(other.architecture()).toEqual(navigator.architecture());
  });

  it('returns plain data with no storage object attached', () => {
    for (const result of [
      navigator.architecture(),
      navigator.explainRoute({ method: 'GET', path: '/users/:id' }),
      navigator.dependencies({ package: 'packages/core' }),
    ]) {
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it('carries no connection, statement or database path anywhere in a response', () => {
    const serialised = JSON.stringify([
      navigator.architecture(),
      navigator.explainRoute({ method: 'GET', path: '/users/:id' }),
      navigator.dependencies(FIND),
    ]);

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('sqlite');
  });

  it('reports every node it returns as a node the database holds', () => {
    for (const group of navigator.architecture().architectureTree.entries) {
      for (const entry of group.entries.entries) {
        expect(api.exists(entry.id)).toBe(true);
      }
    }
  });
});
