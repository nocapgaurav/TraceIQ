import type { NodeId } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeGraph, edge, node, role, unresolved } from './fake-graph.test-helper.js';
import { RepositoryNavigator } from './repository-navigator.js';
import { routeIdOf } from './route-explanation.js';
import { CHAIN_POSITIONS, LIMITATION_CODES, SUBJECT_KINDS } from './types.js';

/**
 * A two-package Express-shaped repository, so routes, roles and chains are all real.
 *
 *   packages/api   routes.ts    requireAuth → getUser (a Controller), plus an unlinked handler
 *   packages/core  service.ts   UserService (a Service) → UserRepository (a Repository)
 *
 * with an environment variable read in the service, an external package, a mutual import cycle and
 * a route whose handler could not be linked.
 */
const ID = {
  apiFile: 'file:packages/api/src/routes.ts',
  coreFile: 'file:packages/core/src/service.ts',
  repoFile: 'file:packages/core/src/repository.ts',
  cycleA: 'file:packages/core/src/cycle.a.ts',
  cycleB: 'file:packages/core/src/cycle.b.ts',
  guard: 'sym:packages/api/src/routes.ts#requireAuth',
  getUser: 'sym:packages/api/src/routes.ts#getUser',
  service: 'sym:packages/core/src/service.ts#UserService',
  find: 'sym:packages/core/src/service.ts#UserService.find',
  repository: 'sym:packages/core/src/repository.ts#UserRepository',
  load: 'sym:packages/core/src/repository.ts#UserRepository.load',
  helperA: 'sym:packages/core/src/cycle.a.ts#helperA',
  helperB: 'sym:packages/core/src/cycle.b.ts#helperB',
  users: 'route:GET:/users/:id',
  health: 'route:GET:/health',
  unlinked: 'route:POST:/unlinked',
  secret: 'env:JWT_SECRET',
  express: 'ext:npm:express',
} as const;

function repository(): FakeGraph {
  const graph = new FakeGraph();

  graph
    .addNode(node({ id: ID.apiFile, kind: 'File' }))
    .addNode(node({ id: ID.coreFile, kind: 'File' }))
    .addNode(node({ id: ID.repoFile, kind: 'File' }))
    .addNode(node({ id: ID.cycleA, kind: 'File' }))
    .addNode(node({ id: ID.cycleB, kind: 'File' }))
    .addNode(node({ id: ID.guard, kind: 'Function', fileId: ID.apiFile, isExported: true }))
    .addNode(node({ id: ID.getUser, kind: 'Function', fileId: ID.apiFile, isExported: true }))
    .addNode(node({ id: ID.service, kind: 'Class', fileId: ID.coreFile, isExported: true }))
    .addNode(node({ id: ID.find, kind: 'Method', fileId: ID.coreFile }))
    .addNode(node({ id: ID.repository, kind: 'Class', fileId: ID.repoFile, isExported: true }))
    .addNode(node({ id: ID.load, kind: 'Method', fileId: ID.repoFile }))
    .addNode(node({ id: ID.helperA, kind: 'Function', fileId: ID.cycleA, isExported: true }))
    .addNode(node({ id: ID.helperB, kind: 'Function', fileId: ID.cycleB, isExported: true }))
    .addNode(node({ id: ID.users, kind: 'Route', fileId: ID.apiFile, name: 'GET /users/:id' }))
    .addNode(node({ id: ID.health, kind: 'Route', fileId: ID.apiFile, name: 'GET /health' }))
    .addNode(node({ id: ID.unlinked, kind: 'Route', fileId: ID.apiFile, name: 'POST /unlinked' }))
    .addNode(node({ id: ID.secret, kind: 'EnvironmentVariable', name: 'JWT_SECRET' }))
    .addNode(node({ id: ID.express, kind: 'External', name: 'express', externalKind: 'npm', externalName: 'express' }));

  graph
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.apiFile, targetId: ID.guard }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.apiFile, targetId: ID.getUser }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.coreFile, targetId: ID.service }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.service, targetId: ID.find }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.repoFile, targetId: ID.repository }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.repository, targetId: ID.load }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.cycleA, targetId: ID.helperA }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.cycleB, targetId: ID.helperB }))
    // Module wiring: api depends on core.
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.apiFile, targetId: ID.service, name: 'UserService' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.apiFile, targetId: ID.express, name: 'express' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.coreFile, targetId: ID.repository, name: 'UserRepository' }))
    .addEdge(edge({ type: 'EXPORTS', sourceId: ID.coreFile, targetId: ID.service, name: 'UserService' }))
    // A mutual import cycle inside core.
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.cycleA, targetId: ID.helperB, name: 'helperB' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.cycleB, targetId: ID.helperA, name: 'helperA' }))
    // The chain: getUser → UserService.find → UserRepository.load
    .addEdge(edge({ type: 'CALLS', sourceId: ID.getUser, targetId: ID.find, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.find, targetId: ID.load, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.helperA, targetId: ID.helperB, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.helperB, targetId: ID.helperA, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'REFERENCES_TYPE', sourceId: ID.getUser, targetId: ID.service }))
    // GET /users/:id runs requireAuth then getUser. GET /health has one handler.
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ID.users, targetId: ID.guard, ordinal: 0 }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ID.users, targetId: ID.getUser, ordinal: 1 }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ID.health, targetId: ID.guard, ordinal: 0 }))
    .addEdge(edge({ type: 'READS', sourceId: ID.find, targetId: ID.secret }));

  graph
    .addRole(role(ID.getUser, 'Controller'))
    .addRole(role(ID.service, 'Service'))
    .addRole(role(ID.repository, 'Repository'))
    .addRole(role(ID.guard, 'Middleware'));

  // POST /unlinked registers a handler nothing could link.
  graph.addUnresolved(unresolved({ type: 'HANDLED_BY', sourceId: ID.unlinked, text: 'controller.create' }));

  return graph;
}

