import type { NodeId } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeQueries, edge, node, reference, role, unresolved } from './fake-queries.test-helper.js';
import { ImpactAnalyzer } from './impact-analyzer.js';
import { IMPACT_CATEGORIES, LIMITATION_CODES, type LimitationCode } from './types.js';

const TARGET = 'sym:src/svc.ts#Service.run' as NodeId;

/**
 * One fixture with a known closure, so traversal can be asserted rather than inspected.
 *
 *   depth 1   callsRun, callsRunTwice (two call sites), UsesType, file:src/c.ts, cycleA
 *   depth 2   callsCaller, file:src/e.ts, cycleB
 *   depth 3   deep
 *
 * plus a route handling the target, a self-call, a two-node cycle, and a callee whose own
 * callee must never appear.
 */
const ROUTE_ID = 'route:POST:/run';

const nodes = {
  target: node({ id: TARGET, kind: 'Method', fileId: 'file:src/svc.ts' }),
  owner: node({ id: 'sym:src/svc.ts#Service', kind: 'Class', fileId: 'file:src/svc.ts' }),
  callsRun: node({ id: 'sym:src/a.ts#callsRun', kind: 'Function', fileId: 'file:src/a.ts' }),
  callsRunTwice: node({ id: 'sym:src/a.ts#callsTwice', kind: 'Function', fileId: 'file:src/a.ts' }),
  usesType: node({ id: 'sym:src/b.ts#UsesType', kind: 'Interface', fileId: 'file:src/b.ts' }),
  fileC: node({ id: 'file:src/c.ts', kind: 'File' }),
  fileE: node({ id: 'file:src/e.ts', kind: 'File' }),
  callsCaller: node({ id: 'sym:src/d.ts#callsCaller', kind: 'Function', fileId: 'file:src/d.ts' }),
  deep: node({ id: 'sym:src/f.ts#deep', kind: 'Function', fileId: 'file:src/f.ts' }),
  cycleA: node({ id: 'sym:src/cycle.ts#cycleA', kind: 'Function', fileId: 'file:src/cycle.ts' }),
  cycleB: node({ id: 'sym:src/cycle.ts#cycleB', kind: 'Function', fileId: 'file:src/cycle.ts' }),
  base: node({ id: 'sym:src/h.ts#Base', kind: 'Class', fileId: 'file:src/h.ts' }),
  derived: node({ id: 'sym:src/h.ts#Derived', kind: 'Class', fileId: 'file:src/h.ts' }),
  contract: node({ id: 'sym:src/i.ts#Contract', kind: 'Interface', fileId: 'file:src/i.ts' }),
  implementer: node({ id: 'sym:src/i.ts#Impl', kind: 'Class', fileId: 'file:src/i.ts' }),
  reExporter: node({ id: 'file:src/barrel.ts', kind: 'File' }),
  helper: node({ id: 'sym:src/g.ts#helper', kind: 'Function', fileId: 'file:src/g.ts' }),
  deeperHelper: node({ id: 'sym:src/g.ts#deeper', kind: 'Function', fileId: 'file:src/g.ts' }),
  route: node({ id: ROUTE_ID, kind: 'Route' }),
  secret: node({ id: 'env:SECRET', kind: 'EnvironmentVariable' }),
  express: node({ id: 'ext:npm:express', kind: 'External' }),
};

let queries: FakeQueries;
let analyzer: ImpactAnalyzer;

