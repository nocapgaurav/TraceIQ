import { NODE_KINDS } from '@traceiq/graph-api';
import { RELATIONSHIP_TYPES } from '@traceiq/types';
import type { NodeId } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeGraph, edge, node, role, unresolved } from './fake-graph.test-helper.js';
import { packageOf } from './explorer-context.js';
import { RepositoryExplorer } from './repository-explorer.js';
import { CYCLE_KINDS, LIMITATION_CODES } from './types.js';

/**
 * A two-package repository with something in every explorer view.
 *
 *   packages/api   routes.ts     handle, guard, a route with a duplicate registration
 *   packages/core  service.ts    Service{run,loop}, Shape, orphan, a call cycle, an env read
 *
 * plus a mutual import cycle between two core files, an inheritance pair, an external package,
 * an environment variable read twice and one never read, and unresolved references.
 */
const ID = {
  apiFile: 'file:packages/api/src/routes.ts',
  coreFile: 'file:packages/core/src/service.ts',
  cycleA: 'file:packages/core/src/cycle.a.ts',
  cycleB: 'file:packages/core/src/cycle.b.ts',
  service: 'sym:packages/core/src/service.ts#Service',
  run: 'sym:packages/core/src/service.ts#Service.run',
  loop: 'sym:packages/core/src/service.ts#Service.loop',
  shape: 'sym:packages/core/src/service.ts#Shape',
  orphan: 'sym:packages/core/src/service.ts#orphan',
  handle: 'sym:packages/api/src/routes.ts#handle',
  guard: 'sym:packages/api/src/routes.ts#guard',
  helperA: 'sym:packages/core/src/cycle.a.ts#helperA',
  helperB: 'sym:packages/core/src/cycle.b.ts#helperB',
  base: 'sym:packages/core/src/service.ts#Base',
  derived: 'sym:packages/core/src/service.ts#Derived',
  route: 'route:POST:/login',
  orphanRoute: 'route:GET:/orphan',
  secret: 'env:JWT_SECRET',
  unused: 'env:UNUSED',
  express: 'ext:npm:express',
} as const;