let graph: FakeGraph;
let navigator: RepositoryNavigator;

beforeEach(() => {
  graph = repository();
  navigator = new RepositoryNavigator(graph);
});

const id = (value: string): NodeId => value as NodeId;

describe('route selection', () => {
  it('composes a route identifier from a method and a path', () => {
    expect(routeIdOf({ method: 'GET', path: '/users/:id' })).toBe('route:GET:/users/:id');
  });

  it('passes an identifier through unchanged', () => {
    expect(routeIdOf(id(ID.users))).toBe(ID.users);
  });

  it('explains a route named by method and path', () => {
    expect(navigator.explainRoute({ method: 'GET', path: '/users/:id' })?.route.path).toBe('/users/:id');
  });

  it('explains the same route named by identifier', () => {
    expect(navigator.explainRoute(id(ID.users))).toEqual(
      navigator.explainRoute({ method: 'GET', path: '/users/:id' }),
    );
  });

  it('returns null for a path the graph does not hold, rather than inventing it', () => {
    expect(navigator.explainRoute({ method: 'GET', path: '/nowhere' })).toBeNull();
    expect(navigator.explainRoute({ method: 'DELETE', path: '/users/:id' })).toBeNull();
  });

  it('returns null for an identifier that is not a route', () => {
    expect(navigator.explainRoute(id(ID.getUser))).toBeNull();
    expect(navigator.explainRoute(id(ID.apiFile))).toBeNull();
  });
});

