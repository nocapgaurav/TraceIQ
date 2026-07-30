import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CallGraphResolver } from '@traceiq/call-graph';
import { FrameworkExtractor } from '@traceiq/framework';
import { GraphBuilder, GraphStore, SqliteGraphApi } from '@traceiq/graph';
import { IrBuilder } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { QueryEngine } from '@traceiq/query';
import { Resolver } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';
import type { NodeId } from '@traceiq/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ImpactAnalyzer } from './impact-analyzer.js';

/**
 * Impact analysis against a real graph, produced by the whole pipeline.
 *
 * The unit suite runs against an in-memory `ImpactQueries` and proves traversal needs no
 * Query Engine and no database. This one runs scanner → host → IR → resolver → call graph →
 * framework → graph builder → SQLite → Graph API → Query Engine → analyzer and asks the same
 * questions, so a passing unit test cannot be an artefact of the fake.
 *
 * The fixture has a deliberate chain three deep — `find` ← `verify` ← `doLogin` ← `retry` —
 * plus a route on `doLogin`, so DIRECT, INDIRECT and route impact all have real data.
 *
 * Everything below `@traceiq/query` is a **dev** dependency, used only to build the fixture.
 */
const FILES = {
  'src/app.ts': `import express from 'express';
import authRoutes from './auth.routes';
const app = express();
app.use('/api/auth', authRoutes);
export default app;
`,
  'src/auth.routes.ts': `import { Router } from 'express';
import { AuthService } from './auth.service';
const router = Router();
const service = new AuthService();
router.post('/login', requireAuth, doLogin);
export function requireAuth(): void {}
export function doLogin(): string | undefined { return service.verify(); }
export function retry(): string | undefined { return doLogin(); }
export default router;
`,
  'src/auth.service.ts': `import { randomUUID } from 'node:crypto';
import { UserRepository } from './user.repository';
export class AuthService {
  verify(): string | undefined {
    const repo = new UserRepository();
    repo.find(randomUUID());
    missingHelper();
    return process.env.JWT_SECRET;
  }
}
`,
  'src/user.repository.ts': `import type { Shape } from './shape';
export class UserRepository {
  find(id: string): string { return id; }
  shaped(): Shape | undefined { return undefined; }
}
`,
  'src/shape.ts': `export interface Shape { a: string }
`,
  'src/orphan.ts': `export function nobodyCallsThis(): void {}
`,
};

const FIND = 'sym:src/user.repository.ts#UserRepository.find' as NodeId;
const VERIFY = 'sym:src/auth.service.ts#AuthService.verify' as NodeId;
const DO_LOGIN = 'sym:src/auth.routes.ts#doLogin' as NodeId;
const RETRY = 'sym:src/auth.routes.ts#retry' as NodeId;
const SHAPE = 'sym:src/shape.ts#Shape' as NodeId;
const ORPHAN = 'sym:src/orphan.ts#nobodyCallsThis' as NodeId;

let root: string;
let api: SqliteGraphApi;
let analyzer: ImpactAnalyzer;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-impact-'));

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
    name: 'impact-fixture',
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
  analyzer = new ImpactAnalyzer(new QueryEngine(api));
});

afterAll(async () => {
  api.close();
  await rm(root, { recursive: true, force: true });
});

const affectedIds = (id: NodeId): readonly string[] => {
  const result = analyzer.analyze(id);

  return [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])].map(
    (entry) => entry.node.id,
  );
};