function repository(): FakeGraph {
  const graph = new FakeGraph();

  graph
    .addNode(node({ id: ID.apiFile, kind: 'File' }))
    .addNode(node({ id: ID.coreFile, kind: 'File' }))
    .addNode(node({ id: ID.cycleA, kind: 'File' }))
    .addNode(node({ id: ID.cycleB, kind: 'File' }))
    .addNode(node({ id: ID.service, kind: 'Class', fileId: ID.coreFile, isExported: true }))
    .addNode(node({ id: ID.run, kind: 'Method', fileId: ID.coreFile }))
    .addNode(node({ id: ID.loop, kind: 'Method', fileId: ID.coreFile }))
    .addNode(node({ id: ID.shape, kind: 'Interface', fileId: ID.coreFile, isExported: true }))
    .addNode(node({ id: ID.orphan, kind: 'Function', fileId: ID.coreFile, isExported: true }))
    .addNode(node({ id: ID.base, kind: 'Class', fileId: ID.coreFile }))
    .addNode(node({ id: ID.derived, kind: 'Class', fileId: ID.coreFile }))
    .addNode(node({ id: ID.handle, kind: 'Function', fileId: ID.apiFile, isExported: true }))
    .addNode(node({ id: ID.guard, kind: 'Function', fileId: ID.apiFile, isExported: true }))
    .addNode(node({ id: ID.helperA, kind: 'Function', fileId: ID.cycleA, isExported: true }))
    .addNode(node({ id: ID.helperB, kind: 'Function', fileId: ID.cycleB, isExported: true }))
    .addNode(node({ id: ID.route, kind: 'Route', fileId: ID.apiFile }))
    .addNode(node({ id: ID.orphanRoute, kind: 'Route', fileId: ID.apiFile }))
    .addNode(node({ id: ID.secret, kind: 'EnvironmentVariable', name: 'JWT_SECRET' }))
    .addNode(node({ id: ID.unused, kind: 'EnvironmentVariable', name: 'UNUSED' }))
    .addNode(node({ id: ID.express, kind: 'External', name: 'express', externalKind: 'npm', externalName: 'express' }));

  graph
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.coreFile, targetId: ID.service }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.service, targetId: ID.run }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.service, targetId: ID.loop }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.coreFile, targetId: ID.shape }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.coreFile, targetId: ID.orphan }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.coreFile, targetId: ID.base }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.coreFile, targetId: ID.derived }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.apiFile, targetId: ID.handle }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.apiFile, targetId: ID.guard }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.cycleA, targetId: ID.helperA }))
    .addEdge(edge({ type: 'DECLARES', sourceId: ID.cycleB, targetId: ID.helperB }))
    // api imports core, so the packages are wired.
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.apiFile, targetId: ID.service, name: 'Service' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.apiFile, targetId: ID.express, name: 'express' }))
    .addEdge(edge({ type: 'EXPORTS', sourceId: ID.coreFile, targetId: ID.service, name: 'Service' }))
    // A mutual import cycle between two core files.
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.cycleA, targetId: ID.helperB, name: 'helperB' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: ID.cycleB, targetId: ID.helperA, name: 'helperA' }))
    // Calls, including a mutual pair and a self-call.
    .addEdge(edge({ type: 'CALLS', sourceId: ID.handle, targetId: ID.run, confidence: 'INFERRED', line: 1 }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.handle, targetId: ID.run, confidence: 'INFERRED', line: 2 }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.run, targetId: ID.loop, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.loop, targetId: ID.loop, confidence: 'INFERRED', line: 7 }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.helperA, targetId: ID.helperB, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: ID.helperB, targetId: ID.helperA, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'REFERENCES_TYPE', sourceId: ID.handle, targetId: ID.shape }))
    .addEdge(edge({ type: 'EXTENDS', sourceId: ID.derived, targetId: ID.base }))
    // A route chain with a duplicate registration at one position.
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ID.route, targetId: ID.guard, ordinal: 0 }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ID.route, targetId: ID.handle, ordinal: 1, line: 3 }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ID.route, targetId: ID.handle, ordinal: 1, line: 9 }))
    .addEdge(edge({ type: 'READS', sourceId: ID.run, targetId: ID.secret, line: 1 }))
    .addEdge(edge({ type: 'READS', sourceId: ID.handle, targetId: ID.secret, line: 2 }));

  graph.addRole(role(ID.service, 'Service')).addRole(role(ID.guard, 'Middleware'));

  graph
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: ID.run, text: 'missing()' }))
    .addUnresolved(unresolved({ type: 'IMPORTS', sourceId: ID.apiFile, text: './nowhere' }));

  return graph;
}

let graph: FakeGraph;
let explorer: RepositoryExplorer;

beforeEach(() => {
  graph = repository();
  explorer = new RepositoryExplorer(graph);
});

const id = (value: string): NodeId => value as NodeId;

describe('packageOf', () => {
  it('takes the first two path segments', () => {
    expect(packageOf('packages/health/src/types.ts')).toBe('packages/health');
    expect(packageOf('src/auth/user.service.ts')).toBe('src/auth');
  });

  it('takes the whole path when it has fewer than two segments', () => {
    expect(packageOf('index.ts')).toBe('index.ts');
  });

  it('ignores a leading separator rather than producing an empty segment', () => {
    expect(packageOf('/src/a.ts')).toBe('src/a.ts');
  });
});

