import { NODE_KINDS } from '@traceiq/graph-api';
import { RELATIONSHIP_TYPES } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeGraph, edge, node, role, unresolved } from './fake-graph.test-helper.js';
import { RepositoryHealthAnalyzer } from './repository-health-analyzer.js';
import { FINDING_CODES, LIMITATION_CODES, type FindingCode, type RepositoryHealthReport } from './types.js';

/**
 * One repository with something in every category, so each section is asserted against a graph
 * whose shape is known rather than inspected after the fact.
 *
 *   two files, a service class with two methods, a controller function, an interface,
 *   a route with middleware and handler, an environment variable read twice, one never read,
 *   an external package, a two-node call cycle, a self-call, an orphan declaration,
 *   a duplicate route registration, and unresolved references of two types.
 */
function repository(): FakeGraph {
  const graph = new FakeGraph();

  graph
    .addNode(node({ id: 'file:src/svc.ts', kind: 'File' }))
    .addNode(node({ id: 'file:src/routes.ts', kind: 'File' }))
    .addNode(node({ id: 'sym:src/svc.ts#Service', kind: 'Class', fileId: 'file:src/svc.ts', isExported: true }))
    .addNode(node({ id: 'sym:src/svc.ts#Service.run', kind: 'Method', fileId: 'file:src/svc.ts' }))
    .addNode(node({ id: 'sym:src/svc.ts#Service.loop', kind: 'Method', fileId: 'file:src/svc.ts' }))
    .addNode(node({ id: 'sym:src/svc.ts#Shape', kind: 'Interface', fileId: 'file:src/svc.ts', isExported: true }))
    .addNode(node({ id: 'sym:src/svc.ts#orphan', kind: 'Function', fileId: 'file:src/svc.ts', isExported: true }))
    .addNode(node({ id: 'sym:src/routes.ts#handle', kind: 'Function', fileId: 'file:src/routes.ts', isExported: true }))
    .addNode(node({ id: 'sym:src/routes.ts#guard', kind: 'Function', fileId: 'file:src/routes.ts', isExported: true }))
    .addNode(node({ id: 'sym:src/routes.ts#cycleA', kind: 'Function', fileId: 'file:src/routes.ts' }))
    .addNode(node({ id: 'sym:src/routes.ts#cycleB', kind: 'Function', fileId: 'file:src/routes.ts' }))
    .addNode(node({ id: 'route:POST:/login', kind: 'Route' }))
    .addNode(node({ id: 'route:GET:/orphan', kind: 'Route' }))
    .addNode(node({ id: 'env:JWT_SECRET', kind: 'EnvironmentVariable' }))
    .addNode(node({ id: 'env:UNUSED', kind: 'EnvironmentVariable' }))
    .addNode(node({ id: 'ext:npm:express', kind: 'External', externalKind: 'npm' }))
    .addNode(node({ id: 'ext:node:path', kind: 'External', externalKind: 'node' }));

  graph
    // Containment. Must never count as a reference.
    .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/svc.ts', targetId: 'sym:src/svc.ts#Service' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'sym:src/svc.ts#Service', targetId: 'sym:src/svc.ts#Service.run' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'sym:src/svc.ts#Service', targetId: 'sym:src/svc.ts#Service.loop' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/svc.ts', targetId: 'sym:src/svc.ts#Shape' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/svc.ts', targetId: 'sym:src/svc.ts#orphan' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/routes.ts', targetId: 'sym:src/routes.ts#handle' }))
    // Module wiring: routes.ts imports the service, and re-exports nothing.
    .addEdge(edge({ type: 'IMPORTS', sourceId: 'file:src/routes.ts', targetId: 'sym:src/svc.ts#Service' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: 'file:src/routes.ts', targetId: 'ext:npm:express' }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: 'file:src/svc.ts', targetId: 'ext:node:path' }))
    .addEdge(edge({ type: 'EXPORTS', sourceId: 'file:src/svc.ts', targetId: 'sym:src/svc.ts#Service' }))
    // Behaviour: handle calls run twice, run calls loop, loop calls itself, and a two-node cycle.
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/routes.ts#handle', targetId: 'sym:src/svc.ts#Service.run', confidence: 'INFERRED', line: 1 }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/routes.ts#handle', targetId: 'sym:src/svc.ts#Service.run', confidence: 'INFERRED', line: 2 }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/svc.ts#Service.run', targetId: 'sym:src/svc.ts#Service.loop', confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/svc.ts#Service.loop', targetId: 'sym:src/svc.ts#Service.loop', confidence: 'INFERRED', line: 5 }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/routes.ts#cycleA', targetId: 'sym:src/routes.ts#cycleB', confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/routes.ts#cycleB', targetId: 'sym:src/routes.ts#cycleA', confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'REFERENCES_TYPE', sourceId: 'sym:src/routes.ts#handle', targetId: 'sym:src/svc.ts#Shape' }))
    // A route chain, and a duplicate registration at the same position.
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: 'route:POST:/login', targetId: 'sym:src/routes.ts#guard', ordinal: 0 }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: 'route:POST:/login', targetId: 'sym:src/routes.ts#handle', ordinal: 1, line: 3 }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: 'route:POST:/login', targetId: 'sym:src/routes.ts#handle', ordinal: 1, line: 9 }))
    .addEdge(edge({ type: 'READS', sourceId: 'sym:src/svc.ts#Service.run', targetId: 'env:JWT_SECRET', line: 1 }))
    .addEdge(edge({ type: 'READS', sourceId: 'sym:src/routes.ts#handle', targetId: 'env:JWT_SECRET', line: 2 }));

  graph.addRole(role('sym:src/svc.ts#Service', 'Service')).addRole(role('sym:src/routes.ts#guard', 'Middleware'));

  graph
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: 'sym:src/svc.ts#Service.run', text: 'missing()' }))
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: 'file:src/routes.ts', text: 'expect()', reason: 'root-is-external' }))
    .addUnresolved(unresolved({ type: 'IMPORTS', sourceId: 'file:src/routes.ts', text: './nowhere' }));

  return graph;
}