beforeEach(() => {
  queries = new FakeQueries();

  for (const entry of Object.values(nodes)) {
    queries.addNode(entry);
  }

  queries
    // Containment, which traversal must not follow.
    .addEdge(edge({ type: 'DECLARES', sourceId: nodes.owner.id, targetId: TARGET }))
    // Depth 1.
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.callsRun.id, targetId: TARGET }))
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.callsRunTwice.id, targetId: TARGET, line: 1 }))
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.callsRunTwice.id, targetId: TARGET, line: 2 }))
    .addEdge(edge({ type: 'REFERENCES_TYPE', sourceId: nodes.usesType.id, targetId: TARGET }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: nodes.fileC.id, targetId: TARGET }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: ROUTE_ID, targetId: TARGET, ordinal: 1 }))
    // A self-call: the target is already visited, so it must not reappear.
    .addEdge(edge({ type: 'CALLS', sourceId: TARGET, targetId: TARGET, line: 9 }))
    // Depth 2.
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.callsCaller.id, targetId: nodes.callsRun.id }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: nodes.fileE.id, targetId: nodes.callsRun.id }))
    // Depth 3.
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.deep.id, targetId: nodes.callsCaller.id }))
    // A two-node cycle that also reaches the target.
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.cycleA.id, targetId: TARGET }))
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.cycleB.id, targetId: nodes.cycleA.id }))
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.cycleA.id, targetId: nodes.cycleB.id }))
    // Callees: the target's own, and one a level below it.
    .addEdge(edge({ type: 'CALLS', sourceId: TARGET, targetId: nodes.helper.id }))
    .addEdge(edge({ type: 'CALLS', sourceId: nodes.helper.id, targetId: nodes.deeperHelper.id }))
    // A file re-exporting the target depends on it.
    .addEdge(edge({ type: 'EXPORTS', sourceId: nodes.reExporter.id, targetId: TARGET }));

  // Inheritance, kept in its own small graph so the main closure assertions stay readable.
  queries
    .addEdge(edge({ type: 'EXTENDS', sourceId: nodes.derived.id, targetId: nodes.base.id }))
    .addEdge(edge({ type: 'IMPLEMENTS', sourceId: nodes.implementer.id, targetId: nodes.contract.id }));

  queries
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: TARGET, text: 'atTarget()' }))
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: nodes.callsRun.id, text: 'atCaller()' }))
    .addUnresolved(unresolved({ type: 'IMPORTS', sourceId: nodes.fileC.id, text: './nowhere' }))
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: nodes.helper.id, text: 'atCallee()' }))
    .addUnresolved(unresolved({ type: 'CALLS', sourceId: 'file:src/unrelated.ts', text: 'far()' }));

  queries.routes = [
    {
      node: nodes.route,
      method: 'POST',
      path: '/run',
      composition: {
        composed: false,
        prefixes: [],
        effectivePath: '/run',
        note: 'no mount information is recorded in the graph',
      },
      handlers: [
        {
          edge: edge({ type: 'HANDLED_BY', sourceId: ROUTE_ID, targetId: TARGET, ordinal: 1 }),
          declaration: nodes.target,
        },
      ],
    },
  ];

  queries.environmentVariables = [
    {
      node: nodes.secret,
      reads: [
        reference(nodes.callsRun, edge({ type: 'READS', sourceId: nodes.callsRun.id, targetId: nodes.secret.id })),
        reference(nodes.deeperHelper, edge({ type: 'READS', sourceId: nodes.deeperHelper.id, targetId: nodes.secret.id })),
      ],
    },
  ];

  queries.dependencies = [
    {
      node: nodes.express,
      importedBy: [
        reference(nodes.fileC, edge({ type: 'IMPORTS', sourceId: nodes.fileC.id, targetId: nodes.express.id })),
        reference(
          node({ id: 'file:src/unrelated.ts', kind: 'File' }),
          edge({ type: 'IMPORTS', sourceId: 'file:src/unrelated.ts', targetId: nodes.express.id }),
        ),
      ],
    },
  ];

  queries.resetCalls();
  analyzer = new ImpactAnalyzer(queries);
});

const analyze = () => analyzer.analyze(TARGET);

const idsAtDepth = (depth: number): readonly string[] => {
  const result = analyze();
  const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

  return all
    .filter((entry) => entry.depth === depth)
    .map((entry) => entry.node.id)
    .sort();
};