describe('explainRoute', () => {
  it('reports the route, its method and its written path', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.method).toBe('GET');
    expect(view?.route).toMatchObject({ method: 'GET', path: '/users/:id', handlers: 2 });
  });

  it('reports the chain in running order, middleware first', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.chain.map((step) => step.declaration?.id)).toEqual([ID.guard, ID.getUser]);
    expect(view?.chain.map((step) => step.position)).toEqual(['middleware', 'handler']);
  });

  it('separates middleware from the final handler', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.middleware.map((step) => step.declaration?.id)).toEqual([ID.guard]);
    expect(view?.handler?.declaration?.id).toBe(ID.getUser);
  });

  it('carries the ordinal from the handler edge', () => {
    expect(navigator.explainRoute(id(ID.users))?.chain.map((step) => step.ordinal)).toEqual([0, 1]);
  });

  it('carries the whole Explain Symbol result for every handler', () => {
    const view = navigator.explainRoute(id(ID.users));

    for (const step of view?.chain ?? []) {
      expect(step.explain?.declaration.node.id).toBe(step.declaration?.id);
      expect(step.explain?.limitations.length).toBeGreaterThan(0);
    }
  });

  it('carries an impact and a health summary for every handler', () => {
    const step = navigator.explainRoute(id(ID.users))?.handler;

    expect(step?.impact).not.toBeNull();
    expect(step?.health?.isolated).toBe(false);
  });

  it('names the controller, service and repository the chain reaches', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.controllers.map((entry) => entry.ref.id)).toEqual([]);
    expect(view?.services.map((entry) => entry.ref.id)).toEqual([ID.service]);
    expect(view?.repositories.map((entry) => entry.ref.id)).toEqual([ID.repository]);
  });

  it('reports the distance to each role it reached', () => {
    const view = navigator.explainRoute(id(ID.users));

    // getUser → UserService.find is one step, and its container is reached with it.
    expect(view?.services[0]?.depth).toBeGreaterThan(0);
    expect(view?.repositories[0]?.depth).toBeGreaterThan(view?.services[0]?.depth ?? 0);
  });

  it('names the middleware role separately from the chain position', () => {
    // `requireAuth` is chain middleware; the Middleware role is a separate annotation.
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.middleware.map((step) => step.declaration?.id)).toEqual([ID.guard]);
    expect(view?.middlewareRoles.map((entry) => entry.ref.id)).not.toContain(ID.guard);
  });

  it('reports an environment variable read through the service the route calls', () => {
    // JWT_SECRET is read by UserService.find, which the handler reaches rather than reads itself.
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.environmentVariables.entries.map((entry) => entry.id)).toEqual([ID.secret]);
    expect(view?.dependencies.entries.map((entry) => entry.ref.id)).toContain(ID.find);
  });

  it('reports no environment variable for a route whose reach reads none', () => {
    expect(navigator.explainRoute(id(ID.health))?.environmentVariables.entries).toEqual([]);
  });

  it('reports the external packages the chain files import', () => {
    expect(navigator.explainRoute(id(ID.users))?.externalPackages.entries.map((entry) => entry.id)).toEqual([
      ID.express,
    ]);
  });

  it('summarises the call graph around the chain', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.callGraph.callees).toBeGreaterThan(0);
    expect(view?.callGraph.reached).toBeGreaterThan(0);
    expect(view?.callGraph.maxDepth).toBeGreaterThan(0);
  });

  it('summarises health across the chain', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.health).toMatchObject({ handlersLinked: 2, handlersUnlinked: 0, recursiveHandlers: 0 });
  });

  it('reports a route with a single handler and no middleware', () => {
    const view = navigator.explainRoute(id(ID.health));

    expect(view?.middleware).toEqual([]);
    expect(view?.handler?.declaration?.id).toBe(ID.guard);
  });

  it('reports a handler that could not be linked rather than omitting it', () => {
    const view = navigator.explainRoute(id(ID.unlinked));

    expect(view?.handler).toBeNull();
    expect(view?.unresolvedHandlers.map((entry) => entry.text)).toEqual(['controller.create']);
    expect(view?.health.handlersUnlinked).toBe(1);
  });

  it('states explicitly that prefix composition is unsupported', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.pathComposition.composed).toBe(false);
    expect(view?.route.effectivePath).toBe('/users/:id');
    expect(view?.limitations.map((entry) => entry.code)).toContain('route-prefix-composition-unsupported');
  });

  it('never reports a path the graph does not state', () => {
    const view = navigator.explainRoute(id(ID.users));

    expect(view?.route.effectivePath).toBe(view?.route.path);
  });

  it('states that role reach follows coupling', () => {
    expect(navigator.explainRoute(id(ID.users))?.limitations.map((entry) => entry.code)).toContain(
      'role-reach-follows-coupling',
    );
  });

  it('publishes both chain positions as a closed vocabulary', () => {
    expect(CHAIN_POSITIONS).toEqual(['middleware', 'handler']);
  });
});

