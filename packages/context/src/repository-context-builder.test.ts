import type { NodeId } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { EXPLAIN_LIMIT } from './builders.js';
import {
  FakeCapabilities,
  edge,
  explainResult,
  limitation,
  listing,
  node,
} from './fake-capabilities.test-helper.js';
import { ContextNotFoundError, RepositoryContextBuilder } from './repository-context-builder.js';
import { CONTEXT_KINDS, LIMITATION_CODES, RELATIONS } from './types.js';

const SERVICE = node({ id: 'sym:src/svc.ts#Service', kind: 'Class', fileId: 'file:src/svc.ts' });
const RUN = node({ id: 'sym:src/svc.ts#Service.run', kind: 'Method', fileId: 'file:src/svc.ts' });
const LOOP = node({ id: 'sym:src/svc.ts#Service.loop', kind: 'Method', fileId: 'file:src/svc.ts' });
const CALLER = node({ id: 'sym:src/a.ts#caller', kind: 'Function', fileId: 'file:src/a.ts' });
const FILE = node({ id: 'file:src/svc.ts', kind: 'File' });
const EXPRESS = node({ id: 'ext:npm:express', kind: 'External', name: 'express' });
const SECRET = node({ id: 'env:JWT_SECRET', kind: 'EnvironmentVariable', name: 'JWT_SECRET' });

const id = (value: string): NodeId => value as NodeId;

let capabilities: FakeCapabilities;
let builder: RepositoryContextBuilder;

beforeEach(() => {
  capabilities = new FakeCapabilities();
  builder = new RepositoryContextBuilder(capabilities);

  capabilities.results.health = {
    summary: { files: 1, declarations: 3 },
    findings: [{ code: 'declaration-never-referenced', nodeCount: 1, nodes: [LOOP] }],
    limitations: [limitation('reference-absence-is-not-proof')],
  };
});

// ---------------------------------------------------------------------------------------------

describe('the request vocabulary', () => {
  it('publishes every kind the milestone specifies', () => {
    expect(CONTEXT_KINDS).toEqual(['symbol', 'impact', 'file', 'package', 'route', 'repository', 'search']);
  });

  it('publishes a closed relation vocabulary', () => {
    expect(RELATIONS).toContain('enclosing');
    expect(RELATIONS).toContain('affected');
    expect(RELATIONS).toContain('search-result');
  });

  it('reports the kind it was asked for', () => {
    capabilities.results.search = {
      query: {},
      match: 'prefix',
      declarations: listing([]),
      files: listing([]),
      routes: listing([]),
      environmentVariables: listing([]),
      externalPackages: listing([]),
      total: 0,
    };

    expect(builder.build({ kind: 'search', query: { text: 'x' } }).kind).toBe('search');
  });
});

