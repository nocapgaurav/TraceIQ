import { beforeEach, describe, expect, it } from 'vitest';

import { FakeGraph, edge, node, role } from './fake-graph.test-helper.js';
import { RepositoryExplorer } from './repository-explorer.js';
import { MATCH_MODES } from './types.js';

/** A repository whose names deliberately share prefixes, so prefix matching is exercised. */
function repository(): FakeGraph {
  const graph = new FakeGraph();

  graph
    .addNode(node({ id: 'file:src/auth/login.ts', kind: 'File' }))
    .addNode(node({ id: 'file:src/auth/logout.ts', kind: 'File' }))
    .addNode(node({ id: 'file:src/billing/invoice.ts', kind: 'File' }))
    .addNode(node({ id: 'sym:src/auth/login.ts#login', kind: 'Function', fileId: 'file:src/auth/login.ts' }))
    .addNode(node({ id: 'sym:src/auth/login.ts#loginTwice', kind: 'Function', fileId: 'file:src/auth/login.ts' }))
    .addNode(node({ id: 'sym:src/auth/logout.ts#logout', kind: 'Function', fileId: 'file:src/auth/logout.ts' }))
    .addNode(node({ id: 'sym:src/auth/login.ts#AuthService', kind: 'Class', fileId: 'file:src/auth/login.ts' }))
    .addNode(node({ id: 'sym:src/billing/invoice.ts#Invoice', kind: 'Interface', fileId: 'file:src/billing/invoice.ts' }))
    .addNode(node({ id: 'route:POST:/login', kind: 'Route' }))
    .addNode(node({ id: 'route:GET:/logout', kind: 'Route' }))
    .addNode(node({ id: 'env:LOG_LEVEL', kind: 'EnvironmentVariable', name: 'LOG_LEVEL' }))
    .addNode(node({ id: 'env:LOG_FORMAT', kind: 'EnvironmentVariable', name: 'LOG_FORMAT' }))
    .addNode(node({ id: 'ext:npm:express', kind: 'External', name: 'express', externalKind: 'npm', externalName: 'express' }))
    .addNode(node({ id: 'ext:npm:express-session', kind: 'External', name: 'express-session', externalKind: 'npm', externalName: 'express-session' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/auth/login.ts', targetId: 'sym:src/auth/login.ts#login' }));

  graph.addRole(role('sym:src/auth/login.ts#AuthService', 'Service'));

  return graph;
}

let explorer: RepositoryExplorer;

beforeEach(() => {
  explorer = new RepositoryExplorer(repository());
});

describe('prefix search', () => {
  it('is the default match mode', () => {
    expect(explorer.search({ text: 'log' }).match).toBe('prefix');
  });

  it('finds every declaration whose name starts with the term', () => {
    expect(explorer.search({ text: 'login' }).declarations.entries.map((entry) => entry.name)).toEqual([
      'login',
      'loginTwice',
    ]);
  });

  it('matches an identifier as well as a name', () => {
    expect(explorer.search({ text: 'sym:src/auth' }).declarations.total).toBe(4);
  });

  it('finds nothing for a term nothing starts with', () => {
    expect(explorer.search({ text: 'zzz' }).total).toBe(0);
  });
});

describe('exact search', () => {
  it('matches only the whole name', () => {
    expect(explorer.search({ text: 'login', match: 'exact' }).declarations.entries.map((entry) => entry.name)).toEqual([
      'login',
    ]);
  });

  it('finds nothing for a term that is only a prefix', () => {
    expect(explorer.search({ text: 'log', match: 'exact' }).total).toBe(0);
  });

  it('publishes both modes as a closed vocabulary', () => {
    expect(MATCH_MODES).toEqual(['prefix', 'exact']);
  });
});

describe('search by field', () => {
  it('searches by path, and a declaration matches on the file it lives in', () => {
    const results = explorer.search({ path: 'src/auth' });

    expect(results.files.entries.map((entry) => entry.id)).toEqual([
      'file:src/auth/login.ts',
      'file:src/auth/logout.ts',
    ]);
    expect(results.declarations.total).toBe(4);
  });

  it('searches by kind', () => {
    expect(explorer.search({ kind: 'Class' }).declarations.entries.map((entry) => entry.name)).toEqual([
      'AuthService',
    ]);
  });

  it('searches by role', () => {
    expect(explorer.search({ role: 'Service' }).declarations.entries.map((entry) => entry.name)).toEqual([
      'AuthService',
    ]);
  });

  it('searches routes by path', () => {
    expect(explorer.search({ route: '/log' }).routes.entries.map((entry) => entry.id)).toEqual([
      'route:GET:/logout',
      'route:POST:/login',
    ]);
  });

  it('searches routes by method', () => {
    expect(explorer.search({ route: 'POST' }).routes.entries.map((entry) => entry.id)).toEqual([
      'route:POST:/login',
    ]);
  });

  it('searches environment variables by name', () => {
    expect(explorer.search({ environmentVariable: 'LOG_' }).environmentVariables.entries.map((entry) => entry.name)).toEqual([
      'LOG_FORMAT',
      'LOG_LEVEL',
    ]);
  });

  it('searches external packages by package name, not by identity prefix', () => {
    expect(explorer.search({ externalPackage: 'express' }).externalPackages.entries.map((entry) => entry.name)).toEqual([
      'express',
      'express-session',
    ]);
  });

  it('finds one external package on an exact match', () => {
    expect(explorer.search({ externalPackage: 'express', match: 'exact' }).externalPackages.total).toBe(1);
  });
});

describe('combining filters', () => {
  it('requires every supplied filter to match', () => {
    expect(explorer.search({ text: 'login', kind: 'Class' }).declarations.total).toBe(0);
    expect(explorer.search({ text: 'Auth', kind: 'Class' }).declarations.total).toBe(1);
  });

  it('narrows by path and kind together', () => {
    expect(explorer.search({ path: 'src/auth', kind: 'Function' }).declarations.total).toBe(3);
    expect(explorer.search({ path: 'src/billing', kind: 'Function' }).declarations.total).toBe(0);
  });

  it('returns no declaration when a route filter is supplied, a declaration never being a route', () => {
    expect(explorer.search({ text: 'login', route: '/login' }).declarations.total).toBe(0);
    expect(explorer.search({ route: '/login' }).routes.total).toBe(1);
  });
});

describe('determinism and ordering', () => {
  it('orders every result list alphabetically by identifier', () => {
    const results = explorer.search({ text: 'l' });

    for (const group of [results.declarations, results.files, results.routes, results.environmentVariables]) {
      const ids = group.entries.map((entry) => entry.id);

      expect(ids).toEqual([...ids].sort());
    }
  });

  it('returns the same result for the same query', () => {
    expect(explorer.search({ text: 'log' })).toEqual(explorer.search({ text: 'log' }));
  });

  it('carries the query back on the result, so a response explains itself', () => {
    const query = { text: 'log', kind: 'Function' } as const;

    expect(explorer.search(query).query).toEqual(query);
  });

  it('totals every group', () => {
    const results = explorer.search({ text: 'log' });

    expect(results.total).toBe(
      results.declarations.total +
        results.files.total +
        results.routes.total +
        results.environmentVariables.total +
        results.externalPackages.total,
    );
  });

  it('matches nothing for an empty query rather than returning the repository', () => {
    expect(explorer.search({}).total).toBe(0);
  });

  it('is case-sensitive, one rule rather than two', () => {
    expect(explorer.search({ text: 'LOGIN' }).declarations.total).toBe(0);
    expect(explorer.search({ text: 'login' }).declarations.total).toBe(2);
  });

  it('carries no score or rank on any result', () => {
    const results = explorer.search({ text: 'log' });

    expect(results).not.toHaveProperty('scores');

    for (const entry of results.declarations.entries) {
      expect(entry).not.toHaveProperty('score');
      expect(entry).not.toHaveProperty('rank');
    }
  });
});