let graph: FakeGraph;
let report: RepositoryHealthReport;

beforeEach(() => {
  graph = repository();
  graph.resetCalls();
  report = new RepositoryHealthAnalyzer(graph).analyze();
});

const findings = (code: FindingCode) => report.findings.filter((entry) => entry.code === code);

describe('repository summary', () => {
  it('counts files and declarations', () => {
    expect(report.summary.files).toBe(2);
    expect(report.summary.declarations).toBe(9);
  });

  it('counts each declaration kind the report calls out', () => {
    expect(report.summary).toMatchObject({ classes: 1, interfaces: 1, methods: 2, functions: 5 });
  });

  it('counts routes, environment variables and external packages', () => {
    expect(report.summary).toMatchObject({ routes: 2, environmentVariables: 2, externalPackages: 1 });
  });

  it('breaks externals down by kind, so a builtin is not counted as a package', () => {
    expect(report.summary.externalsByKind).toEqual({ npm: 1, node: 1 });
  });

  it('reports graph totals including unresolved references and role annotations', () => {
    expect(report.summary.graph).toEqual({
      nodes: 17,
      edges: 22,
      unresolvedReferences: 3,
      roleAnnotations: 2,
    });
  });
});

describe('architecture', () => {
  it('counts declarations by architectural role', () => {
    expect(report.architecture.roleCounts).toMatchObject({ Service: 1, Middleware: 1, Controller: 0 });
  });

  it('names the declarations carrying each role', () => {
    expect(report.architecture.byRole.Service.map((entry) => entry.id)).toEqual(['sym:src/svc.ts#Service']);
  });

  it('counts every relationship type, containment included', () => {
    expect(report.architecture.relationshipCounts).toMatchObject({
      DECLARES: 6,
      IMPORTS: 3,
      EXPORTS: 1,
      CALLS: 6,
      REFERENCES_TYPE: 1,
      HANDLED_BY: 3,
      READS: 2,
    });
  });

  it('reports no edge for a reserved relationship type', () => {
    expect(report.architecture.relationshipCounts).toMatchObject({ WRITES: 0, TESTS: 0, DEPENDS_ON: 0 });
  });

  it('sizes the dependency graph and the call graph separately', () => {
    expect(report.architecture.dependencyGraph.edges).toBe(4);
    expect(report.architecture.callGraph.edges).toBe(6);
  });
});