describe('symbol context', () => {
  beforeEach(() => {
    capabilities.results.browseSymbol = {
      explain: explainResult(RUN, {
        enclosingDeclaration: { edge: edge({ type: 'DECLARES', sourceId: SERVICE.id, targetId: RUN.id }), declaration: SERVICE },
        incomingCalls: [{ edge: edge({ type: 'CALLS', sourceId: CALLER.id, targetId: RUN.id }), source: CALLER }],
        outgoingCalls: [{ edge: edge({ type: 'CALLS', sourceId: RUN.id, targetId: LOOP.id }), target: LOOP }],
        references: [{ edge: edge({ type: 'CALLS', sourceId: CALLER.id, targetId: RUN.id }), source: CALLER }],
        externalDependencies: [{ node: EXPRESS, importedByFile: [] }],
        environmentVariables: [{ node: SECRET, reads: [] }],
      }),
      children: listing([]),
      impact: { directlyAffected: 2, indirectlyAffected: 1, unknown: 4, maxDepth: 2, routesAffected: 0 },
      health: { fanIn: 1, fanOut: 1, incomingEdges: 1, outgoingEdges: 1, isolated: false, inCycle: false, recursive: false, findings: [] },
      packageName: 'src',
    };
    capabilities.results.dependencies = {
      subject: RUN,
      direct: { imports: listing([]), exports: listing([]), references: listing([]), callees: listing([]), callers: listing([]) },
      indirect: { forward: listing([]), reverse: listing([]), forwardDepth: 0, reverseDepth: 0, cycles: [], connectedComponent: listing([]) },
      limitations: [limitation('call-coverage-partial')],
    };
  });

  it('carries the explorer view as the primary, unchanged', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(context.primary.type).toBe('symbol');
    expect(context.primary.value).toBe(capabilities.results.browseSymbol);
  });

  it('lists the enclosing declaration, callers and callees as related', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });
    const relations = new Map(context.related.map((entry) => [entry.node.id, entry.relation]));

    expect(relations.get(SERVICE.id)).toBe('enclosing');
    expect(relations.get(CALLER.id)).toBe('caller');
    expect(relations.get(LOOP.id)).toBe('callee');
  });

  it('mirrors the references so a consumer need not know the kind', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(context.references.incomingCalls).toHaveLength(1);
    expect(context.references.outgoingCalls).toHaveLength(1);
  });

  it('carries externals and environment variables', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(context.dependencies.externalPackages.map((entry) => entry.id)).toEqual([EXPRESS.id]);
    expect(context.dependencies.environmentVariables.map((entry) => entry.id)).toEqual([SECRET.id]);
  });

  it('carries impact as counts and says so', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(context.impact.analysis).toBeNull();
    expect(context.impact.summary).toMatchObject({ directlyAffected: 2, maxDepth: 2 });
    expect(context.limitations.map((entry) => entry.code)).toContain('impact-summary-only');
  });

  it('runs the impact analyser only through browseSymbol, never twice', () => {
    builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(capabilities.countOf('impact.analyze')).toBe(0);
    expect(capabilities.countOf('explorer.browseSymbol')).toBe(1);
  });

  it('costs four capability calls, two of them the reads every kind now makes', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(context.statistics.totalCapabilityCalls).toBe(4);
    expect(context.statistics.capabilityCalls).toEqual({
      'explorer.browseSymbol': 1,
      'explorer.dependencies': 1,
      // Carried on every context so an answer can say which region a symbol lives in and how deeply
      // that region was read. One lookup, not a traversal.
      'queries.capabilities': 1,
      'queries.technologies': 1,
    });
  });

  it('names which capability produced each part', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(context.provenance.producer).toBe('context');
    expect(context.provenance.parts.map((entry) => entry.part)).toContain('primary');
    expect(context.provenance.parts.every((entry) => entry.capability.startsWith('@traceiq/'))).toBe(true);
    expect(context.provenance.subject).toEqual(RUN.provenance);
  });

  it('throws rather than returning a hollow context for an unknown declaration', () => {
    capabilities.results.browseSymbol = undefined;

    expect(() => builder.build({ kind: 'symbol', id: id('sym:nowhere#X') })).toThrowError(ContextNotFoundError);
  });
});