const codesOf = (): readonly LimitationCode[] => (analyze()?.limitations ?? []).map((e) => e.code);

describe('the target', () => {
  it('returns the declaration with its roles', () => {
    queries.addRole(role(TARGET, 'Service'));

    expect(analyze()?.target.node.id).toBe(TARGET);
    expect(analyze()?.target.roles.map((entry) => entry.role)).toEqual(['Service']);
  });

  it('carries the target confidence and provenance, aggregating nothing', () => {
    expect(analyze()?.confidence).toBe('CERTAIN');
    expect(analyze()?.provenance.producer).toBe('graph-builder');
  });

  it('returns null for an identifier that names no declaration', () => {
    expect(analyzer.analyze('file:src/c.ts' as NodeId)).toBeNull();
    expect(analyzer.analyze(ROUTE_ID as NodeId)).toBeNull();
    expect(analyzer.analyze('ext:npm:express' as NodeId)).toBeNull();
    expect(analyzer.analyze('sym:src/nowhere.ts#Absent' as NodeId)).toBeNull();
  });
});

describe('traversal', () => {
  it('reports everything one edge away as DIRECT', () => {
    expect(idsAtDepth(1)).toEqual([
      'file:src/barrel.ts',
      'file:src/c.ts',
      'sym:src/a.ts#callsRun',
      'sym:src/a.ts#callsTwice',
      'sym:src/b.ts#UsesType',
      'sym:src/cycle.ts#cycleA',
    ]);
  });

  it('reports callers of callers as INDIRECT', () => {
    expect(idsAtDepth(2)).toEqual([
      'file:src/e.ts',
      'sym:src/cycle.ts#cycleB',
      'sym:src/d.ts#callsCaller',
    ]);
  });

  it('keeps walking beyond depth two', () => {
    expect(idsAtDepth(3)).toEqual(['sym:src/f.ts#deep']);
    expect(analyze()?.statistics.maxDepth).toBe(3);
  });

  it('categorises by distance, one edge being DIRECT and more being INDIRECT', () => {
    const result = analyze();

    expect(result?.directlyAffected.every((entry) => entry.depth === 1)).toBe(true);
    expect(result?.indirectlyAffected.every((entry) => entry.depth >= 2)).toBe(true);
  });

  it('follows a file, a module-level call being attributed to one', () => {
    // file:src/e.ts imports callsRun, so it is affected at depth 2 and expanded in turn.
    expect(idsAtDepth(2)).toContain('file:src/e.ts');
  });

  it('does not follow containment, a class not depending on its own member', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    expect(all.map((entry) => entry.node.id)).not.toContain('sym:src/svc.ts#Service');
  });

  it('carries the edge that reached each affected node', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    for (const entry of all) {
      expect(entry.via.sourceId).toBe(entry.node.id);
      expect(entry.via.provenance.evidence.length).toBeGreaterThan(0);
    }
  });

  it('lets the edge chain be walked back towards the target', () => {
    // via.targetId is the already-affected node it was reached through, so following it
    // arrives at the target without any path being stored.
    const deep = analyze()?.indirectlyAffected.find((entry) => entry.node.id === nodes.deep.id);

    expect(deep?.via.targetId).toBe(nodes.callsCaller.id);
  });
});