describe('overview', () => {
  it('reports the repository summary', () => {
    const overview = explorer.overview();

    expect(overview.repository).toMatchObject({ files: 4, classes: 3, interfaces: 1 });
  });

  it('reports the architecture summary', () => {
    expect(explorer.overview().architecture).toMatchObject({
      routes: 2,
      environmentVariables: 2,
      externalPackages: 1,
    });
    expect(explorer.overview().architecture.roleCounts).toMatchObject({ Service: 1, Middleware: 1 });
  });

  it('reports every derived package alphabetically', () => {
    expect(explorer.overview().packages.entries.map((entry) => entry.name)).toEqual([
      'packages/api',
      'packages/core',
    ]);
  });

  it('counts files and declarations per package', () => {
    const core = explorer.overview().packages.entries.find((entry) => entry.name === 'packages/core');

    expect(core).toMatchObject({ files: 3, declarations: 9 });
  });

  it('counts package dependencies in both directions', () => {
    const packages = explorer.overview().packages.entries;

    expect(packages.find((entry) => entry.name === 'packages/api')).toMatchObject({ dependencies: 1 });
    expect(packages.find((entry) => entry.name === 'packages/core')).toMatchObject({ dependents: 1 });
  });

  it('reports the graph summary with relationship counts', () => {
    const graphSummary = explorer.overview().graph;

    expect(graphSummary.nodes).toBe(20);
    expect(graphSummary.relationshipCounts).toMatchObject({ CALLS: 6, HANDLED_BY: 3, EXTENDS: 1 });
  });

  it('reports the health summary', () => {
    const health = explorer.overview().health;

    expect(health.callGraphCoverage).toBeGreaterThan(0);
    expect(health.maxCallDepth).toBeGreaterThan(0);
    expect(health.limitationCodes.length).toBeGreaterThan(0);
  });

  it('states that the package boundary is derived rather than recorded', () => {
    expect(explorer.overview().limitations.map((entry) => entry.code)).toContain(
      'package-boundary-is-derived-from-paths',
    );
  });
});

describe('browseFile', () => {
  it('returns null for anything that is not a file', () => {
    expect(explorer.browseFile(id(ID.service))).toBeNull();
    expect(explorer.browseFile(id(ID.route))).toBeNull();
    expect(explorer.browseFile(id('file:src/nowhere.ts'))).toBeNull();
  });

  it('lists the declarations the file holds', () => {
    const view = explorer.browseFile(id(ID.apiFile));

    expect(view?.declarations.entries.map((entry) => entry.id)).toEqual([ID.handle, ID.guard].sort());
  });

  it('lists imports and exports with the node each reaches', () => {
    const view = explorer.browseFile(id(ID.apiFile));

    expect(view?.imports.entries.map((entry) => entry.target?.id).sort()).toEqual([ID.express, ID.service].sort());
    expect(explorer.browseFile(id(ID.coreFile))?.exports.entries.map((entry) => entry.target?.id)).toEqual([
      ID.service,
    ]);
  });

  it('lists the external packages the file imports', () => {
    expect(explorer.browseFile(id(ID.apiFile))?.externalPackages.entries.map((entry) => entry.id)).toEqual([
      ID.express,
    ]);
  });

  it('lists routes registered in the file or handled by its declarations', () => {
    expect(explorer.browseFile(id(ID.apiFile))?.routes.total).toBe(2);
  });

  it('lists environment variables its declarations read', () => {
    expect(explorer.browseFile(id(ID.coreFile))?.environmentVariables.entries.map((entry) => entry.id)).toEqual([
      ID.secret,
    ]);
  });

  it('lists the relationships leaving the file', () => {
    const view = explorer.browseFile(id(ID.apiFile));

    expect(view?.outgoingRelationships.total).toBeGreaterThan(0);
    expect(view?.outgoingRelationships.entries.map((entry) => entry.type)).toContain('IMPORTS');
  });

  it('reports a file with no incoming relationship, imports targeting declarations', () => {
    // `api/routes.ts` imports `Service`, not the file holding it, so no edge arrives at the file
    // node. That is why module-level dependency is a projection through each target's own file.
    expect(explorer.browseFile(id(ID.coreFile))?.incomingRelationships.total).toBe(0);
    expect(explorer.browsePackage('packages/core')?.dependents.entries.map((entry) => entry.name)).toEqual([
      'packages/api',
    ]);
  });

  it('reports statistics, with containment excluded from fan-out', () => {
    const view = explorer.browseFile(id(ID.coreFile));

    // The file declares seven things; that must not appear as coupling.
    expect(view?.statistics.declarations).toBe(7);
    expect(view?.statistics.fanOut).toBeLessThan(7);
  });

  it('names the package the file belongs to', () => {
    expect(explorer.browseFile(id(ID.apiFile))?.packageName).toBe('packages/api');
  });
});