describe('dependency health', () => {
  it('excludes containment from fan-in, so a member is not referenced by its own container', () => {
    // Service.run is called by handle only; its DECLARES edge from Service must not count.
    const run = report.dependencyHealth.mostReferenced.find(
      (entry) => entry.node.id === 'sym:src/svc.ts#Service.run',
    );

    expect(run?.fanIn).toBe(1);
  });

  it('counts edges separately from distinct neighbours', () => {
    // handle calls run twice: one dependent, two edges.
    const run = report.dependencyHealth.mostReferenced.find(
      (entry) => entry.node.id === 'sym:src/svc.ts#Service.run',
    );

    expect(run).toMatchObject({ fanIn: 1, incomingEdges: 2 });
  });

  it('finds the declaration nothing references', () => {
    expect(report.dependencyHealth.withoutIncoming.nodes.map((entry) => entry.id)).toContain(
      'sym:src/svc.ts#orphan',
    );
  });

  it('finds the declaration that neither references nor is referenced', () => {
    expect(report.dependencyHealth.isolated.nodes.map((entry) => entry.id)).toContain(
      'sym:src/svc.ts#orphan',
    );
  });

  it('orders most-referenced by fan-in descending', () => {
    const fanIns = report.dependencyHealth.mostReferenced.map((entry) => entry.fanIn);

    expect(fanIns).toEqual([...fanIns].sort((left, right) => right - left));
  });

  it('reports external usage with the number of importing files', () => {
    const express = report.dependencyHealth.externalUsage.find((entry) => entry.node.id === 'ext:npm:express');

    expect(express).toMatchObject({ importingFiles: 1, importEdges: 1 });
  });

  it('says plainly when a list is capped rather than truncating silently', () => {
    for (const counted of [
      report.dependencyHealth.isolated,
      report.dependencyHealth.withoutIncoming,
      report.dependencyHealth.withoutOutgoing,
    ]) {
      expect(counted.truncated).toBe(counted.count > counted.nodes.length);
    }
  });
});

describe('call graph health', () => {
  it('counts call edges and unresolved calls', () => {
    expect(report.callGraphHealth).toMatchObject({ callEdges: 6, unresolvedCalls: 2 });
  });

  it('reports coverage as bound calls over every call site seen', () => {
    expect(report.callGraphHealth.coverage).toBe(0.75);
  });

  it('breaks unresolved calls down by reason', () => {
    expect(report.callGraphHealth.unresolvedByReason).toEqual({
      'root-not-bound': 1,
      'root-is-external': 1,
    });
  });

  it('finds the self-recursive declaration', () => {
    expect(report.callGraphHealth.recursive.nodes.map((entry) => entry.id)).toEqual([
      'sym:src/svc.ts#Service.loop',
    ]);
  });

  it('finds the two-node call cycle and the self-loop', () => {
    const lengths = report.callGraphHealth.cycles.map((cycle) => cycle.nodes.length).sort();

    expect(lengths).toEqual([1, 2]);
    expect(report.callGraphHealth.declarationsInCycles).toBe(3);
  });

  it('labels every cycle with the relationship that forms it', () => {
    expect(report.callGraphHealth.cycles.every((cycle) => cycle.relationshipType === 'CALLS')).toBe(true);
  });

  it('counts disconnected call clusters', () => {
    // handle→run→loop is one cluster; cycleA↔cycleB is another.
    expect(report.callGraphHealth.clusters).toMatchObject({ count: 2, largest: 3 });
  });

  it('counts entry points and measures depth from them', () => {
    // `handle` is the only declaration with no incoming call; run and loop sit below it.
    expect(report.callGraphHealth.entryPoints).toBe(1);
    expect(report.callGraphHealth.maxCallDepth).toBe(2);
  });
});