describe('relationships other than calls propagate too', () => {
  it('reports a subclass as affected by a change to its base class', () => {
    const result = analyzer.analyze(nodes.base.id);

    expect(result?.directlyAffected.map((entry) => entry.node.id)).toEqual([nodes.derived.id]);
    expect(result?.directlyAffected[0]?.via.type).toBe('EXTENDS');
  });

  it('reports an implementer as affected by a change to its interface', () => {
    const result = analyzer.analyze(nodes.contract.id);

    expect(result?.directlyAffected.map((entry) => entry.node.id)).toEqual([nodes.implementer.id]);
    expect(result?.directlyAffected[0]?.via.type).toBe('IMPLEMENTS');
  });

  it('reports a file that re-exports the target as affected', () => {
    // `export { run }` in a barrel makes that barrel depend on the target.
    const exporters = analyze()?.directlyAffected.filter((entry) => entry.via.type === 'EXPORTS');

    expect(exporters?.map((entry) => entry.node.id)).toEqual(['file:src/barrel.ts']);
  });

  it('carries the relationship type that established each affected node', () => {
    const types = new Set(
      (analyze()?.directlyAffected ?? []).map((entry) => entry.via.type),
    );

    expect(types).toEqual(new Set(['CALLS', 'REFERENCES_TYPE', 'IMPORTS', 'EXPORTS']));
  });
});

describe('callees are reported but not expanded', () => {
  it('reports the direct callees, a self-call among them being real recursion', () => {
    expect(analyze()?.callees.map((entry) => entry.target?.id).sort()).toEqual([
      nodes.helper.id,
      TARGET,
    ]);
  });

  it('does not place a callee among the affected nodes', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    expect(all.map((entry) => entry.node.id)).not.toContain(nodes.helper.id);
  });

  it('never reaches a callee of a callee', () => {
    // A change to the target cannot break what its callee calls.
    expect(JSON.stringify(analyze())).not.toContain(nodes.deeperHelper.id);
  });

  it('never asks for the references of a callee', () => {
    analyze();

    expect(queries.referenceTargets).not.toContain(nodes.helper.id);
  });
});

describe('cycles and duplicates', () => {
  it('terminates on a self-call without reporting the target as affected', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    expect(all.map((entry) => entry.node.id)).not.toContain(TARGET);
  });

  it('terminates on a two-node cycle, recording each node once', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];
    const cycles = all.filter((entry) => entry.node.id.startsWith('sym:src/cycle.ts#'));

    expect(cycles.map((entry) => `${entry.node.id}@${entry.depth}`).sort()).toEqual([
      'sym:src/cycle.ts#cycleA@1',
      'sym:src/cycle.ts#cycleB@2',
    ]);
  });

  it('records a node reached by two paths once, at its shortest distance', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];
    const ids = all.map((entry) => entry.node.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('collapses two call sites from one caller into one affected node', () => {
    const result = analyze();
    const twice = result?.directlyAffected.filter(
      (entry) => entry.node.id === nodes.callsRunTwice.id,
    );

    expect(twice).toHaveLength(1);
  });

  it('still reports both call sites as edges, which is what locates them', () => {
    const sites = analyze()?.callers.filter((entry) => entry.edge.sourceId === nodes.callsRunTwice.id);

    expect(sites?.map((entry) => entry.edge.location.startLine).sort()).toEqual([1, 2]);
  });

  it('asks for each node references exactly once', () => {
    analyze();

    expect(new Set(queries.referenceTargets).size).toBe(queries.referenceTargets.length);
  });
});

describe('direct edge-level relationships', () => {
  it('reports callers, excluding the self-call target as a node but keeping its edge', () => {
    expect(analyze()?.callers.map((entry) => entry.edge.sourceId)).toContain(TARGET);
  });

  it('reports type references', () => {
    expect(analyze()?.typeReferences.map((entry) => entry.edge.sourceId)).toEqual([
      nodes.usesType.id,
    ]);
  });

  it('reports imports', () => {
    expect(analyze()?.imports.map((entry) => entry.edge.sourceId)).toEqual([nodes.fileC.id]);
  });

  it('excludes containment from every edge-level field', () => {
    const result = analyze();
    const all = [...(result?.callers ?? []), ...(result?.typeReferences ?? []), ...(result?.imports ?? [])];

    expect(all.every((entry) => entry.edge.type !== 'DECLARES')).toBe(true);
  });
});