describe('routes', () => {
  it('lists every route the graph holds', () => {
    expect(navigator.routes().entries.map((entry) => entry.route.id).sort()).toEqual(
      [ID.health, ID.unlinked, ID.users].sort(),
    );
  });

  it('reports each route composition state', () => {
    expect(navigator.routes().entries.every((entry) => entry.composed === false)).toBe(true);
  });

  it('counts the handlers on each route', () => {
    const users = navigator.routes().entries.find((entry) => entry.route.id === ID.users);

    expect(users?.handlers).toBe(2);
  });
});

describe('architecture navigation', () => {
  it('uses the explorer grouping to build the trees without re-emitting it', () => {
    const view = navigator.architecture();
    const services = view.architectureTree.entries.find((group) => group.group === 'Service');

    expect(services?.entries.entries.map((entry) => entry.id)).toEqual([ID.service]);
    // The explorer's own ArchitectureView is not embedded: the trees already carry it.
    expect(view).not.toHaveProperty('groups');
  });

  it('carries the package summaries from Repository Explorer', () => {
    expect(navigator.architecture().packages.entries.map((entry) => entry.name)).toEqual([
      'packages/api',
      'packages/core',
    ]);
  });

  it('builds an architecture tree with roles before kinds', () => {
    const groups = navigator.architecture().architectureTree.entries;
    const categories = groups.map((group) => group.category);

    expect(categories.indexOf('role')).toBeLessThan(categories.indexOf('kind'));
    expect(groups.map((group) => group.group)).toContain('Service');
    expect(groups.map((group) => group.group)).toContain('Class');
  });

  it('omits an architecture group with no members', () => {
    expect(navigator.architecture().architectureTree.entries.map((group) => group.group)).not.toContain('Model');
  });

  it('builds a package tree of package to file to declaration', () => {
    const core = navigator.architecture().packageTree.entries.find((entry) => entry.name === 'packages/core');

    expect(core?.files.total).toBe(4);

    const serviceFile = core?.files.entries.find((entry) => entry.file.id === ID.coreFile);

    expect(serviceFile?.declarations.entries.map((entry) => entry.id)).toEqual([ID.service, ID.find].sort());
  });

  it('builds a role tree grouping each role by package', () => {
    const services = navigator.architecture().roleTree.entries.find((entry) => entry.role === 'Service');

    expect(services?.total).toBe(1);
    expect(services?.packages.entries.map((entry) => entry.name)).toEqual(['packages/core']);
  });

  it('omits a role with no members from the role tree', () => {
    expect(navigator.architecture().roleTree.entries.map((entry) => entry.role)).not.toContain('Model');
  });

  it('builds a dependency tree of package to package with edge counts', () => {
    const api = navigator.architecture().dependencyTree.entries.find((entry) => entry.name === 'packages/api');

    expect(api?.dependsOn.entries).toEqual([{ name: 'packages/core', edges: 1 }]);

    const core = navigator.architecture().dependencyTree.entries.find((entry) => entry.name === 'packages/core');

    expect(core?.dependedOnBy.entries.map((entry) => entry.name)).toEqual(['packages/api']);
  });

  it('carries a tree reference rather than a whole node', () => {
    const group = navigator.architecture().architectureTree.entries[0];

    expect(Object.keys(group?.entries.entries[0] ?? {}).sort()).toEqual(['id', 'kind', 'name']);
  });

  it('states that roles are judgements and the package boundary derived', () => {
    const codes = navigator.architecture().limitations.map((entry) => entry.code);

    expect(codes).toContain('roles-are-judgements');
    expect(codes).toContain('package-boundary-is-derived-from-paths');
  });
});

