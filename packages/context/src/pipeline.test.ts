import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SymbolExplainer } from '@traceiq/explain';
import { CachingGraph, RepositoryExplorer } from '@traceiq/explorer';
import { RepositoryHealthAnalyzer } from '@traceiq/health';
import { ImpactAnalyzer } from '@traceiq/impact';
import { RepositoryPipeline, type RepositorySession } from '@traceiq/pipeline';
import { QueryEngine } from '@traceiq/query';
import type { NodeId } from '@traceiq/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ContextCapabilities } from './capabilities.js';
import { ContextNotFoundError, RepositoryContextBuilder } from './repository-context-builder.js';

/**
 * The builder over a real repository, composed from real capabilities.
 *
 * The unit suite runs against fabricated answers and proves the package reaches nothing. This one scans
 * a real project through `@traceiq/pipeline` and wires the five real capabilities over one shared graph,
 * so a passing unit test cannot be an artefact of the fakes.
 *
 * `@traceiq/pipeline` and everything under it are **dev** dependencies: they appear here to build a
 * fixture, and nothing in `src/` outside a test imports them.
 */
const FILES = {
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { UserService } from '../../core/src/service';
const router = Router();
const service = new UserService();
router.get('/users/:id', requireAuth, getUser);
export function requireAuth(): void {}
export function getUser(): string | undefined { return service.find('1'); }
export default router;
`,
  'packages/core/src/service.ts': `import { helper } from './cycle.a';
export class UserService {
  find(id: string): string | undefined {
    helper();
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
};

const FIND = 'sym:packages/core/src/service.ts#UserService.find' as NodeId;
const SERVICE = 'sym:packages/core/src/service.ts#UserService' as NodeId;
const HELPER = 'sym:packages/core/src/cycle.a.ts#helper' as NodeId;

let root: string;
let session: RepositorySession;
let builder: RepositoryContextBuilder;
let capabilities: ContextCapabilities;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-context-'));

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

  const pipeline = new RepositoryPipeline();
  const databasePath = path.join(root, 'graph.db');

  await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

  session = pipeline.open(databasePath);

  // One shared graph, so the five capabilities read the database once between them.
  const graph = new CachingGraph(session.api);
  const queries = new QueryEngine(graph);

  capabilities = {
    explorer: new RepositoryExplorer(graph),
    explain: new SymbolExplainer(queries),
    impact: new ImpactAnalyzer(queries),
    health: new RepositoryHealthAnalyzer(graph),
    queries,
  };

  builder = new RepositoryContextBuilder(capabilities);
}, 60_000);

afterAll(async () => {
  session.close();
  await rm(root, { recursive: true, force: true });
});

describe('symbol context over a real repository', () => {
  it('composes the explorer view, its explanation and its summaries', () => {
    const context = builder.build({ kind: 'symbol', id: FIND });

    expect(context.kind).toBe('symbol');
    expect(context.primary.type).toBe('symbol');

    const view = context.primary.type === 'symbol' ? context.primary.value : null;

    expect(view?.explain.declaration.node.id).toBe(FIND);
    expect(view?.explain.kind).toBe('Method');
  });

  it('names the enclosing class among the related nodes', () => {
    const context = builder.build({ kind: 'symbol', id: FIND });
    const enclosing = context.related.find((entry) => entry.relation === 'enclosing');

    expect(enclosing?.node.id).toBe(SERVICE);
  });

  it('carries the environment variable the declaration reads', () => {
    const context = builder.build({ kind: 'symbol', id: FIND });

    expect(context.dependencies.environmentVariables.map((entry) => entry.name)).toContain('JWT_SECRET');
  });

  it('costs four capability calls, two of them the reads every kind now makes', () => {
    expect(builder.build({ kind: 'symbol', id: FIND }).statistics.capabilityCalls).toEqual({
      'explorer.browseSymbol': 1,
      'explorer.dependencies': 1,
      'queries.capabilities': 1,
      'queries.technologies': 1,
    });
  });

  it('throws for a declaration the repository does not hold', () => {
    expect(() => builder.build({ kind: 'symbol', id: 'sym:nowhere.ts#Absent' as NodeId })).toThrowError(
      ContextNotFoundError,
    );
  });
});

describe('impact context over a real repository', () => {
  it('carries the analysis and explains the nearest affected declarations', () => {
    const context = builder.build({ kind: 'impact', id: HELPER });

    expect(context.impact.analysis?.target.node.id).toBe(HELPER);
    expect(context.related.length).toBeGreaterThan(0);
    expect(context.statistics.explainedNodes).toBeGreaterThan(0);
  });

  it('explains only declarations, never a file', () => {
    const context = builder.build({ kind: 'impact', id: HELPER });

    for (const entry of context.related) {
      if (entry.node.kind === 'File') {
        expect(entry.explain).toBeNull();
      }
    }
  });

  it('keeps every affected node listed even where explanations are capped', () => {
    const context = builder.build({ kind: 'impact', id: HELPER });
    const analysis = context.impact.analysis;
    const affected = (analysis?.directlyAffected.length ?? 0) + (analysis?.indirectlyAffected.length ?? 0);

    expect(context.related.length).toBe(Math.min(affected, 100));
  });
});