describe('routes, environment variables and externals', () => {
  it('reports a route whose chain reaches the closure, with the node it reaches', () => {
    expect(analyze()?.routesAffected).toHaveLength(1);
    expect(analyze()?.routesAffected[0]).toMatchObject({ reaches: TARGET });
    expect(analyze()?.routesAffected[0]?.route.path).toBe('/run');
  });

  it('does not place a route among the affected declarations', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    expect(all.map((entry) => entry.node.id)).not.toContain(ROUTE_ID);
  });

  it('asks for no route when none reaches the closure', () => {
    const isolated = new FakeQueries().addNode(nodes.target);

    new ImpactAnalyzer(isolated).analyze(TARGET);

    expect(isolated.calls.findRoutes).toBe(0);
  });

  it('reports only environment variable reads performed from inside the closure', () => {
    const variables = analyze()?.environmentVariables;

    expect(variables?.map((entry) => entry.node.id)).toEqual([nodes.secret.id]);
    expect(variables?.[0]?.reads.map((entry) => entry.edge.sourceId)).toEqual([nodes.callsRun.id]);
  });

  it('reports only externals imported by a file the closure touches', () => {
    const externals = analyze()?.externalDependencies;

    expect(externals?.map((entry) => entry.node.id)).toEqual([nodes.express.id]);
    expect(externals?.[0]?.importedBy.map((entry) => entry.edge.sourceId)).toEqual([nodes.fileC.id]);
  });
});

describe('the UNKNOWN category', () => {
  it('reports an unresolved relationship at the target', () => {
    const own = analyze()?.unknown.filter((entry) => entry.at === TARGET);

    expect(own?.map((entry) => entry.result.reference.text)).toEqual(['atTarget()']);
  });

  it('reports an unresolved relationship at an affected declaration', () => {
    expect(analyze()?.unknown.map((entry) => entry.result.reference.text)).toContain('atCaller()');
  });

  it('labels one recorded at a file, so the noisy ones can be filtered', () => {
    const fileScoped = analyze()?.unknown.filter((entry) => entry.scope === 'file');

    expect(fileScoped?.map((entry) => entry.result.reference.text)).toEqual(['./nowhere']);
  });

  it('labels one recorded at a declaration', () => {
    const declarationScoped = analyze()?.unknown.filter((entry) => entry.scope === 'declaration');

    expect(declarationScoped?.map((entry) => entry.result.reference.text).sort()).toEqual([
      'atCaller()',
      'atTarget()',
    ]);
  });

  it('excludes one recorded outside the closure', () => {
    const texts = analyze()?.unknown.map((entry) => entry.result.reference.text);

    expect(texts).not.toContain('far()');
    // The callee is not in the closure, so its unresolved call is not either.
    expect(texts).not.toContain('atCallee()');
  });

  it('never merges UNKNOWN into the affected sets', () => {
    const result = analyze();
    const affected = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    for (const entry of result?.unknown ?? []) {
      expect(affected.map((node_) => node_.node.id)).not.toContain(entry.result.reference.id);
    }
  });

  it('publishes the three categories as a closed vocabulary', () => {
    expect(IMPACT_CATEGORIES).toEqual(['DIRECT', 'INDIRECT', 'UNKNOWN']);
  });
});

