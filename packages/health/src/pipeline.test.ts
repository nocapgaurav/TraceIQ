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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RepositoryHealthAnalyzer } from './repository-health-analyzer.js';
import type { RepositoryHealthReport } from './types.js';

/**
 * Repository health against a real graph, produced by the whole pipeline.
 *
 * The unit suite runs against an in-memory `HealthGraph` and proves the analyser needs no database.
 * This one runs scanner → host → IR → resolver → call graph → framework → graph builder → SQLite →
 * Graph API → analyser, so a passing unit test cannot be an artefact of the fake.
 *
 * The fixture is deliberately unhealthy: a mutual-import cycle, a mutual-call cycle, a recursive
 * function, an orphan module nothing imports, an unread environment variable, a route with a
 * handler that cannot be linked, and an unresolved import.
 *
 * Everything below `@traceiq/graph-api` is a **dev** dependency, used only to build the fixture.
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
import { helper } from './cycle.a';
const router = Router();
const service = new AuthService();
const controller = { me() {} };
router.post('/login', requireAuth, doLogin);
router.get('/me', controller.me);
export function requireAuth(): void {}
export function doLogin(): string | undefined { helper(); return service.verify(); }
export default router;
`,
  'src/auth.service.ts': `import { UserRepository } from './user.repository';
export class AuthService {
  verify(): string | undefined {
    const repo = new UserRepository();
    repo.find('1');
    missingHelper();
    return process.env.JWT_SECRET;
  }
}
`,
  'src/user.repository.ts': `export class UserRepository {
  find(id: string): string { return this.normalise(id); }
  normalise(id: string): string { return id.trim(); }
}
export function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }
`,
  // A mutual import cycle, and a mutual call cycle inside it.
  'src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
  'src/orphan.ts': `export function nobodyImportsThis(): void {}
`,
  'src/broken.ts': `import missing from './nowhere';
export const value = missing;
export const unread = process.env.NEVER_READ_ELSEWHERE;
`,
};

let root: string;
let api: SqliteGraphApi;
let report: RepositoryHealthReport;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-health-'));

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
    name: 'health-fixture',
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
  report = new RepositoryHealthAnalyzer(api).analyze();
});

afterAll(async () => {
  api.close();
  await rm(root, { recursive: true, force: true });
});

describe('summary over a real graph', () => {
  it('counts the fixture files', () => {
    expect(report.summary.files).toBe(Object.keys(FILES).length);
  });

  it('counts real declarations, classes and functions', () => {
    expect(report.summary.declarations).toBeGreaterThan(10);
    expect(report.summary.classes).toBe(2);
    expect(report.summary.functions).toBeGreaterThanOrEqual(6);
  });

  it('counts the express package as an external', () => {
    expect(report.dependencyHealth.externalUsage.map((entry) => entry.node.id)).toContain('ext:npm:express');
  });

  it('reports graph totals matching what the database holds', () => {
    expect(report.summary.graph.nodes).toBeGreaterThan(0);
    expect(report.summary.graph.edges).toBeGreaterThan(0);
    expect(report.summary.graph.unresolvedReferences).toBeGreaterThan(0);
  });
});

describe('real architecture', () => {
  it('finds the roles the Framework Extractor attributed', () => {
    expect(report.architecture.roleCounts.Service).toBeGreaterThanOrEqual(1);
    expect(report.architecture.roleCounts.Repository).toBeGreaterThanOrEqual(1);
  });

  it('counts containment separately from references', () => {
    expect(report.architecture.relationshipCounts.DECLARES).toBe(report.summary.declarations);
  });
});

describe('real cycles', () => {
  it('finds the mutual call cycle between two modules', () => {
    const members = report.callGraphHealth.cycles.flatMap((cycle) => cycle.nodes.map((entry) => entry.id));

    expect(members).toContain('sym:src/cycle.a.ts#helper');
    expect(members).toContain('sym:src/cycle.b.ts#partner');
  });

  it('finds the recursive function', () => {
    expect(report.callGraphHealth.recursive.nodes.map((entry) => entry.id)).toContain(
      'sym:src/user.repository.ts#countdown',
    );
  });

  it('finds the mutual import cycle between the two files', () => {
    const cycle = report.findings.find((entry) => entry.code === 'file-in-import-cycle');
    const members = cycle?.nodes.map((entry) => entry.id) ?? [];

    expect(members).toContain('file:src/cycle.a.ts');
    expect(members).toContain('file:src/cycle.b.ts');
  });

  it('reports each cycle with the edges that form it', () => {
    for (const entry of report.findings.filter((item) => item.code === 'declaration-in-dependency-cycle')) {
      expect(entry.evidence.edges.length).toBeGreaterThan(0);
    }
  });
});

describe('real dependency health', () => {
  it('finds the exported declaration nothing imports', () => {
    const finding = report.findings.find((entry) => entry.code === 'exported-declaration-never-imported');

    expect(finding?.nodes.map((entry) => entry.id)).toContain('sym:src/orphan.ts#nobodyImportsThis');
  });

  it('does not report an exported declaration that is imported', () => {
    const finding = report.findings.find((entry) => entry.code === 'exported-declaration-never-imported');

    expect(finding?.nodes.map((entry) => entry.id)).not.toContain('sym:src/auth.service.ts#AuthService');
  });

  it('excludes containment from fan-in over a real graph', () => {
    // A method's container declares it; that must not make it look referenced.
    const method = report.dependencyHealth.mostReferenced.find(
      (entry) => entry.node.id === 'sym:src/user.repository.ts#UserRepository.normalise',
    );

    expect(method === undefined || method.fanIn <= 1).toBe(true);
  });
});

describe('real call graph health', () => {
  it('reports coverage between zero and one', () => {
    expect(report.callGraphHealth.coverage).toBeGreaterThan(0);
    expect(report.callGraphHealth.coverage).toBeLessThan(1);
  });

  it('breaks unresolved calls down by the call graph reasons', () => {
    const reasons = Object.keys(report.callGraphHealth.unresolvedByReason);

    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).toContain('root-not-bound');
  });

  it('finds call clusters', () => {
    expect(report.callGraphHealth.clusters.count).toBeGreaterThan(0);
    expect(report.callGraphHealth.clusters.largest).toBeGreaterThan(1);
  });
});

describe('real routing and environment', () => {
  it('finds the routes the fixture registers', () => {
    expect(report.routing.routes).toBe(2);
    expect(report.routing.byMethod).toMatchObject({ POST: 1, GET: 1 });
  });

  it('finds the route whose handler could not be linked', () => {
    // `controller.me` is a member expression, so nothing links it.
    expect(report.routing.unresolvedHandlers).toBeGreaterThan(0);
  });

  it('finds the environment variables the fixture reads', () => {
    const names = report.environment.used.map((entry) => entry.node.name);

    expect(names).toContain('JWT_SECRET');
  });

  it('counts every environment variable the graph holds', () => {
    expect(report.environment.variables).toBeGreaterThanOrEqual(2);
  });
});

describe('real analysis quality', () => {
  it('reports the unresolved import as limiting analysis', () => {
    const finding = report.findings.find((entry) => entry.code === 'unresolved-relationships-limit-analysis');

    expect(finding?.evidence.value).toBe(report.summary.graph.unresolvedReferences);
  });

  it('bounds call findings by the call graph confidence', () => {
    for (const entry of report.findings.filter((item) => item.category === 'CALL_GRAPH')) {
      expect(entry.confidence).toBe('INFERRED');
    }
  });

  it('carries the limitations that apply to a real repository', () => {
    const codes = report.limitations.map((entry) => entry.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'call-coverage-partial',
        'calls-are-inferred',
        'reference-absence-is-not-proof',
        'route-prefixes-not-composed',
      ]),
    );
  });
});

describe('one pass and determinism over a real graph', () => {
  it('reads the graph a fixed number of times', () => {
    // Sixteen node kinds, thirteen relationship types, one unresolved read, one role read per
    // declaration. Nothing scales with edges or findings.
    expect(report.statistics.graphApiCalls).toBe(16 + 13 + 1 + report.summary.declarations);
  });

  it('answers identically on repeated analysis', () => {
    expect(new RepositoryHealthAnalyzer(api).analyze()).toEqual(report);
  });

  it('returns plain data with no storage object attached', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('carries no connection, statement or database path anywhere in the report', () => {
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('sqlite');
  });

  it('reports every finding node as a node the database holds', () => {
    for (const entry of report.findings) {
      for (const graphNode of entry.nodes) {
        expect(api.exists(graphNode.id)).toBe(true);
      }
    }
  });
});
