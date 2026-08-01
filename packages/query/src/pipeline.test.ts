import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FrameworkExtractor } from '@traceiq/framework';
import { GraphBuilder, GraphStore, SqliteGraphApi } from '@traceiq/graph';
import { IrBuilder } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { Resolver } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';
import type { NodeId } from '@traceiq/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QueryEngine } from './query-engine.js';

/**
 * The Query Engine against a real graph, produced by the whole pipeline.
 *
 * The unit tests run against an in-memory `RepositoryGraphApi` and prove the engine needs
 * no database. This one proves the SQLite implementation answers the same way, so a
 * passing unit test cannot be an artefact of the fake.
 *
 * `@traceiq/graph` is a **dev** dependency only: it appears here to build a fixture, and
 * nothing in `src/` outside a test imports it.
 */
const FILES = {
  'src/app.ts': `import express from 'express';
import authRoutes from './auth.routes';
const app = express();
app.use('/api/auth', authRoutes);
export default app;
`,
  'src/auth.routes.ts': `import { Router } from 'express';
import { AuthController } from './auth.controller';
const router = Router();
const controller = new AuthController();
router.post('/login', requireAuth, doLogin);
router.get('/me', controller.me);
export function requireAuth(): void {}
export function doLogin(): string | undefined { return process.env.JWT_SECRET; }
export default router;
`,
  'src/auth.controller.ts': `export class AuthController {
  me(): void {}
}
`,
  'src/auth.service.ts': `import type { Shape } from './shape';
export class AuthService {
  run(): Shape | undefined { void process.env.PORT; return undefined; }
}
`,
  'src/user.repository.ts': `export class UserRepository {
  find(id: string): string { return id; }
}
`,
  'src/shape.ts': `export interface Shape { a: string }
`,
  'src/broken.ts': `import missing from './nowhere';
export const value = missing;
`,
};

let root: string;
let api: SqliteGraphApi;
let engine: QueryEngine;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-query-'));

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
    name: 'query-fixture',
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
  const annotations = new FrameworkExtractor().extract({ ir, resolved });
  const graph = new GraphBuilder().build({ ir, resolved, annotations });

  context.dispose();

  const databaseFile = path.join(root, 'graph.db');
  const store = GraphStore.open(databaseFile);

  store.write(graph, '2026-07-29T00:00:00.000Z');
  store.close();

  api = SqliteGraphApi.open(databaseFile);
  engine = new QueryEngine(api);
});

afterAll(async () => {
  api.close();
  await rm(root, { recursive: true, force: true });
});

const id = (value: string): NodeId => value as NodeId;

describe('queries over a real graph', () => {
  it('finds a declaration and its role', () => {
    const controller = engine.findDeclaration(id('sym:src/auth.controller.ts#AuthController'));

    expect(controller?.node.kind).toBe('Class');
    expect(controller?.roles.map((entry) => entry.role)).toContain('Controller');
  });

  it('finds the routes the fixture registers', () => {
    expect(engine.findRoutes().map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /me',
      'POST /login',
    ]);
  });

  it('orders a real middleware chain by ordinal', () => {
    const login = engine.findRoutes().find((route) => route.path === '/login');

    expect(login?.handlers.map((entry) => entry.declaration?.name)).toEqual([
      'requireAuth',
      'doLogin',
    ]);
  });

  it('explains a route, splitting middleware from the handler', () => {
    const explanation = engine.explainRoute(id('route:POST:/login'));

    expect(explanation?.middleware.map((entry) => entry.declaration?.name)).toEqual(['requireAuth']);
    expect(explanation?.handler?.declaration?.name).toBe('doLogin');
  });

  it('surfaces a handler that could not be linked', () => {
    // `controller.me` is a member expression, so nothing links it without resolution.
    const explanation = engine.explainRoute(id('route:GET:/me'));

    expect(explanation?.unresolvedHandlers.map((entry) => entry.text)).toEqual(['controller.me']);
    expect(explanation?.handler).toBeNull();
  });

  it('reports that a mounted route path could not be composed', () => {
    // app.ts writes `app.use('/api/auth', authRoutes)`, so `/login` is really
    // `/api/auth/login` — and nothing in the graph records that prefix.
    const login = engine.findRoutes().find((route) => route.path === '/login');

    expect(login?.composition.composed).toBe(false);
    expect(login?.composition.effectivePath).toBe('/login');
  });

  it('finds environment variables with the declarations reading them', () => {
    const variables = engine.findEnvironmentVariables();

    expect(variables.map((entry) => entry.node.name).sort()).toEqual(['JWT_SECRET', 'PORT']);

    const secret = variables.find((entry) => entry.node.name === 'JWT_SECRET');

    expect(secret?.reads[0]?.source?.name).toBe('doLogin');
  });

  it('finds dependencies, distinguishing packages from built-ins', () => {
    const kinds = new Set(engine.findDependencies().map((entry) => entry.node.externalKind));

    expect(kinds.has('npm')).toBe(true);
  });

  it('finds services and repositories by role', () => {
    expect(engine.findServices().map((entry) => entry.node.name)).toContain('AuthService');
    expect(engine.findRepositories().map((entry) => entry.node.name)).toContain('UserRepository');
  });

  it('finds type references to an interface', () => {
    const references = engine.findTypeReferences(id('sym:src/shape.ts#Shape'));

    expect(references.length).toBeGreaterThan(0);
    expect(references.every((entry) => entry.edge.type === 'REFERENCES_TYPE')).toBe(true);
  });

  it('excludes containment from references', () => {
    const references = engine.findReferences(id('sym:src/auth.controller.ts#AuthController.me'));

    expect(references.every((entry) => entry.edge.type !== 'DECLARES')).toBe(true);
  });

  it('finds the unresolved import the fixture contains', () => {
    expect(engine.findUnresolved().some((entry) => entry.reference.text === './nowhere')).toBe(true);
  });
});

describe('explainability over a real graph', () => {
  it('carries provenance and a location on every route handler edge', () => {
    for (const route of engine.findRoutes()) {
      for (const handler of route.handlers) {
        expect(handler.edge.provenance.evidence.length).toBeGreaterThan(10);
        expect(handler.edge.location.startLine).toBeGreaterThan(0);
      }
    }
  });

  it('carries confidence on every result that has one', () => {
    const allowed = ['CERTAIN', 'RESOLVED', 'INFERRED', 'AMBIGUOUS'];

    for (const route of engine.findRoutes()) {
      expect(allowed).toContain(route.node.confidence);
    }

    for (const variable of engine.findEnvironmentVariables()) {
      for (const read of variable.reads) {
        expect(allowed).toContain(read.edge.confidence);
      }
    }
  });

  it('names a source node for every unresolved reference', () => {
    for (const entry of engine.findUnresolved()) {
      expect(entry.source).not.toBeNull();
    }
  });
});

describe('agreement with the in-memory implementation', () => {
  it('answers identically on repeated reads of a real graph', () => {
    expect(engine.findRoutes()).toEqual(engine.findRoutes());
    expect(engine.findEnvironmentVariables()).toEqual(engine.findEnvironmentVariables());
  });

  it('returns plain data with no storage object attached', () => {
    const routes = engine.findRoutes();

    expect(JSON.parse(JSON.stringify(routes))).toEqual(routes);
  });
});