describe('routing', () => {
  it('counts routes and groups them by method', () => {
    expect(report.routing.routes).toBe(2);
    expect(report.routing.byMethod).toEqual({ POST: 1, GET: 1 });
  });

  it('finds the route with no handler', () => {
    expect(report.routing.orphanRoutes.map((entry) => entry.id)).toEqual(['route:GET:/orphan']);
  });

  it('finds a registration made twice at one position in the chain', () => {
    expect(report.routing.duplicateRegistrations).toHaveLength(1);
    expect(report.routing.duplicateRegistrations[0]).toMatchObject({ ordinal: 1 });
    expect(report.routing.duplicateRegistrations[0]?.edges).toHaveLength(2);
  });

  it('reports the distribution of handlers per route', () => {
    expect(report.routing.handlersPerRoute).toMatchObject({ min: 0, max: 3 });
  });

  it('counts handler references that could not be linked', () => {
    expect(report.routing.unresolvedHandlers).toBe(0);
  });
});

describe('environment', () => {
  it('counts variables and reports the reads of each', () => {
    expect(report.environment.variables).toBe(2);
    expect(report.environment.used.map((entry) => entry.node.id)).toEqual(['env:JWT_SECRET']);
  });

  it('counts reads separately from the declarations performing them', () => {
    expect(report.environment.used[0]).toMatchObject({ reads: 2, readingDeclarations: 2 });
  });

  it('finds the variable nothing reads', () => {
    expect(report.environment.neverRead.map((entry) => entry.id)).toEqual(['env:UNUSED']);
  });

  it('finds the variable read more than once', () => {
    expect(report.environment.readRepeatedly.map((entry) => entry.node.id)).toEqual(['env:JWT_SECRET']);
  });
});

describe('findings', () => {
  it('uses only codes from the closed vocabulary', () => {
    for (const code of report.findings.map((entry) => entry.code)) {
      expect(FINDING_CODES).toContain(code);
    }
  });

  it('groups findings by code, in vocabulary order', () => {
    // A code that fires several times — two call cycles here — appears as adjacent entries, and
    // the sequence of distinct codes follows the vocabulary.
    const emitted = report.findings.map((entry) => entry.code);
    const distinct = [...new Set(emitted)];

    expect(distinct).toEqual(FINDING_CODES.filter((code) => emitted.includes(code)));
    expect(emitted).toEqual(distinct.flatMap((code) => emitted.filter((entry) => entry === code)));
  });

  it('never merges the categories', () => {
    const categories = new Set(report.findings.map((entry) => entry.category));

    expect(categories.has('DEPENDENCY')).toBe(true);
    expect(categories.has('ANALYSIS_QUALITY')).toBe(true);

    for (const entry of report.findings) {
      expect(['DEPENDENCY', 'CALL_GRAPH', 'ROUTING', 'ENVIRONMENT', 'ANALYSIS_QUALITY']).toContain(entry.category);
    }
  });

  it('reports the declaration nothing references', () => {
    expect(findings('declaration-never-referenced')[0]?.nodes.map((entry) => entry.id)).toContain(
      'sym:src/svc.ts#orphan',
    );
  });

  it('reports an exported declaration nothing imports', () => {
    const nodes = findings('exported-declaration-never-imported')[0]?.nodes.map((entry) => entry.id);

    expect(nodes).toContain('sym:src/svc.ts#orphan');
    // Service is imported, so it must not appear.
    expect(nodes).not.toContain('sym:src/svc.ts#Service');
  });

  it('reports the call cycle with the edges that form it', () => {
    const cycle = findings('declaration-in-dependency-cycle').find((entry) => entry.nodeCount === 2);

    expect(cycle?.nodes.map((entry) => entry.id)).toEqual([
      'sym:src/routes.ts#cycleA',
      'sym:src/routes.ts#cycleB',
    ]);
    expect(cycle?.evidence).toMatchObject({ metric: 'cycleLength', value: 2 });
    expect(cycle?.evidence.edges).toHaveLength(2);
  });

  it('reports the route with no handler', () => {
    expect(findings('route-without-handler')[0]?.nodes.map((entry) => entry.id)).toEqual([
      'route:GET:/orphan',
    ]);
  });

  it('reports the duplicate registration with the two edges as evidence', () => {
    const duplicate = findings('route-registered-twice')[0];

    expect(duplicate?.evidence).toMatchObject({ metric: 'handlersAtOnePosition', value: 2 });
    expect(duplicate?.evidence.edges).toHaveLength(2);
  });

  it('reports the environment variable nothing reads', () => {
    expect(findings('environment-variable-never-read')[0]?.nodes.map((entry) => entry.id)).toEqual([
      'env:UNUSED',
    ]);
  });

  it('reports unresolved relationships as an analysis-quality fact', () => {
    const entry = findings('unresolved-relationships-limit-analysis')[0];

    expect(entry).toMatchObject({ category: 'ANALYSIS_QUALITY', confidence: 'CERTAIN' });
    expect(entry?.evidence).toMatchObject({ metric: 'unresolvedReferences', value: 3 });
  });

  it('bounds a call finding by the weakest confidence of the call graph', () => {
    // Every CALLS edge here is INFERRED, so a finding about calls cannot claim more.
    expect(findings('declaration-in-dependency-cycle')[0]?.confidence).toBe('INFERRED');
  });

  it('carries structured evidence rather than prose', () => {
    for (const entry of report.findings) {
      expect(typeof entry.evidence.metric).toBe('string');
      expect(typeof entry.evidence.value).toBe('number');
      expect(Array.isArray(entry.evidence.edges)).toBe(true);
    }
  });

  it('carries provenance naming this producer on every finding', () => {
    for (const entry of report.findings) {
      expect(entry.provenance.producer).toBe('health');
      expect(entry.provenance.evidence.length).toBeGreaterThan(10);
    }
  });

  it('states provenance evidence in text fixed by the code, never composed', () => {
    for (const entry of report.findings) {
      expect(entry.provenance.evidence).not.toMatch(/\d/);
    }
  });

  it('reports the true count even where the node list is capped', () => {
    for (const entry of report.findings) {
      expect(entry.nodeCount).toBeGreaterThanOrEqual(entry.nodes.length);
      expect(entry.truncated).toBe(entry.nodeCount > entry.nodes.length);
    }
  });

  it('carries no severity, score or recommendation field', () => {
    for (const entry of report.findings) {
      expect(entry).not.toHaveProperty('severity');
      expect(entry).not.toHaveProperty('score');
      expect(entry).not.toHaveProperty('recommendation');
    }
  });
});