describe('file context over a real repository', () => {
  it('lists the declarations and reports the file condition', () => {
    const context = builder.build({ kind: 'file', path: 'packages/core/src/service.ts' });

    expect(context.related.map((entry) => entry.node.id)).toContain(SERVICE);
    expect(context.health.subject).not.toBeNull();
    expect(context.health.subject?.recursive).toBe(false);
  });

  it('reports the file as taking part in a cycle where it does', () => {
    const context = builder.build({ kind: 'file', path: 'packages/core/src/cycle.a.ts' });

    expect(context.health.subject?.inCycle).toBe(true);
  });

  it('throws for a file the repository does not hold', () => {
    expect(() => builder.build({ kind: 'file', path: 'nowhere.ts' })).toThrowError(ContextNotFoundError);
  });
});

describe('package context over a real repository', () => {
  it('carries the package view and the health report', () => {
    const context = builder.build({ kind: 'package', name: 'packages/core' });

    expect(context.primary.type).toBe('package');
    expect(context.health.report?.summary.files).toBeGreaterThan(0);
    expect(context.related.length).toBeGreaterThan(0);
  });

  it('throws for a package the repository does not hold', () => {
    expect(() => builder.build({ kind: 'package', name: 'packages/nowhere' })).toThrowError(ContextNotFoundError);
  });
});

describe('route context over a real repository', () => {
  it('composes the chain, explains the handlers and analyses their impact', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });

    expect(context.kind).toBe('route');
    expect(context.related.map((entry) => entry.relation).sort()).toEqual(['handler', 'middleware']);
    expect(context.statistics.explainedNodes).toBe(2);
    expect(context.impact.summary).not.toBeNull();
  });

  it('reports that the route prefix could not be composed', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });
    const route = context.primary.type === 'route' ? context.primary.value : null;

    expect(route?.route.composition.composed).toBe(false);
  });

  it('throws for a route the repository does not register', () => {
    expect(() => builder.build({ kind: 'route', method: 'GET', path: '/nowhere' })).toThrowError(
      ContextNotFoundError,
    );
  });
});

describe('repository context over a real repository', () => {
  it('carries the overview, architecture, hotspots, cycles and health report', () => {
    const context = builder.build({ kind: 'repository' });
    const subject = context.primary.type === 'repository' ? context.primary.value : null;

    // The fixture's files plus the tsconfig.json it is written with: universal discovery
    // records every file, not only the analysable ones.
    expect(subject?.overview.repository.files).toBe(Object.keys(FILES).length + 1);
    expect(subject?.architecture.classes.total).toBeGreaterThan(0);
    expect(subject?.hotspots.fanIn.max).toBeGreaterThan(0);
    expect(context.dependencies.cycles?.totals.call).toBeGreaterThan(0);
    expect(context.health.report).not.toBeNull();
  });

  it('costs seven capability calls', () => {
    expect(builder.build({ kind: 'repository' }).statistics.totalCapabilityCalls).toBe(7);
  });
});

describe('search context over a real repository', () => {
  it('carries the results and explains the first few', () => {
    const context = builder.build({ kind: 'search', query: { text: 'helper' } });

    expect(context.primary.type).toBe('search');
    expect(context.related.length).toBeGreaterThan(0);
    expect(context.statistics.explainedNodes).toBeGreaterThan(0);
  });

  it('returns an empty context for a query that matches nothing, rather than throwing', () => {
    const context = builder.build({ kind: 'search', query: { text: 'zzzznothing' } });

    expect(context.related).toEqual([]);
    expect(context.statistics.explainedNodes).toBe(0);
  });
});

describe('determinism and reuse over a real repository', () => {
  it('builds an identical context on repeated calls', () => {
    for (const request of [
      { kind: 'symbol', id: FIND },
      { kind: 'impact', id: HELPER },
      { kind: 'file', path: 'packages/core/src/service.ts' },
      { kind: 'package', name: 'packages/core' },
      { kind: 'route', method: 'GET', path: '/users/:id' },
      { kind: 'repository' },
      { kind: 'search', query: { text: 'helper' } },
    ] as const) {
      const first = builder.build(request);
      const second = builder.build(request);

      expect(second, request.kind).toEqual(first);
    }
  }, 60_000);

  it('produces plain data with no storage object attached', () => {
    for (const request of [{ kind: 'symbol', id: FIND }, { kind: 'repository' }] as const) {
      const context = builder.build(request);

      expect(JSON.parse(JSON.stringify(context))).toEqual(context);
    }
  });

  it('carries no connection, statement or database path anywhere in a context', () => {
    const serialised = JSON.stringify([
      builder.build({ kind: 'symbol', id: FIND }),
      builder.build({ kind: 'repository' }),
    ]);

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain('sqlite');
  });

  it('builds an identical context from a second builder over the same capabilities', () => {
    const other = new RepositoryContextBuilder(capabilities);

    expect(other.build({ kind: 'symbol', id: FIND })).toEqual(builder.build({ kind: 'symbol', id: FIND }));
  });

  it('generates no prose, markdown or prompt from real data', () => {
    const serialised = JSON.stringify(builder.build({ kind: 'repository' }));

    for (const marker of ['```', 'You are', 'Please ', 'prompt']) {
      expect(serialised).not.toContain(marker);
    }
  });
});