describe('browseSymbol', () => {
  it('returns null for anything that is not a declaration', () => {
    expect(explorer.browseSymbol(id(ID.apiFile))).toBeNull();
    expect(explorer.browseSymbol(id(ID.route))).toBeNull();
    expect(explorer.browseSymbol(id(ID.express))).toBeNull();
    expect(explorer.browseSymbol(id('sym:nowhere.ts#Absent'))).toBeNull();
  });

  it('carries the whole Explain Symbol result rather than a copy of it', () => {
    const view = explorer.browseSymbol(id(ID.run));

    expect(view?.explain.declaration.node.id).toBe(ID.run);
    expect(view?.explain.kind).toBe('Method');
    expect(view?.explain.enclosingDeclaration?.declaration?.id).toBe(ID.service);
    // Explain Symbol's own limitations travel with its result, not restated by the explorer.
    expect(view?.explain.limitations.length).toBeGreaterThan(0);
  });

  it('lists children, which Explain Symbol does not report', () => {
    expect(explorer.browseSymbol(id(ID.service))?.children.entries.map((entry) => entry.id)).toEqual(
      [ID.run, ID.loop].sort(),
    );
  });

  it('summarises impact from Impact Analysis', () => {
    const view = explorer.browseSymbol(id(ID.run));

    expect(view?.impact.directlyAffected).toBeGreaterThan(0);
    expect(view?.impact.maxDepth).toBeGreaterThan(0);
  });

  it('summarises health for the declaration', () => {
    const view = explorer.browseSymbol(id(ID.run));

    expect(view?.health).toMatchObject({ isolated: false, recursive: false });
    expect(view?.health.fanIn).toBeGreaterThan(0);
  });

  it('reports a self-recursive declaration as recursive and in a cycle', () => {
    const view = explorer.browseSymbol(id(ID.loop));

    expect(view?.health.recursive).toBe(true);
    expect(view?.health.inCycle).toBe(true);
  });

  it('reports an isolated declaration as isolated', () => {
    expect(explorer.browseSymbol(id(ID.orphan))?.health.isolated).toBe(true);
  });

  it('names the package the declaration belongs to', () => {
    expect(explorer.browseSymbol(id(ID.run))?.packageName).toBe('packages/core');
  });
});

describe('browsePackages and browsePackage', () => {
  it('lists every package alphabetically', () => {
    expect(explorer.browsePackages().entries.map((entry) => entry.name)).toEqual([
      'packages/api',
      'packages/core',
    ]);
  });

  it('returns null for a package that does not exist', () => {
    expect(explorer.browsePackage('packages/nowhere')).toBeNull();
  });

  it('lists the files in the package', () => {
    expect(explorer.browsePackage('packages/api')?.files.entries.map((entry) => entry.id)).toEqual([ID.apiFile]);
  });

  it('lists cross-boundary dependencies with the edges that establish them', () => {
    const api = explorer.browsePackage('packages/api');

    expect(api?.dependencies.entries.map((entry) => entry.name)).toEqual(['packages/core']);
    expect(api?.dependencies.entries[0]?.edges.total).toBe(1);
  });

  it('lists dependents as the mirror of dependencies', () => {
    expect(explorer.browsePackage('packages/core')?.dependents.entries.map((entry) => entry.name)).toEqual([
      'packages/api',
    ]);
  });

  it('does not count an import inside the package as a dependency', () => {
    // cycle.a and cycle.b import each other but sit in the same package.
    expect(explorer.browsePackage('packages/core')?.dependencies.entries.map((entry) => entry.name)).toEqual([]);
  });

  it('lists the architectural roles inside the package', () => {
    expect(explorer.browsePackage('packages/core')?.roles.Service.map((entry) => entry.id)).toEqual([ID.service]);
    expect(explorer.browsePackage('packages/api')?.roles.Middleware.map((entry) => entry.id)).toEqual([ID.guard]);
  });

  it('lists the external packages the package imports', () => {
    expect(explorer.browsePackage('packages/api')?.externalPackages.entries.map((entry) => entry.id)).toEqual([
      ID.express,
    ]);
  });

  it('states that cross-package imports may resolve outside the analysed set', () => {
    expect(explorer.browsePackage('packages/api')?.limitations.map((entry) => entry.code)).toContain(
      'package-boundary-is-derived-from-paths',
    );
  });
});