describe('a real dependency chain', () => {
  it('reports the direct caller of a method', () => {
    // `verify` calls `repo.find(...)` through a constructed variable.
    const result = analyzer.analyze(FIND);

    expect(result?.directlyAffected.map((entry) => entry.node.id)).toContain(VERIFY);
  });

  it('reports the caller of the caller as INDIRECT', () => {
    const result = analyzer.analyze(FIND);

    expect(result?.indirectlyAffected.map((entry) => entry.node.id)).toContain(DO_LOGIN);
  });

  it('reaches three edges out, so the whole chain appears', () => {
    expect(affectedIds(FIND)).toContain(RETRY);
    expect(analyzer.analyze(FIND)?.statistics.maxDepth).toBeGreaterThanOrEqual(3);
  });

  it('records each node in the chain at its shortest distance', () => {
    const result = analyzer.analyze(FIND);
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];
    const depths = new Map(all.map((entry) => [entry.node.id, entry.depth]));

    expect(depths.get(VERIFY)).toBe(1);
    expect(depths.get(DO_LOGIN)).toBe(2);
    expect(depths.get(RETRY)).toBe(3);
  });

  it('reports no duplicate node however many paths reach it', () => {
    const ids = affectedIds(FIND);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('routes, types and externals over a real graph', () => {
  it('reports the route affected by a change deep in the chain', () => {
    const routes = analyzer.analyze(FIND)?.routesAffected;

    expect(routes?.map((entry) => entry.route.path)).toContain('/login');
  });

  it('names the node in the closure the route reaches', () => {
    const login = analyzer.analyze(FIND)?.routesAffected.find((entry) => entry.route.path === '/login');

    expect(login?.reaches).toBe(DO_LOGIN);
  });

  it('reports the environment variable read from inside the closure', () => {
    const variables = analyzer.analyze(FIND)?.environmentVariables;

    expect(variables?.map((entry) => entry.node.name)).toContain('JWT_SECRET');
  });

  it('reports externals imported by files the closure touches', () => {
    const externals = analyzer.analyze(FIND)?.externalDependencies.map((entry) => entry.node.id);

    expect(externals).toContain('ext:node:crypto');
  });

  it('reports type references to an interface as DIRECT', () => {
    const result = analyzer.analyze(SHAPE);

    expect(result?.typeReferences.length).toBeGreaterThan(0);
    expect(result?.directlyAffected.length).toBeGreaterThan(0);
  });

  it('reports the unresolved call inside the closure as UNKNOWN', () => {
    const unknown = analyzer.analyze(FIND)?.unknown;

    expect(unknown?.map((entry) => entry.result.reference.text)).toContain('missingHelper');
  });

  it('labels an unresolved relationship recorded at a declaration', () => {
    const helper = analyzer
      .analyze(FIND)
      ?.unknown.find((entry) => entry.result.reference.text === 'missingHelper');

    expect(helper).toMatchObject({ at: VERIFY, scope: 'declaration' });
  });
});

describe('what the result refuses to claim', () => {
  it('returns null for anything that is not a declaration', () => {
    for (const id of ['file:src/app.ts', 'route:POST:/login', 'ext:node:crypto']) {
      expect(analyzer.analyze(id as NodeId)).toBeNull();
    }
  });

  it('returns null for an identifier the graph does not contain', () => {
    expect(analyzer.analyze('sym:src/nowhere.ts#Absent' as NodeId)).toBeNull();
  });

  it('reports an orphan as affecting nothing, without inventing impact', () => {
    const result = analyzer.analyze(ORPHAN);

    expect(result?.directlyAffected.filter((entry) => entry.node.kind !== 'File')).toEqual([]);
    expect(result?.callers).toEqual([]);
    expect(result?.limitations.map((entry) => entry.code)).toContain('call-coverage-partial');
  });

  it('does not report the class that declares the target', () => {
    expect(affectedIds(FIND)).not.toContain('sym:src/user.repository.ts#UserRepository');
  });

  it('does not follow callees, so a change to verify does not implicate find', () => {
    expect(affectedIds(VERIFY)).not.toContain(FIND);
  });
});

describe('determinism and isolation over a real graph', () => {
  it('answers identically on repeated analysis', () => {
    expect(analyzer.analyze(FIND)).toEqual(analyzer.analyze(FIND));
  });

  it('orders affected nodes by depth', () => {
    const result = analyzer.analyze(FIND);
    const depths = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])].map(
      (entry) => entry.depth,
    );

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('returns plain data with no storage object attached', () => {
    const result = analyzer.analyze(FIND);

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('carries no connection, statement or database path anywhere in the result', () => {
    const serialised = JSON.stringify(analyzer.analyze(FIND));

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('sqlite');
  });

  it('reports every affected node with an edge that exists in the graph', () => {
    const result = analyzer.analyze(FIND);
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    for (const entry of all) {
      const incoming = api.getIncoming(entry.via.targetId);

      expect(incoming.map((item) => item.id)).toContain(entry.via.id);
    }
  });
});