describe('impact context', () => {
  const affected = Array.from({ length: 9 }, (_, index) =>
    node({ id: `sym:src/a.ts#d${index}`, kind: 'Function', fileId: 'file:src/a.ts' }),
  );

  beforeEach(() => {
    capabilities.results.impact = {
      target: { node: RUN, roles: [] },
      directlyAffected: affected.slice(0, 4).map((entry) => ({ node: entry, category: 'DIRECT', depth: 1, via: edge({ type: 'CALLS', sourceId: entry.id, targetId: RUN.id }) })),
      indirectlyAffected: affected.slice(4).map((entry) => ({ node: entry, category: 'INDIRECT', depth: 2, via: edge({ type: 'CALLS', sourceId: entry.id, targetId: RUN.id }) })),
      callers: [{ edge: edge({ type: 'CALLS', sourceId: CALLER.id, targetId: RUN.id }), source: CALLER }],
      callees: [],
      typeReferences: [],
      imports: [],
      routesAffected: [],
      environmentVariables: [{ node: SECRET, reads: [] }],
      externalDependencies: [{ node: EXPRESS, importedBy: [] }],
      unknown: [],
      confidence: 'INFERRED',
      provenance: RUN.provenance,
      limitations: [limitation('no-interface-or-dynamic-dispatch')],
      statistics: { nodesVisited: 10, maxDepth: 2, referenceQueries: 10, wholeCollectionQueries: 6 },
    };
    capabilities.results.explain = explainResult(affected[0]!);
  });

  it('carries the whole analysis as the primary', () => {
    const context = builder.build({ kind: 'impact', id: id(RUN.id) });

    expect(context.primary.type).toBe('impact');
    expect(context.impact.analysis).toBe(capabilities.results.impact);
  });

  it('lists every affected node with its depth', () => {
    const context = builder.build({ kind: 'impact', id: id(RUN.id) });

    expect(context.related).toHaveLength(9);
    expect(context.related.every((entry) => entry.relation === 'affected')).toBe(true);
    expect(context.related[0]?.depth).toBe(1);
  });

  it('explains only the first few, and reports how many it did not', () => {
    const context = builder.build({ kind: 'impact', id: id(RUN.id) });

    expect(context.statistics.explainedNodes).toBe(EXPLAIN_LIMIT);
    expect(capabilities.countOf('explain.explain')).toBe(EXPLAIN_LIMIT);

    const capped = context.limitations.find((entry) => entry.code === 'related-nodes-are-not-all-explained');

    expect(capped?.affected).toBe(9 - EXPLAIN_LIMIT);
  });

  it('keeps the depth-major order the analyser produced, without reordering', () => {
    const context = builder.build({ kind: 'impact', id: id(RUN.id) });
    const depths = context.related.map((entry) => entry.depth ?? 0);

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('reports references as the union of calls, type positions and imports', () => {
    const context = builder.build({ kind: 'impact', id: id(RUN.id) });

    expect(context.references.incomingCalls).toHaveLength(1);
    expect(context.references.references).toHaveLength(1);
    expect(context.references.references).not.toBe(context.references.incomingCalls);
  });

  it('summarises the analysis alongside it', () => {
    const context = builder.build({ kind: 'impact', id: id(RUN.id) });

    expect(context.impact.summary).toMatchObject({ directlyAffected: 4, indirectlyAffected: 5, maxDepth: 2 });
  });

  it('merges the limitations of the analysis and of each explanation', () => {
    const codes = builder.build({ kind: 'impact', id: id(RUN.id) }).limitations.map((entry) => entry.code);

    expect(codes).toContain('no-interface-or-dynamic-dispatch');
    expect(codes).toContain('call-coverage-partial');
    expect(codes).toContain('context-is-a-composition');
  });

  it('throws for an unknown declaration', () => {
    capabilities.results.impact = undefined;

    expect(() => builder.build({ kind: 'impact', id: id('sym:nowhere#X') })).toThrowError(ContextNotFoundError);
  });
});

describe('file context', () => {
  beforeEach(() => {
    capabilities.results.browseFile = {
      file: FILE,
      packageName: 'src',
      declarations: listing([SERVICE, RUN, LOOP]),
      imports: listing([]),
      exports: listing([]),
      externalPackages: listing([EXPRESS]),
      routes: listing([]),
      environmentVariables: listing([SECRET]),
      outgoingRelationships: listing([]),
      incomingRelationships: listing([]),
      statistics: { declarations: 3, imports: 0, exports: 0, outgoingEdges: 0, incomingEdges: 0, fanIn: 2, fanOut: 3, declarationsByKind: {} },
    };
    capabilities.results.dependencies = {
      subject: FILE,
      direct: { imports: listing([]), exports: listing([]), references: listing([]), callees: listing([]), callers: listing([]) },
      indirect: { forward: listing([]), reverse: listing([]), forwardDepth: 0, reverseDepth: 0, cycles: [], connectedComponent: listing([]) },
      limitations: [],
    };
  });

  it('accepts a path with or without the file prefix', () => {
    const byPath = builder.build({ kind: 'file', path: 'src/svc.ts' });
    const byId = builder.build({ kind: 'file', path: 'file:src/svc.ts' });

    expect(byId).toEqual(byPath);
  });

  it('lists the declarations the file holds', () => {
    const context = builder.build({ kind: 'file', path: 'src/svc.ts' });

    expect(context.related.map((entry) => entry.node.id)).toEqual([SERVICE.id, RUN.id, LOOP.id]);
    expect(context.related.every((entry) => entry.relation === 'declaration')).toBe(true);
  });

  it('explains none of them, a file context being about the file', () => {
    builder.build({ kind: 'file', path: 'src/svc.ts' });

    expect(capabilities.countOf('explain.explain')).toBe(0);
  });

  it('reports the file condition from its own counts', () => {
    const context = builder.build({ kind: 'file', path: 'src/svc.ts' });

    expect(context.health.subject).toMatchObject({ fanIn: 2, fanOut: 3, isolated: false, recursive: false });
  });

  it('reports the repository findings naming the file', () => {
    const context = builder.build({ kind: 'file', path: 'src/svc.ts' });

    // The report names LOOP, not the file, so the file has none of its own.
    expect(context.health.subject?.findings).toEqual([]);
  });

  it('carries no impact, a file not being a declaration', () => {
    expect(builder.build({ kind: 'file', path: 'src/svc.ts' }).impact).toEqual({ analysis: null, summary: null });
  });

  it('throws for an unknown file', () => {
    capabilities.results.browseFile = undefined;

    expect(() => builder.build({ kind: 'file', path: 'nowhere.ts' })).toThrowError(ContextNotFoundError);
  });
});

describe('package context', () => {
  beforeEach(() => {
    capabilities.results.browsePackage = {
      name: 'src',
      files: listing([FILE]),
      dependencies: listing([]),
      dependents: listing([]),
      exports: listing([]),
      imports: listing([]),
      externalPackages: listing([EXPRESS]),
      roles: { Controller: [], Service: [], Repository: [], Middleware: [], Model: [], Test: [] },
      statistics: { files: 1, declarations: 3, declarationsByKind: {} },
      limitations: [limitation('package-boundary-is-derived-from-paths')],
    };
  });

  it('carries the package view and the health report', () => {
    const context = builder.build({ kind: 'package', name: 'src' });

    expect(context.primary.value).toBe(capabilities.results.browsePackage);
    expect(context.health.report).toBe(capabilities.results.health);
  });

  it('lists the files as related', () => {
    const context = builder.build({ kind: 'package', name: 'src' });

    expect(context.related).toEqual([{ node: FILE, relation: 'package-file', depth: null, explain: null }]);
  });

  it('reports no calls or references, a package being a grouping', () => {
    const context = builder.build({ kind: 'package', name: 'src' });

    expect(context.references).toEqual({ incomingCalls: [], outgoingCalls: [], references: [], typeReferences: [] });
    expect(context.statistics.referenceEdges).toBe(0);
  });

  it('throws for an unknown package', () => {
    capabilities.results.browsePackage = undefined;

    expect(() => builder.build({ kind: 'package', name: 'nowhere' })).toThrowError(ContextNotFoundError);
  });
});

describe('route context', () => {
  const routeNode = node({ id: 'route:GET:/users/:id', kind: 'Route' });
  const guard = node({ id: 'sym:src/routes.ts#guard', kind: 'Function', fileId: 'file:src/routes.ts' });
  const handler = node({ id: 'sym:src/routes.ts#getUser', kind: 'Function', fileId: 'file:src/routes.ts' });

  beforeEach(() => {
    const handlerEdge = (target: string, ordinal: number) => ({
      edge: { ...edge({ type: 'HANDLED_BY', sourceId: routeNode.id, targetId: target }), ordinal },
      declaration: target === guard.id ? guard : handler,
    });

    capabilities.results.explainRoute = {
      route: {
        node: routeNode,
        method: 'GET',
        path: '/users/:id',
        composition: { composed: false, prefixes: [], effectivePath: '/users/:id', note: 'no mount information' },
        handlers: [handlerEdge(guard.id, 0), handlerEdge(handler.id, 1)],
      },
      middleware: [handlerEdge(guard.id, 0)],
      handler: handlerEdge(handler.id, 1),
      unresolvedHandlers: [],
    };
    capabilities.results.explain = explainResult(handler);
    capabilities.results.impact = {
      target: { node: handler, roles: [] },
      directlyAffected: [{ node: CALLER, category: 'DIRECT', depth: 1, via: edge({ type: 'CALLS', sourceId: CALLER.id, targetId: handler.id }) }],
      indirectlyAffected: [],
      callers: [],
      callees: [],
      typeReferences: [],
      imports: [],
      routesAffected: [],
      environmentVariables: [],
      externalDependencies: [],
      unknown: [],
      confidence: 'INFERRED',
      provenance: handler.provenance,
      limitations: [],
      statistics: { nodesVisited: 2, maxDepth: 1, referenceQueries: 2, wholeCollectionQueries: 6 },
    };
  });

  it('composes the route identity from the method and path', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });

    expect(context.primary.type).toBe('route');
    expect(context.routes.map((entry) => entry.node.id)).toEqual([routeNode.id]);
  });

  it('lists middleware and the handler with their own relations', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });
    const relations = new Map(context.related.map((entry) => [entry.node.id, entry.relation]));

    expect(relations.get(guard.id)).toBe('middleware');
    expect(relations.get(handler.id)).toBe('handler');
  });

  it('explains every handler in the chain', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });

    expect(context.statistics.explainedNodes).toBe(2);
    expect(capabilities.countOf('explain.explain')).toBe(2);
  });

  it('analyses the impact of each handler and sums the summary', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });

    expect(capabilities.countOf('impact.analyze')).toBe(2);
    expect(context.impact.summary?.directlyAffected).toBe(2);
    expect(context.impact.analysis).not.toBeNull();
  });

  it('reports that the prefix could not be composed, from the route itself', () => {
    const context = builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });
    const route = context.primary.type === 'route' ? context.primary.value : null;

    expect(route?.route.composition.composed).toBe(false);
  });

  it('throws for a route the graph does not register', () => {
    capabilities.results.explainRoute = undefined;

    expect(() => builder.build({ kind: 'route', method: 'GET', path: '/nowhere' })).toThrowError(ContextNotFoundError);
  });
});