describe('limitations', () => {
  it('uses only codes from the closed vocabulary, in vocabulary order', () => {
    const emitted = codesOf();

    for (const code of emitted) {
      expect(LIMITATION_CODES).toContain(code);
    }

    expect(emitted).toEqual(LIMITATION_CODES.filter((code) => emitted.includes(code)));
  });

  it('always reports what no traversal can recover', () => {
    expect(codesOf()).toEqual(
      expect.arrayContaining([
        'call-coverage-partial',
        'no-interface-or-dynamic-dispatch',
        'containment-not-followed',
      ]),
    );
  });

  it('counts the unresolved relationships inside the closure', () => {
    const entry = analyze()?.limitations.find(
      (item) => item.code === 'unresolved-relationships-in-closure',
    );

    expect(entry?.affected).toBe(3);
  });

  it('reports the repository-wide unresolved count as hidden dependents', () => {
    const entry = analyze()?.limitations.find(
      (item) => item.code === 'closure-may-miss-hidden-dependents',
    );

    expect(entry?.affected).toBe(5);
  });

  it('reports a file appearing among the affected nodes', () => {
    const entry = analyze()?.limitations.find((item) => item.code === 'file-level-attribution');

    expect(entry?.affected).toBe(3);
  });

  it('states each limitation in text fixed by its code, never composed', () => {
    for (const entry of analyze()?.limitations ?? []) {
      expect(entry.detail).not.toMatch(/\d/);
    }
  });

  it('omits a conditional limitation that does not apply', () => {
    // Two declaration-scoped entries against one file-scoped, so files do not dominate.
    expect(codesOf()).not.toContain('file-level-unresolved-dominates');
  });
});

describe('the query budget', () => {
  it('asks each whole-collection question exactly once, however large the closure', () => {
    analyze();

    expect(queries.calls.findDeclaration).toBe(1);
    expect(queries.calls.findCallees).toBe(1);
    expect(queries.calls.findRoutes).toBe(1);
    expect(queries.calls.findEnvironmentVariables).toBe(1);
    expect(queries.calls.findDependencies).toBe(1);
    expect(queries.calls.findUnresolved).toBe(1);
  });

  it('asks for references once per node in the closure, and no more', () => {
    const result = analyze();

    expect(queries.calls.findReferences).toBe(result?.statistics.referenceQueries);
    // The target plus every expandable affected node; the route is not expanded.
    expect(queries.calls.findReferences).toBe(11);
  });

  it('reports what the traversal cost', () => {
    expect(analyze()?.statistics).toEqual({
      nodesVisited: 11,
      maxDepth: 3,
      referenceQueries: 11,
      wholeCollectionQueries: 6,
    });
  });

  it('asks nothing further when the identifier is not a declaration', () => {
    queries.resetCalls();

    expect(analyzer.analyze('file:src/c.ts' as NodeId)).toBeNull();
    expect(Object.values(queries.calls).reduce((total, count) => total + count, 0)).toBe(1);
  });
});

describe('determinism', () => {
  it('produces an identical result from an identical graph', () => {
    const first = analyze();

    queries.resetCalls();

    expect(analyzer.analyze(TARGET)).toEqual(first);
  });

  it('orders affected nodes by depth, breadth-first and never sorted', () => {
    const result = analyze();
    const depths = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])].map(
      (entry) => entry.depth,
    );

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('produces plain data that survives a JSON round trip', () => {
    const result = analyze();

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('reports nothing that is not already an edge in the graph', () => {
    const result = analyze();
    const all = [...(result?.directlyAffected ?? []), ...(result?.indirectlyAffected ?? [])];

    for (const entry of all) {
      expect(entry.via.id).toMatch(/^edge:/);
    }
  });
});

describe('a declaration nothing depends on', () => {
  it('reports empty sets rather than inventing impact', () => {
    const isolated = new FakeQueries().addNode(nodes.target);
    const result = new ImpactAnalyzer(isolated).analyze(TARGET);

    expect(result?.directlyAffected).toEqual([]);
    expect(result?.indirectlyAffected).toEqual([]);
    expect(result?.unknown).toEqual([]);
    expect(result?.statistics).toMatchObject({ nodesVisited: 1, maxDepth: 0 });
  });

  it('still reports the general limitations, so empty is not read as complete', () => {
    const isolated = new FakeQueries().addNode(nodes.target);
    const result = new ImpactAnalyzer(isolated).analyze(TARGET);

    expect(result?.limitations.map((entry) => entry.code)).toContain('call-coverage-partial');
  });
});