describe('metrics', () => {
  it('averages declarations per file', () => {
    expect(report.metrics.averageDeclarationsPerFile).toBe(4.5);
  });

  it('averages references per declaration, containment excluded', () => {
    expect(report.metrics.averageReferencesPerDeclaration).toBeGreaterThan(0);
    expect(report.metrics.averageReferencesPerDeclaration).toBeLessThan(2);
  });

  it('reports density as a fraction of all possible ordered pairs', () => {
    expect(report.metrics.graphDensity).toBeGreaterThan(0);
    expect(report.metrics.graphDensity).toBeLessThan(1);
  });

  it('reports call graph coverage and reference coverage separately', () => {
    expect(report.metrics.callGraphCoverage).toBe(0.75);
    expect(report.metrics.referenceCoverage).toBe(0.88);
  });

  it('reports fan-in and fan-out distributions', () => {
    expect(report.metrics.fanIn.min).toBe(0);
    expect(report.metrics.fanIn.max).toBeGreaterThan(0);
    expect(report.metrics.fanOut.total).toBeGreaterThan(0);
  });

  it('reports every percentile as a value that actually occurs', () => {
    const { median, p90, min, max } = report.metrics.fanIn;

    expect(median).toBeGreaterThanOrEqual(min);
    expect(p90).toBeLessThanOrEqual(max);
  });
});