describe('repository context', () => {
  beforeEach(() => {
    capabilities.results.overview = { repository: { files: 1 }, graph: { nodes: 4 }, limitations: [limitation('capped-lists')] };
    capabilities.results.architecture = {
      controllers: listing([]), services: listing([]), repositories: listing([]), middleware: listing([]),
      models: listing([]), tests: listing([]), routes: listing([]), environmentVariables: listing([SECRET]),
      externalPackages: listing([EXPRESS]), classes: listing([SERVICE]), interfaces: listing([]),
      functions: listing([]), methods: listing([RUN, LOOP]), variables: listing([]), namespaces: listing([]),
    };
    capabilities.results.hotspots = { mostReferenced: listing([]), fanIn: {}, fanOut: {} };
    capabilities.results.cycles = {
      importCycles: listing([]), callCycles: listing([]), referenceCycles: listing([]), inheritanceCycles: listing([]),
      totals: { import: 0, call: 0, reference: 0, inheritance: 0 }, largest: null, limitations: [],
    };
  });

  it('carries the overview, the architecture and the hotspots as one subject', () => {
    const context = builder.build({ kind: 'repository' });

    expect(context.primary.type).toBe('repository');

    const subject = context.primary.type === 'repository' ? context.primary.value : null;

    expect(subject?.overview).toBe(capabilities.results.overview);
    expect(subject?.architecture).toBe(capabilities.results.architecture);
    expect(subject?.hotspots).toBe(capabilities.results.hotspots);
  });

  it('carries the whole health report', () => {
    expect(builder.build({ kind: 'repository' }).health.report).toBe(capabilities.results.health);
  });

  it('states that health is computed twice for this kind', () => {
    const codes = builder.build({ kind: 'repository' }).limitations.map((entry) => entry.code);

    expect(codes).toContain('repository-health-computed-independently');
  });

  it('costs seven capability calls, one each', () => {
    const context = builder.build({ kind: 'repository' });

    expect(context.statistics.capabilityCalls).toEqual({
      'explorer.architecture': 1,
      'explorer.cycles': 1,
      'explorer.hotspots': 1,
      'explorer.overview': 1,
      'health.analyze': 1,
      'queries.capabilities': 1,
      'queries.technologies': 1,
    });
  });

  it('lists no related node, the repository having no single subject', () => {
    expect(builder.build({ kind: 'repository' }).related).toEqual([]);
    expect(builder.build({ kind: 'repository' }).provenance.subject).toBeNull();
  });
});