describe('dependency navigation', () => {
  it('publishes every subject kind as a closed vocabulary', () => {
    expect(SUBJECT_KINDS).toEqual(['package', 'file', 'declaration', 'route']);
  });

  it('navigates a declaration', () => {
    const view = navigator.dependencies(id(ID.find));

    expect(view?.subject).toMatchObject({ kind: 'declaration', id: ID.find });
    expect(view?.callGraph.outgoing.entries.map((entry) => entry.targetId)).toEqual([ID.load]);
    expect(view?.callGraph.incoming.entries.map((entry) => entry.sourceId)).toEqual([ID.getUser]);
  });

  it('navigates a file', () => {
    const view = navigator.dependencies(id(ID.apiFile));

    expect(view?.subject).toMatchObject({ kind: 'file', id: ID.apiFile });
    expect(view?.importGraph.outgoing.total).toBe(2);
  });

  it('navigates a package, covering its files', () => {
    const view = navigator.dependencies({ package: 'packages/core' });

    expect(view?.subject).toMatchObject({ kind: 'package', id: null, name: 'packages/core' });
    expect(view?.subject.files.total).toBe(4);
  });

  it('navigates a route, covering its handlers', () => {
    const view = navigator.dependencies(id(ID.users));

    expect(view?.subject).toMatchObject({ kind: 'route', id: ID.users });
    expect(view?.subject.files.entries.map((entry) => entry.id)).toEqual([ID.apiFile]);
    expect(view?.callGraph.outgoing.entries.map((entry) => entry.targetId)).toEqual([ID.find]);
  });

  it('returns null for a subject the graph does not hold', () => {
    expect(navigator.dependencies(id('sym:nowhere.ts#Absent'))).toBeNull();
    expect(navigator.dependencies({ package: 'packages/nowhere' })).toBeNull();
  });

  it('separates the import, reference and call graphs', () => {
    const view = navigator.dependencies(id(ID.getUser));

    expect(view?.callGraph.outgoing.entries.every((entry) => entry.type === 'CALLS')).toBe(true);
    expect(view?.referenceGraph.outgoing.entries.every((entry) => entry.type === 'REFERENCES_TYPE')).toBe(true);
    expect(view?.importGraph.outgoing.total).toBe(0);
  });

  it('reports both closures with shortest depth', () => {
    const view = navigator.dependencies(id(ID.getUser));

    expect(view?.closure.entries.find((entry) => entry.node.id === ID.find)?.depth).toBe(1);
    expect(view?.closure.entries.find((entry) => entry.node.id === ID.load)?.depth).toBe(2);
  });

  it('reports the reverse closure', () => {
    expect(navigator.dependencies(id(ID.load))?.reverseClosure.entries.map((entry) => entry.node.id)).toContain(
      ID.getUser,
    );
  });

  it('merges a package closure across its files, keeping the shortest depth', () => {
    const view = navigator.dependencies({ package: 'packages/core' });
    const depths = view?.closure.entries.map((entry) => entry.depth) ?? [];

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('reports the cycles a subject takes part in, once each', () => {
    const view = navigator.dependencies({ package: 'packages/core' });
    const keys = view?.cycles.map((cycle) => cycle.nodes.map((entry) => entry.id).join(',')) ?? [];

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports no cycle for a subject in none', () => {
    expect(navigator.dependencies(id(ID.load))?.cycles).toEqual([]);
  });

  it('reports the connected component', () => {
    expect(navigator.dependencies(id(ID.find))?.connectedComponent.entries.map((entry) => entry.id)).toContain(
      ID.getUser,
    );
  });

  it('summarises impact and health', () => {
    const view = navigator.dependencies(id(ID.find));

    expect(view?.impact.directlyAffected).toBeGreaterThan(0);
    expect(view?.health.isolated).toBe(false);
    expect(view?.health.fanIn).toBeGreaterThan(0);
  });

  it('reports a file subject health from the file view, having no symbol view', () => {
    const view = navigator.dependencies(id(ID.apiFile));

    expect(view?.health.fanOut).toBeGreaterThan(0);
  });
});

describe('reuse', () => {
  it('reads nothing further once every operation has run once', () => {
    navigator.architecture();
    navigator.routes();
    navigator.explainRoute(id(ID.users));
    navigator.dependencies(id(ID.find));

    const afterFirstPass = graph.totalCalls;

    navigator.architecture();
    navigator.routes();
    navigator.explainRoute(id(ID.users));
    navigator.dependencies(id(ID.find));

    expect(graph.totalCalls).toBe(afterFirstPass);
  });

  it('builds only one whole-graph index, inside Repository Explorer', () => {
    navigator.architecture();

    // Sixteen node kinds and thirteen relationship types, read once each — not twice.
    expect(graph.calls.getNodes).toBe(16);
    expect(graph.calls.getEdges).toBe(13);
  });

  it('reports how much of an operation came from reuse', () => {
    const profiled = navigator.profile('explainRoute', (inner) => inner.explainRoute(id(ID.users)));

    expect(profiled.profile.explorerCalls).toBeGreaterThan(0);
    expect(profiled.profile.queryEngineCalls).toBeGreaterThan(0);
  });

  it('answers a second identical operation without touching the database', () => {
    navigator.explainRoute(id(ID.users));

    const again = navigator.profile('explainRoute', (inner) => inner.explainRoute(id(ID.users)));

    expect(again.profile.graphApiCalls).toBe(0);
    expect(again.profile.cacheHits).toBeGreaterThan(0);
  });

  it('reports no timing, which would differ between runs', () => {
    const profiled = navigator.profile('architecture', (inner) => inner.architecture());

    expect(profiled.profile).not.toHaveProperty('elapsedMs');
    expect(profiled.profile.largestResult.entries).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('answers identically on repeated calls', () => {
    expect(navigator.architecture()).toEqual(navigator.architecture());
    expect(navigator.explainRoute(id(ID.users))).toEqual(navigator.explainRoute(id(ID.users)));
    expect(navigator.dependencies(id(ID.find))).toEqual(navigator.dependencies(id(ID.find)));
    expect(navigator.routes()).toEqual(navigator.routes());
  });

  it('answers identically from a second navigator over the same graph', () => {
    const other = new RepositoryNavigator(repository());

    expect(other.architecture()).toEqual(navigator.architecture());
    expect(other.explainRoute(id(ID.users))).toEqual(navigator.explainRoute(id(ID.users)));
  });

  it('produces plain data that survives a JSON round trip', () => {
    for (const result of [
      navigator.architecture(),
      navigator.routes(),
      navigator.explainRoute(id(ID.users)),
      navigator.dependencies({ package: 'packages/core' }),
    ]) {
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it('orders every tree deterministically', () => {
    const names = navigator.architecture().packageTree.entries.map((entry) => entry.name);

    expect(names).toEqual([...names].sort());
  });

  it('uses only limitation codes from the closed vocabulary, with fixed text', () => {
    for (const entry of navigator.explainRoute(id(ID.users))?.limitations ?? []) {
      expect(LIMITATION_CODES).toContain(entry.code);
      expect(entry.detail).not.toMatch(/\d/);
    }
  });

  it('carries no score or rank anywhere in a response', () => {
    const serialised = JSON.stringify(navigator.architecture());

    expect(serialised).not.toContain('"score"');
    expect(serialised).not.toContain('"rank"');
  });
});

describe('unusual repositories', () => {
  it('navigates an empty repository without failing', () => {
    const empty = new RepositoryNavigator(new FakeGraph());

    expect(empty.routes().entries).toEqual([]);
    expect(empty.architecture().packageTree.entries).toEqual([]);
    expect(empty.architecture().architectureTree.entries).toEqual([]);
    expect(empty.explainRoute({ method: 'GET', path: '/x' })).toBeNull();
    expect(empty.dependencies({ package: 'nothing' })).toBeNull();
  });

  it('navigates a repository with no routes at all', () => {
    const noRoutes = new FakeGraph()
      .addNode(node({ id: 'file:src/a.ts', kind: 'File' }))
      .addNode(node({ id: 'sym:src/a.ts#only', kind: 'Function', fileId: 'file:src/a.ts' }));
    const view = new RepositoryNavigator(noRoutes);

    expect(view.routes().entries).toEqual([]);
    expect(view.architecture().roleTree.entries).toEqual([]);
    expect(view.dependencies(id('sym:src/a.ts#only'))?.health.isolated).toBe(true);
  });

  it('navigates a route whose whole chain is unlinked', () => {
    const view = navigator.explainRoute(id(ID.unlinked));

    expect(view?.chain).toEqual([]);
    expect(view?.services).toEqual([]);
    expect(view?.callGraph.reached).toBe(0);
    expect(view?.health.handlersLinked).toBe(0);
  });

  it('navigates a single-package repository', () => {
    const single = new FakeGraph()
      .addNode(node({ id: 'file:index.ts', kind: 'File' }))
      .addNode(node({ id: 'sym:index.ts#main', kind: 'Function', fileId: 'file:index.ts' }));

    expect(new RepositoryNavigator(single).architecture().packageTree.entries.map((entry) => entry.name)).toEqual([
      'index.ts',
    ]);
  });
});

describe('large repositories and monorepos', () => {
  it('navigates a monorepo of many packages', () => {
    const large = new FakeGraph();
    const packages = 12;
    const filesPer = 5;
    const declsPer = 20;

    for (let pkg = 0; pkg < packages; pkg += 1) {
      for (let file = 0; file < filesPer; file += 1) {
        const filePath = `file:packages/p${pkg}/src/f${file}.ts`;

        large.addNode(node({ id: filePath, kind: 'File' }));

        for (let index = 0; index < declsPer; index += 1) {
          const symbol = `sym:packages/p${pkg}/src/f${file}.ts#d${index}`;

          large.addNode(node({ id: symbol, kind: 'Function', fileId: filePath, isExported: true }));
          large.addEdge(edge({ type: 'DECLARES', sourceId: filePath, targetId: symbol }));

          if (index > 0) {
            large.addEdge(
              edge({
                type: 'CALLS',
                sourceId: `sym:packages/p${pkg}/src/f${file}.ts#d${index - 1}`,
                targetId: symbol,
              }),
            );
          }
        }

        // Each package imports the next, so the dependency tree has real edges.
        large.addEdge(
          edge({
            type: 'IMPORTS',
            sourceId: filePath,
            targetId: `sym:packages/p${(pkg + 1) % packages}/src/f0.ts#d0`,
          }),
        );
      }
    }

    const big = new RepositoryNavigator(large);
    const architecture = big.architecture();

    expect(architecture.packageTree.total).toBe(packages);
    expect(architecture.dependencyTree.entries.every((entry) => entry.dependsOn.total > 0)).toBe(true);

    // Every package imports the next in a ring, so every package is depended on.
    expect(architecture.dependencyTree.entries.every((entry) => entry.dependedOnBy.total > 0)).toBe(true);

    const pkg = big.dependencies({ package: 'packages/p0' });

    expect(pkg?.subject.files.total).toBe(filesPer);
    expect(pkg?.closure.total).toBeGreaterThan(0);
  });

  it('reports a role true total even where the grouping is capped', () => {
    const large = new FakeGraph().addNode(node({ id: 'file:src/big.ts', kind: 'File' }));

    for (let index = 0; index < 150; index += 1) {
      const symbol = `sym:src/big.ts#d${index}`;

      large.addNode(node({ id: symbol, kind: 'Function', fileId: 'file:src/big.ts' }));
      large.addRole(role(symbol, 'Service'));
    }

    const services = new RepositoryNavigator(large)
      .architecture()
      .roleTree.entries.find((entry) => entry.role === 'Service');

    expect(services?.total).toBe(150);
  });

  it('caps every list in a large response and says so', () => {
    const large = new FakeGraph().addNode(node({ id: 'file:src/big.ts', kind: 'File' }));

    for (let index = 0; index < 400; index += 1) {
      large.addNode(node({ id: `sym:src/big.ts#d${index}`, kind: 'Function', fileId: 'file:src/big.ts' }));
    }

    const architecture = new RepositoryNavigator(large).architecture();
    const functions = architecture.architectureTree.entries.find((group) => group.group === 'Function');

    expect(functions?.entries.total).toBe(400);
    expect(functions?.entries.entries.length).toBe(100);
    expect(functions?.entries.truncated).toBe(true);
  });
});