describe('dependencies', () => {
  it('returns null for an identifier the graph does not hold', () => {
    expect(explorer.dependencies(id('sym:nowhere.ts#Absent'))).toBeNull();
  });

  it('works for a file as well as a declaration', () => {
    expect(explorer.dependencies(id(ID.apiFile))?.subject.kind).toBe('File');
    expect(explorer.dependencies(id(ID.run))?.subject.kind).toBe('Method');
  });

  it('reports direct imports and exports for a file', () => {
    const view = explorer.dependencies(id(ID.apiFile));

    expect(view?.direct.imports.total).toBe(2);
    expect(explorer.dependencies(id(ID.coreFile))?.direct.exports.total).toBe(1);
  });

  it('reports direct callers and callees for a declaration', () => {
    const view = explorer.dependencies(id(ID.run));

    expect(view?.direct.callers.entries.map((entry) => entry.edge.sourceId)).toEqual([ID.handle, ID.handle]);
    expect(view?.direct.callees.entries.map((entry) => entry.target?.id)).toEqual([ID.loop]);
  });

  it('reports the forward closure with each node at its shortest depth', () => {
    const forward = explorer.dependencies(id(ID.handle))?.indirect.forward.entries;

    expect(forward?.find((entry) => entry.node.id === ID.run)?.depth).toBe(1);
    expect(forward?.find((entry) => entry.node.id === ID.loop)?.depth).toBe(2);
  });

  it('reports the reverse closure from Impact Analysis', () => {
    const reverse = explorer.dependencies(id(ID.loop))?.indirect.reverse.entries;

    expect(reverse?.map((entry) => entry.node.id)).toContain(ID.run);
    expect(reverse?.map((entry) => entry.node.id)).toContain(ID.handle);
  });

  it('orders a closure by depth then identifier', () => {
    const forward = explorer.dependencies(id(ID.handle))?.indirect.forward.entries ?? [];
    const depths = forward.map((entry) => entry.depth);

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('reports the cycles the subject takes part in', () => {
    expect(explorer.dependencies(id(ID.helperA))?.indirect.cycles.length).toBeGreaterThan(0);
    expect(explorer.dependencies(id(ID.orphan))?.indirect.cycles).toEqual([]);
  });

  it('reports the connected component the subject sits in', () => {
    const component = explorer.dependencies(id(ID.run))?.indirect.connectedComponent;

    expect(component?.entries.map((entry) => entry.id)).toContain(ID.handle);
  });

  it('terminates on a cycle rather than looping', () => {
    const view = explorer.dependencies(id(ID.helperA));

    expect(view?.indirect.forward.entries.map((entry) => entry.node.id)).toContain(ID.helperB);
    expect(view?.indirect.forward.total).toBeLessThan(10);
  });
});

describe('architecture', () => {
  it('groups declarations by architectural role', () => {
    const view = explorer.architecture();

    expect(view.services.entries.map((entry) => entry.id)).toEqual([ID.service]);
    expect(view.middleware.entries.map((entry) => entry.id)).toEqual([ID.guard]);
    expect(view.controllers.entries).toEqual([]);
  });

  it('groups nodes by declaration kind', () => {
    const view = explorer.architecture();

    expect(view.classes.total).toBe(3);
    expect(view.interfaces.total).toBe(1);
    expect(view.methods.total).toBe(2);
    expect(view.namespaces.total).toBe(0);
  });

  it('lists routes, environment variables and external packages', () => {
    const view = explorer.architecture();

    expect(view.routes.total).toBe(2);
    expect(view.environmentVariables.total).toBe(2);
    expect(view.externalPackages.total).toBe(1);
  });

  it('orders every group alphabetically', () => {
    const ids = explorer.architecture().classes.entries.map((entry) => entry.id);

    expect(ids).toEqual([...ids].sort());
  });
});

describe('cycles', () => {
  it('returns every cycle rather than counting them', () => {
    const report = explorer.cycles();

    expect(report.callCycles.entries.length).toBe(report.totals.call);
    expect(report.callCycles.entries.every((cycle) => cycle.nodes.length > 0)).toBe(true);
  });

  it('finds the mutual call cycle', () => {
    const cycle = explorer
      .cycles()
      .callCycles.entries.find((entry) => entry.nodes.length === 2);

    expect(cycle?.nodes.map((entry) => entry.id)).toEqual([ID.helperA, ID.helperB]);
  });

  it('finds the self-call as a one-node cycle', () => {
    const cycle = explorer.cycles().callCycles.entries.find((entry) => entry.nodes.length === 1);

    expect(cycle?.nodes[0]?.id).toBe(ID.loop);
  });

  it('finds the mutual import cycle between two files', () => {
    const cycle = explorer.cycles().importCycles.entries[0];

    expect(cycle?.nodes.map((entry) => entry.id)).toEqual([ID.cycleA, ID.cycleB]);
    expect(cycle?.kind).toBe('import');
  });

  it('reports no reference or inheritance cycle when there is none', () => {
    expect(explorer.cycles().referenceCycles.entries).toEqual([]);
    expect(explorer.cycles().inheritanceCycles.entries).toEqual([]);
  });

  it('labels each cycle with the relationships it was found over', () => {
    expect(explorer.cycles().importCycles.entries[0]?.relationshipTypes).toEqual(['IMPORTS']);
    expect(explorer.cycles().inheritanceCycles.total).toBe(0);

    for (const kind of CYCLE_KINDS) {
      expect(explorer.cycles().totals[kind]).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries the edges that form each cycle', () => {
    const cycle = explorer.cycles().callCycles.entries.find((entry) => entry.nodes.length === 2);

    expect(cycle?.edges.total).toBe(2);
  });

  it('names the largest cycle across every kind', () => {
    expect(explorer.cycles().largest?.nodes.length).toBe(2);
  });

  it('warns that a multi-link this chain can look like self-recursion', () => {
    expect(explorer.cycles().limitations.map((entry) => entry.code)).toContain(
      'call-cycles-may-include-false-self-recursion',
    );
  });
});

describe('hotspots', () => {
  it('reports the most referenced declarations', () => {
    expect(explorer.hotspots().mostReferenced.entries.length).toBeGreaterThan(0);
  });

  it('distinguishes coupling from relationship count', () => {
    // `handle` calls `run` twice: one distinct neighbour, two edges. The two measures must differ.
    const coupled = explorer.hotspots().mostCoupled.entries.find((entry) => entry.node.id === ID.handle);
    const connected = explorer
      .hotspots()
      .mostConnectedDeclarations.entries.find((entry) => entry.node.id === ID.handle);

    expect(coupled?.fanIn ?? 0 + (coupled?.fanOut ?? 0)).toBeLessThan(
      (connected?.incomingEdges ?? 0) + (connected?.outgoingEdges ?? 0),
    );
  });

  it('orders every hotspot list by its measure descending', () => {
    const fanIns = explorer.hotspots().largestFanIn.entries.map((entry) => entry.fanIn);

    expect(fanIns).toEqual([...fanIns].sort((left, right) => right - left));
  });

  it('names the largest strongly connected component', () => {
    expect(explorer.hotspots().largestStronglyConnectedComponent?.nodes.length).toBe(2);
  });

  it('reports the fan-in and fan-out distributions', () => {
    expect(explorer.hotspots().fanIn.max).toBeGreaterThan(0);
    expect(explorer.hotspots().fanOut.total).toBeGreaterThan(0);
  });

  it('excludes anything with a zero measure rather than padding the list', () => {
    expect(explorer.hotspots().largestFanIn.entries.every((entry) => entry.fanIn > 0)).toBe(true);
  });
});

describe('reuse and shared state', () => {
  it('reads nothing further once every operation has run once', () => {
    // The first pass of each operation may ask something the others did not — architecture reads
    // route chains, for instance. After that the shared cache answers everything.
    explorer.overview();
    explorer.architecture();
    explorer.hotspots();
    explorer.cycles();

    const afterFirstPass = graph.totalCalls;

    explorer.overview();
    explorer.architecture();
    explorer.hotspots();
    explorer.cycles();

    expect(graph.totalCalls).toBe(afterFirstPass);
  });

  it('builds the whole-graph index once however many operations need it', () => {
    explorer.overview();

    // Eighteen node kinds and thirteen relationship types, read once each.
    expect(graph.calls.getNodes).toBe(19);
    expect(graph.calls.getEdges).toBe(13);

    explorer.hotspots();
    explorer.cycles();
    explorer.architecture();

    // One read per kind and per relationship type — that is the invariant, not the two totals.
    // Hardcoding them meant every new node kind failed a test about single-pass reading.
    expect(graph.calls.getNodes).toBe(NODE_KINDS.length);
    expect(graph.calls.getEdges).toBe(RELATIONSHIP_TYPES.length);
  });

  it('answers a second identical operation entirely from the cache', () => {
    const profiled = explorer.profile('overview', (inner) => inner.overview());

    expect(profiled.profile.graphApiCalls).toBeGreaterThan(0);

    const again = explorer.profile('overview', (inner) => inner.overview());

    expect(again.profile.graphApiCalls).toBe(0);
  });

  it('reports what an operation cost without timing it', () => {
    const profiled = explorer.profile('cycles', (inner) => inner.cycles());

    expect(profiled.profile.operation).toBe('cycles');
    expect(profiled.profile).not.toHaveProperty('elapsedMs');
    expect(profiled.profile.largestResult.entries).toBeGreaterThanOrEqual(0);
  });

  it('names the largest traversal it performed', () => {
    const profiled = explorer.profile('overview', (inner) => inner.overview());

    expect(profiled.profile.largestTraversal.nodes).toBeGreaterThan(0);
  });

  it('shares one graph read between Explain Symbol, Impact Analysis and Repository Health', () => {
    // browseSymbol uses all three. A second call adds no graph reads at all.
    explorer.browseSymbol(id(ID.run));

    const afterFirst = graph.totalCalls;

    explorer.browseSymbol(id(ID.run));

    expect(graph.totalCalls).toBe(afterFirst);
  });
});

describe('determinism', () => {
  it('answers identically on repeated calls', () => {
    expect(explorer.overview()).toEqual(explorer.overview());
    expect(explorer.cycles()).toEqual(explorer.cycles());
    expect(explorer.hotspots()).toEqual(explorer.hotspots());
    expect(explorer.architecture()).toEqual(explorer.architecture());
  });

  it('answers identically from a second explorer over the same graph', () => {
    const other = new RepositoryExplorer(repository());

    expect(other.overview()).toEqual(explorer.overview());
    expect(other.cycles()).toEqual(explorer.cycles());
    expect(other.browseSymbol(id(ID.run))).toEqual(explorer.browseSymbol(id(ID.run)));
  });

  it('produces plain data that survives a JSON round trip', () => {
    for (const result of [
      explorer.overview(),
      explorer.architecture(),
      explorer.cycles(),
      explorer.hotspots(),
      explorer.browseFile(id(ID.apiFile)),
      explorer.browseSymbol(id(ID.run)),
      explorer.browsePackage('packages/core'),
      explorer.dependencies(id(ID.run)),
    ]) {
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it('states its true size whenever a list is capped', () => {
    const view = explorer.browseFile(id(ID.coreFile));

    expect(view?.declarations.truncated).toBe(view!.declarations.total > view!.declarations.entries.length);
  });

  it('uses only limitation codes from the closed vocabulary', () => {
    for (const entry of explorer.overview().limitations) {
      expect(LIMITATION_CODES).toContain(entry.code);
      expect(entry.detail).not.toMatch(/\d/);
    }
  });
});

describe('unusual repositories', () => {
  it('explores an empty repository without failing', () => {
    const empty = new RepositoryExplorer(new FakeGraph());

    expect(empty.overview().repository.files).toBe(0);
    expect(empty.overview().packages.entries).toEqual([]);
    expect(empty.cycles().totals).toEqual({ import: 0, call: 0, reference: 0, inheritance: 0 });
    expect(empty.hotspots().largestStronglyConnectedComponent).toBeNull();
    expect(empty.architecture().classes.entries).toEqual([]);
    expect(empty.search({ text: 'anything' }).total).toBe(0);
  });

  it('explores a repository of one file with one declaration', () => {
    const single = new FakeGraph()
      .addNode(node({ id: 'file:index.ts', kind: 'File' }))
      .addNode(node({ id: 'sym:index.ts#only', kind: 'Function', fileId: 'file:index.ts' }))
      .addEdge(edge({ type: 'DECLARES', sourceId: 'file:index.ts', targetId: 'sym:index.ts#only' }));
    const one = new RepositoryExplorer(single);

    expect(one.overview().packages.entries.map((entry) => entry.name)).toEqual(['index.ts']);
    expect(one.browseSymbol(id('sym:index.ts#only'))?.health.isolated).toBe(true);
    expect(one.dependencies(id('sym:index.ts#only'))?.indirect.forward.entries).toEqual([]);
  });

  it('explores a repository that is nothing but a cycle', () => {
    const cyclic = new FakeGraph()
      .addNode(node({ id: 'file:a.ts', kind: 'File' }))
      .addNode(node({ id: 'sym:a.ts#a', kind: 'Function', fileId: 'file:a.ts' }))
      .addNode(node({ id: 'sym:a.ts#b', kind: 'Function', fileId: 'file:a.ts' }))
      .addEdge(edge({ type: 'CALLS', sourceId: 'sym:a.ts#a', targetId: 'sym:a.ts#b' }))
      .addEdge(edge({ type: 'CALLS', sourceId: 'sym:a.ts#b', targetId: 'sym:a.ts#a' }));

    const report = new RepositoryExplorer(cyclic).cycles();

    expect(report.totals.call).toBe(1);
    expect(report.callCycles.entries[0]?.nodes).toHaveLength(2);
  });
});

describe('large repositories', () => {
  it('explores a wide repository and keeps every response capped', () => {
    const large = new FakeGraph();
    const files = 60;
    const perFile = 30;

    for (let file = 0; file < files; file += 1) {
      const filePath = `file:packages/p${file % 6}/src/f${file}.ts`;

      large.addNode(node({ id: filePath, kind: 'File' }));

      for (let index = 0; index < perFile; index += 1) {
        const symbol = `sym:packages/p${file % 6}/src/f${file}.ts#d${index}`;

        large.addNode(node({ id: symbol, kind: 'Function', fileId: filePath, isExported: true }));
        large.addEdge(edge({ type: 'DECLARES', sourceId: filePath, targetId: symbol }));

        if (index > 0) {
          large.addEdge(
            edge({
              type: 'CALLS',
              sourceId: `sym:packages/p${file % 6}/src/f${file}.ts#d${index - 1}`,
              targetId: symbol,
            }),
          );
        }
      }
    }

    const big = new RepositoryExplorer(large);
    const overview = big.overview();

    expect(overview.repository.declarations).toBe(files * perFile);
    expect(overview.packages.total).toBe(6);

    const architecture = big.architecture();

    expect(architecture.functions.total).toBe(files * perFile);
    expect(architecture.functions.entries.length).toBeLessThanOrEqual(100);
    expect(architecture.functions.truncated).toBe(true);

    const search = big.search({ text: 'd1' });

    expect(search.declarations.total).toBeGreaterThan(100);
    expect(search.declarations.entries.length).toBe(100);
    expect(search.declarations.truncated).toBe(true);
  });

  it('explores a deep call chain without overflowing the stack', () => {
    const deep = new FakeGraph().addNode(node({ id: 'file:deep.ts', kind: 'File' }));
    const length = 5_000;

    for (let index = 0; index < length; index += 1) {
      deep.addNode(node({ id: `sym:deep.ts#d${index}`, kind: 'Function', fileId: 'file:deep.ts' }));

      if (index > 0) {
        deep.addEdge(
          edge({ type: 'CALLS', sourceId: `sym:deep.ts#d${index - 1}`, targetId: `sym:deep.ts#d${index}` }),
        );
      }
    }

    const explorerOverDeep = new RepositoryExplorer(deep);

    expect(explorerOverDeep.cycles().totals.call).toBe(0);
    expect(explorerOverDeep.overview().health.maxCallDepth).toBe(length - 1);
    expect(explorerOverDeep.dependencies(id('sym:deep.ts#d0'))?.indirect.forwardDepth).toBe(length - 1);
  });
});