describe('search context', () => {
  const results = Array.from({ length: 8 }, (_, index) =>
    node({ id: `sym:src/a.ts#s${index}`, kind: 'Function', fileId: 'file:src/a.ts' }),
  );

  beforeEach(() => {
    capabilities.results.search = {
      query: { text: 's' },
      match: 'prefix',
      declarations: listing(results),
      files: listing([FILE]),
      routes: listing([]),
      environmentVariables: listing([]),
      externalPackages: listing([]),
      total: 9,
    };
    capabilities.results.explain = explainResult(results[0]!);
  });

  it('carries the search results as the primary', () => {
    expect(builder.build({ kind: 'search', query: { text: 's' } }).primary.value).toBe(capabilities.results.search);
  });

  it('lists declarations and files as results, in the order given', () => {
    const context = builder.build({ kind: 'search', query: { text: 's' } });

    expect(context.related.map((entry) => entry.node.id)).toEqual([...results.map((entry) => entry.id), FILE.id]);
    expect(context.related.every((entry) => entry.relation === 'search-result')).toBe(true);
  });

  it('explains the first few declarations and never a file', () => {
    const context = builder.build({ kind: 'search', query: { text: 's' } });

    expect(context.statistics.explainedNodes).toBe(EXPLAIN_LIMIT);
    // A file cannot be explained, so no call is spent asking.
    expect(capabilities.countOf('explain.explain')).toBe(EXPLAIN_LIMIT);
    expect(context.related.find((entry) => entry.node.id === FILE.id)?.explain).toBeNull();
  });
});