describe('one pass over the graph', () => {
  it('reads each node kind once and each relationship type once', () => {
    expect(graph.calls.getNodes).toBe(20);
    expect(graph.calls.getEdges).toBe(19);
  });

  it('reads unresolved references once', () => {
    expect(graph.calls.getUnresolved).toBe(1);
  });

  it('reads roles once per declaration and never twice', () => {
    expect(graph.calls.getRoles).toBe(report.summary.declarations);
  });

  it('reports what the analysis cost', () => {
    expect(report.statistics).toMatchObject({
      nodesScanned: 17,
      edgesScanned: 22,
      unresolvedScanned: 3,
    });
    expect(report.statistics.graphApiCalls).toBe(
      NODE_KINDS.length + RELATIONSHIP_TYPES.length + 1 + report.summary.declarations,
    );
  });

  it('names the largest traversal and the largest finding category', () => {
    expect(report.statistics.largestTraversal.name.length).toBeGreaterThan(0);
    expect(report.statistics.largestCategory.entries).toBeGreaterThan(0);
  });

  it('carries no timing, which would differ between runs', () => {
    expect(report.statistics).not.toHaveProperty('elapsedMs');
    expect(JSON.stringify(report)).not.toContain('elapsed');
  });
});

describe('limitations', () => {
  it('uses only codes from the closed vocabulary, in vocabulary order', () => {
    const emitted = report.limitations.map((entry) => entry.code);

    expect(emitted).toEqual(LIMITATION_CODES.filter((code) => emitted.includes(code)));
  });

  it('always reports what no analysis of this graph can recover', () => {
    expect(report.limitations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'call-coverage-partial',
        'no-interface-or-dynamic-dispatch',
        'reference-absence-is-not-proof',
        'no-history',
      ]),
    );
  });

  it('states each limitation in text fixed by its code, never composed', () => {
    for (const entry of report.limitations) {
      expect(entry.detail).not.toMatch(/\d/);
    }
  });

  it('omits a limitation that does not apply to this repository', () => {
    // No Property node here, so property references cannot be an issue.
    expect(report.limitations.map((entry) => entry.code)).not.toContain('property-references-not-recorded');
  });
});

describe('determinism', () => {
  it('produces an identical report from an identical graph', () => {
    expect(new RepositoryHealthAnalyzer(repository()).analyze()).toEqual(report);
  });

  it('produces an identical report on a second run over the same graph', () => {
    expect(new RepositoryHealthAnalyzer(graph).analyze()).toEqual(report);
  });

  it('produces plain data that survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('reports nothing that is not already a node or edge in the graph', () => {
    for (const entry of report.findings) {
      for (const graphEdge of entry.evidence.edges) {
        expect(graphEdge.id).toMatch(/^edge:/);
      }
    }
  });
});

