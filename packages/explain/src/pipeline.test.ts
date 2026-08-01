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

import { SymbolExplainer } from './symbol-explainer.js';

/**
 * Explain Symbol against a real graph, produced by the whole pipeline.
 *
 * The unit suite runs against a stub `ExplainSymbolQueries` and proves assembly needs no
 * Query Engine, no graph and no database. This one runs scanner → host → IR → resolver →
 * call graph → framework → graph builder → SQLite → Graph API → Query Engine → explainer and
 * asks the same questions, so a passing unit test cannot be an artefact of the stub.
 *
 * Everything below `@traceiq/query` is a **dev** dependency: it appears here to build a
 * fixture, and nothing in `src/` outside a test imports it.
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
import type { Shape } from './shape';
export class AuthService {
  verify(): string | undefined {
    const repo = new UserRepository();
    repo.find(randomUUID());
    lookup();
    missingHelper();
    return process.env.JWT_SECRET;
  }
  shape(): Shape | undefined { return undefined; }
}
function lookup(): void {}
`,
  'src/user.repository.ts': `export class UserRepository {
  find(id: string): string { return id; }
}
`,
  'src/shape.ts': `export interface Shape { a: string }
`,
};

const VERIFY = 'sym:src/auth.service.ts#AuthService.verify' as NodeId;
const SERVICE = 'sym:src/auth.service.ts#AuthService' as NodeId;
const DO_LOGIN = 'sym:src/auth.routes.ts#doLogin' as NodeId;

let root: string;
let api: SqliteGraphApi;
let explainer: SymbolExplainer;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-explain-'));

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
    name: 'explain-fixture',
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
  explainer = new SymbolExplainer(new QueryEngine(api));
});

afterAll(async () => {
  api.close();
  await rm(root, { recursive: true, force: true });
});

describe('explaining a method in a real repository', () => {
  it('reports the declaration, its kind and its file', () => {
    const result = explainer.explain(VERIFY);

    expect(result?.kind).toBe('Method');
    expect(result?.sourceFile).toEqual({
      id: 'file:src/auth.service.ts',
      path: 'src/auth.service.ts',
    });
    expect(result?.locations[0]?.startLine).toBeGreaterThan(0);
  });

  it('reports the class that declares it', () => {
    const result = explainer.explain(VERIFY);

    expect(result?.enclosingDeclaration?.declaration?.id).toBe(SERVICE);
    expect(result?.enclosingDeclaration?.edge.type).toBe('DECLARES');
  });

  it('reports what calls it', () => {
    // `doLogin` calls `service.verify()` through a constructed variable, which binds only
    // because of the IR Expansion.
    const callers = explainer.explain(VERIFY)?.incomingCalls.map((entry) => entry.edge.sourceId);

    expect(callers).toContain(DO_LOGIN);
  });

  it('reports what it calls', () => {
    const callees = explainer.explain(VERIFY)?.outgoingCalls.map((entry) => entry.target?.id);

    expect(callees).toContain('sym:src/user.repository.ts#UserRepository.find');
    expect(callees).toContain('sym:src/auth.service.ts#lookup');
  });

  it('reports the environment variable it reads, and only that one', () => {
    const variables = explainer.explain(VERIFY)?.environmentVariables;

    expect(variables?.map((entry) => entry.node.name)).toEqual(['JWT_SECRET']);
    expect(variables?.[0]?.reads.every((read) => read.edge.sourceId === VERIFY)).toBe(true);
  });

  it('reports the externals its file imports', () => {
    const externals = explainer.explain(VERIFY)?.externalDependencies.map((entry) => entry.node.id);

    expect(externals).toContain('ext:node:crypto');
  });

  it('reports the call it makes that could not be bound', () => {
    const own = explainer
      .explain(VERIFY)
      ?.unresolved.filter((entry) => entry.scope === 'declaration');

    expect(own?.map((entry) => entry.result.reference.text)).toContain('missingHelper');
  });

  it('reports references, with calls and type references as subsets', () => {
    const result = explainer.explain(VERIFY);

    for (const entry of [...(result?.incomingCalls ?? []), ...(result?.typeReferences ?? [])]) {
      expect(result?.references).toContain(entry);
    }
  });

  it('carries confidence and provenance from the graph', () => {
    const result = explainer.explain(VERIFY);

    expect(['CERTAIN', 'RESOLVED', 'INFERRED', 'AMBIGUOUS']).toContain(result?.confidence);
    expect(result?.provenance.producer.length).toBeGreaterThan(0);
  });
});

describe('explaining a route handler in a real repository', () => {
  it('reports the route whose chain reaches it, and where in the chain it sits', () => {
    const routes = explainer.explain(DO_LOGIN)?.routes;

    expect(routes?.map((entry) => entry.explanation.route.path)).toEqual(['/login']);
    expect(routes?.[0]?.position).toBe('handler');
  });

  it('reports the middleware ahead of it', () => {
    const routes = explainer.explain(DO_LOGIN)?.routes;

    expect(routes?.[0]?.explanation.middleware.map((entry) => entry.declaration?.name)).toEqual([
      'requireAuth',
    ]);
  });

  it('reports that the route path could not be composed', () => {
    // `app.use('/api/auth', authRoutes)` means `/login` is really `/api/auth/login`, and
    // nothing in the graph records that prefix.
    const routes = explainer.explain(DO_LOGIN)?.routes;

    expect(routes?.[0]?.explanation.route.composition.composed).toBe(false);
    expect(explainer.explain(DO_LOGIN)?.limitations.map((entry) => entry.code)).toContain(
      'route-prefixes-not-composed',
    );
  });

  it('reports no route for a declaration no route reaches', () => {
    expect(explainer.explain(VERIFY)?.routes).toEqual([]);
  });
});

describe('what the result refuses to claim', () => {
  it('returns null for a file, which is not a declaration', () => {
    expect(explainer.explain('file:src/auth.service.ts' as NodeId)).toBeNull();
  });

  it('returns null for a route node', () => {
    expect(explainer.explain('route:POST:/login' as NodeId)).toBeNull();
  });

  it('returns null for an external', () => {
    expect(explainer.explain('ext:node:crypto' as NodeId)).toBeNull();
  });

  it('returns null for an identifier the graph does not contain', () => {
    expect(explainer.explain('sym:src/nowhere.ts#Absent' as NodeId)).toBeNull();
  });

  it('explains a declaration nothing refers to without inventing anything', () => {
    const shape = explainer.explain('sym:src/auth.service.ts#AuthService.shape' as NodeId);

    expect(shape?.incomingCalls).toEqual([]);
    expect(shape?.routes).toEqual([]);
    expect(shape?.environmentVariables).toEqual([]);
    // Still reports the general limitations, so an empty result is not read as a complete one.
    expect(shape?.limitations.map((entry) => entry.code)).toContain('call-coverage-partial');
  });
});

describe('determinism and storage isolation over a real graph', () => {
  it('answers identically on repeated reads', () => {
    expect(explainer.explain(VERIFY)).toEqual(explainer.explain(VERIFY));
  });

  it('returns plain data with no storage object attached', () => {
    const result = explainer.explain(VERIFY);

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('carries no connection, statement or database path anywhere in the result', () => {
    const serialised = JSON.stringify(explainer.explain(VERIFY));

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('sqlite');
  });
});