describe('boundaries', () => {
  it('reaches no graph, database, compiler or filesystem', () => {
    // The builder is given capabilities and nothing else; these fakes hold no graph at all.
    capabilities.results.overview = { limitations: [] };
    capabilities.results.architecture = {
      controllers: listing([]), services: listing([]), repositories: listing([]), middleware: listing([]),
      models: listing([]), tests: listing([]), routes: listing([]), environmentVariables: listing([]),
      externalPackages: listing([]), classes: listing([]), interfaces: listing([]), functions: listing([]),
      methods: listing([]), variables: listing([]), namespaces: listing([]),
    };
    capabilities.results.hotspots = {};
    capabilities.results.cycles = { importCycles: listing([]), callCycles: listing([]), referenceCycles: listing([]), inheritanceCycles: listing([]), totals: {}, largest: null, limitations: [] };

    expect(() => builder.build({ kind: 'repository' })).not.toThrow();
  });

  it('calls only operations the consumed interface declares', () => {
    capabilities.results.overview = { limitations: [] };
    capabilities.results.architecture = {
      controllers: listing([]), services: listing([]), repositories: listing([]), middleware: listing([]),
      models: listing([]), tests: listing([]), routes: listing([]), environmentVariables: listing([]),
      externalPackages: listing([]), classes: listing([]), interfaces: listing([]), functions: listing([]),
      methods: listing([]), variables: listing([]), namespaces: listing([]),
    };
    capabilities.results.hotspots = {};
    capabilities.results.cycles = { importCycles: listing([]), callCycles: listing([]), referenceCycles: listing([]), inheritanceCycles: listing([]), totals: {}, largest: null, limitations: [] };

    builder.build({ kind: 'repository' });

    const allowed = new Set([
      'explorer.overview', 'explorer.architecture', 'explorer.hotspots', 'explorer.cycles',
      'explorer.browsePackages', 'explorer.browsePackage', 'explorer.browseFile', 'explorer.browseSymbol',
      'explorer.dependencies', 'explorer.search', 'explain.explain', 'impact.analyze', 'health.analyze',
      'queries.explainRoute', 'queries.findRoutes', 'queries.capabilities', 'queries.technologies',
    ]);

    for (const call of capabilities.calls) {
      expect(allowed.has(call)).toBe(true);
    }
  });

  it('generates no prose, markdown or prompt', () => {
    capabilities.results.browsePackage = {
      name: 'src', files: listing([]), dependencies: listing([]), dependents: listing([]),
      exports: listing([]), imports: listing([]), externalPackages: listing([]),
      roles: { Controller: [], Service: [], Repository: [], Middleware: [], Model: [], Test: [] },
      statistics: { files: 0, declarations: 0, declarationsByKind: {} }, limitations: [],
    };

    const serialised = JSON.stringify(builder.build({ kind: 'package', name: 'src' }));

    for (const marker of ['```', '##', 'You are', 'Please', 'prompt', 'Summary:']) {
      expect(serialised).not.toContain(marker);
    }
  });

  it('uses only limitation codes from its own closed vocabulary for its own caveats', () => {
    capabilities.results.browsePackage = {
      name: 'src', files: listing([]), dependencies: listing([]), dependents: listing([]),
      exports: listing([]), imports: listing([]), externalPackages: listing([]),
      roles: { Controller: [], Service: [], Repository: [], Middleware: [], Model: [], Test: [] },
      statistics: { files: 0, declarations: 0, declarationsByKind: {} }, limitations: [],
    };

    const own = builder
      .build({ kind: 'package', name: 'src' })
      .limitations.filter((entry) => (LIMITATION_CODES as readonly string[]).includes(entry.code));

    expect(own.length).toBeGreaterThan(0);

    for (const entry of own) {
      expect(entry.detail).not.toMatch(/\d/);
    }
  });
});