describe('unusual repositories', () => {
  it('analyses an empty repository without failing', () => {
    const empty = new RepositoryHealthAnalyzer(new FakeGraph()).analyze();

    expect(empty.summary.files).toBe(0);
    expect(empty.summary.declarations).toBe(0);
    expect(empty.summary.graph).toMatchObject({ nodes: 0, edges: 0 });
    expect(empty.findings).toEqual([]);
    expect(empty.metrics.graphDensity).toBe(0);
    expect(empty.metrics.averageDeclarationsPerFile).toBe(0);
    expect(empty.callGraphHealth.coverage).toBe(0);
  });

  it('reports no NaN anywhere for an empty repository', () => {
    const empty = new RepositoryHealthAnalyzer(new FakeGraph()).analyze();

    expect(JSON.stringify(empty)).not.toContain('null,"mean"');
    for (const value of Object.values(empty.metrics)) {
      if (typeof value === 'number') {
        expect(Number.isNaN(value)).toBe(false);
      }
    }
  });

  it('analyses a repository of one file with one declaration', () => {
    const single = new FakeGraph()
      .addNode(node({ id: 'file:src/only.ts', kind: 'File' }))
      .addNode(node({ id: 'sym:src/only.ts#only', kind: 'Function', fileId: 'file:src/only.ts' }))
      .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/only.ts', targetId: 'sym:src/only.ts#only' }));

    const result = new RepositoryHealthAnalyzer(single).analyze();

    expect(result.summary).toMatchObject({ files: 1, declarations: 1 });
    expect(result.metrics.averageDeclarationsPerFile).toBe(1);
    expect(result.dependencyHealth.isolated.count).toBe(1);
    expect(result.callGraphHealth.clusters.count).toBe(0);
  });

  it('analyses a repository that is nothing but a cycle', () => {
    const cyclic = new FakeGraph()
      .addNode(node({ id: 'file:src/a.ts', kind: 'File' }))
      .addNode(node({ id: 'sym:src/a.ts#a', kind: 'Function', fileId: 'file:src/a.ts' }))
      .addNode(node({ id: 'sym:src/a.ts#b', kind: 'Function', fileId: 'file:src/a.ts' }))
      .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/a.ts#a', targetId: 'sym:src/a.ts#b' }))
      .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/a.ts#b', targetId: 'sym:src/a.ts#a' }));

    const result = new RepositoryHealthAnalyzer(cyclic).analyze();

    expect(result.callGraphHealth.cycles).toHaveLength(1);
    // Every node has an incoming call, so there is no entry point and no depth to measure.
    expect(result.callGraphHealth.entryPoints).toBe(0);
    expect(result.callGraphHealth.maxCallDepth).toBe(0);
  });

  it('analyses a repository whose declarations are all isolated', () => {
    const isolated = new FakeGraph().addNode(node({ id: 'file:src/a.ts', kind: 'File' }));

    for (let index = 0; index < 5; index += 1) {
      isolated.addNode(node({ id: `sym:src/a.ts#f${index}`, kind: 'Function', fileId: 'file:src/a.ts' }));
    }

    const result = new RepositoryHealthAnalyzer(isolated).analyze();

    expect(result.dependencyHealth.isolated.count).toBe(5);
    expect(result.dependencyHealth.mostReferenced).toEqual([]);
    expect(result.metrics.fanIn).toMatchObject({ min: 0, max: 0, total: 0 });
  });

  it('analyses a file holding no declaration at all', () => {
    const bare = new FakeGraph().addNode(node({ id: 'file:src/empty.ts', kind: 'File' }));
    const result = new RepositoryHealthAnalyzer(bare).analyze();

    expect(result.metrics.declarationsPerFile).toMatchObject({ min: 0, max: 0 });
  });
});

describe('stress', () => {
  it('analyses a wide repository in one pass', () => {
    const large = new FakeGraph();
    const files = 200;
    const perFile = 25;

    for (let file = 0; file < files; file += 1) {
      large.addNode(node({ id: `file:src/f${file}.ts`, kind: 'File' }));

      for (let index = 0; index < perFile; index += 1) {
        const id = `sym:src/f${file}.ts#d${index}`;

        large.addNode(node({ id, kind: 'Function', fileId: `file:src/f${file}.ts` }));
        large.addEdge(edge({ type: 'DECLARES', sourceId: `file:src/f${file}.ts`, targetId: id }));

        if (index > 0) {
          large.addEdge(
            edge({ type: 'CALLS', sourceId: `sym:src/f${file}.ts#d${index - 1}`, targetId: id }),
          );
        }
      }
    }

    const result = new RepositoryHealthAnalyzer(large).analyze();

    expect(result.summary.declarations).toBe(files * perFile);
    expect(result.callGraphHealth.clusters.count).toBe(files);
    expect(result.callGraphHealth.maxCallDepth).toBe(perFile - 1);
    // Still one pass: node kinds, relationship types, roles per declaration, unresolved once.
    expect(result.statistics.graphApiCalls).toBe(
      NODE_KINDS.length + RELATIONSHIP_TYPES.length + 1 + files * perFile,
    );
  });

  it('analyses a deep call chain without overflowing the stack', () => {
    const deep = new FakeGraph().addNode(node({ id: 'file:src/deep.ts', kind: 'File' }));
    const length = 20_000;

    for (let index = 0; index < length; index += 1) {
      deep.addNode(node({ id: `sym:src/deep.ts#d${index}`, kind: 'Function', fileId: 'file:src/deep.ts' }));

      if (index > 0) {
        deep.addEdge(
          edge({ type: 'CALLS', sourceId: `sym:src/deep.ts#d${index - 1}`, targetId: `sym:src/deep.ts#d${index}` }),
        );
      }
    }

    const result = new RepositoryHealthAnalyzer(deep).analyze();

    expect(result.callGraphHealth.maxCallDepth).toBe(length - 1);
    expect(result.callGraphHealth.cycles).toEqual([]);
  });
});