describe('determinism', () => {
  beforeEach(() => {
    capabilities.results.browseSymbol = {
      explain: explainResult(RUN),
      children: listing([LOOP]),
      impact: { directlyAffected: 0, indirectlyAffected: 0, unknown: 0, maxDepth: 0, routesAffected: 0 },
      health: { fanIn: 0, fanOut: 0, incomingEdges: 0, outgoingEdges: 0, isolated: true, inCycle: false, recursive: false, findings: [] },
      packageName: 'src',
    };
    capabilities.results.dependencies = null;
  });

  it('builds an identical context from identical answers', () => {
    const first = builder.build({ kind: 'symbol', id: id(RUN.id) });
    const second = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(second).toEqual(first);
  });

  it('produces plain data that survives a JSON round trip', () => {
    const context = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
  });

  it('orders limitations by code', () => {
    const codes = builder.build({ kind: 'symbol', id: id(RUN.id) }).limitations.map((entry) => entry.code);

    expect(codes).toEqual([...codes].sort());
  });

  it('deduplicates a limitation two capabilities both report', () => {
    capabilities.results.dependencies = {
      subject: RUN,
      direct: { imports: listing([]), exports: listing([]), references: listing([]), callees: listing([]), callers: listing([]) },
      indirect: { forward: listing([]), reverse: listing([]), forwardDepth: 0, reverseDepth: 0, cycles: [], connectedComponent: listing([]) },
      limitations: [limitation('call-coverage-partial')],
    };

    const codes = builder.build({ kind: 'symbol', id: id(RUN.id) }).limitations.map((entry) => entry.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('counts calls per build rather than cumulatively', () => {
    const first = builder.build({ kind: 'symbol', id: id(RUN.id) });
    const second = builder.build({ kind: 'symbol', id: id(RUN.id) });

    expect(second.statistics.totalCapabilityCalls).toBe(first.statistics.totalCapabilityCalls);
  });
});
