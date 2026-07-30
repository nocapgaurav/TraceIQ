import type {
  ArchitectureNavigation,
  CycleReport,
  GraphEdge,
  GraphNode,
  HealthReport,
  HotspotReport,
  ImpactAnalysis,
  Listing,
  Overview,
  SearchResults,
  SymbolView,
} from '@/types/api';

/**
 * Fixtures shaped exactly like the API's payloads.
 *
 * Hand-built rather than recorded, so a test states the case it is about — a truncated listing, an
 * unresolved edge, a node in a cycle — instead of relying on whatever a real repository happened to
 * contain. The shapes were checked against a live API before being written down.
 */

export function listing<T>(entries: readonly T[], total = entries.length): Listing<T> {
  return { entries, total, truncated: total > entries.length };
}

export function node(overrides: Partial<GraphNode> & { readonly id: string }): GraphNode {
  return {
    kind: 'Function',
    name: overrides.id.split('#').at(-1) ?? overrides.id,
    fileId: 'file:packages/core/src/service.ts',
    isExported: true,
    externalKind: null,
    confidence: 'CERTAIN',
    provenance: { producer: 'ir-builder', fileId: 'file:packages/core/src/service.ts', evidence: 'declaration' },
    locations: [{ startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 }],
    ...overrides,
  };
}

export function edge(overrides: Partial<GraphEdge> & { readonly id: string }): GraphEdge {
  return {
    type: 'CALLS',
    sourceId: 'sym:packages/api/src/routes.ts#getUser',
    targetId: 'sym:packages/core/src/service.ts#find',
    confidence: 'RESOLVED',
    location: { startLine: 4, startColumn: 3, endLine: 4, endColumn: 20 },
    ...overrides,
  };
}

export const FIND = 'sym:packages/core/src/service.ts#UserService.find';
export const CALLER = 'sym:packages/api/src/routes.ts#getUser';

const DISTRIBUTION = { min: 0, max: 12, mean: 2.5, median: 2, p90: 7, total: 100 };

const METRICS = {
  averageDeclarationsPerFile: 13.81,
  averageReferencesPerDeclaration: 1.99,
  graphDensity: 0.0011,
  callGraphCoverage: 0.22,
  referenceCoverage: 0.531,
  maxCallDepth: 4,
  fanIn: DISTRIBUTION,
  fanOut: DISTRIBUTION,
  declarationsPerFile: DISTRIBUTION,
};

export const OVERVIEW: Overview = {
  repository: {
    files: 228,
    declarations: 3148,
    classes: 57,
    interfaces: 274,
    methods: 300,
    functions: 450,
    routes: 0,
    environmentVariables: 1,
    externalPackages: 22,
    nodesByKind: { Function: 450, Class: 57, Interface: 274 },
    externalsByKind: { npm: 22, builtin: 24 },
  },
  architecture: {
    roleCounts: { Controller: 0, Service: 7, Repository: 3, Middleware: 1, Model: 0, Test: 211 },
    routes: 0,
    environmentVariables: 1,
    externalPackages: 22,
    dependencyGraph: { nodes: 228, edges: 2665 },
    callGraph: { nodes: 2244, edges: 3200 },
  },
  packages: listing([{ name: 'packages/core', files: 10, declarations: 140, dependencies: 1, dependents: 2 }]),
  graph: {
    nodes: 3428,
    edges: 12911,
    unresolvedReferences: 11418,
    relationshipCounts: { CALLS: 3200, DECLARES: 3148 },
    nodesByKind: { Function: 450 },
  },
  health: {
    callGraphCoverage: 0.22,
    referenceCoverage: 0.531,
    maxCallDepth: 4,
    declarationsInCycles: 20,
    isolatedDeclarations: 904,
    findingCounts: { 'declaration-isolated': 904 },
    limitationCodes: ['capped-lists'],
  },
  metrics: METRICS,
  limitations: [
    { code: 'package-boundary-is-derived-from-paths', detail: 'the graph records no package boundary', affected: null },
  ],
};

export const HOTSPOTS: HotspotReport = {
  mostReferenced: listing([
    { node: node({ id: FIND, kind: 'Method' }), fanIn: 63, fanOut: 0, incomingEdges: 63, outgoingEdges: 0 },
  ]),
  mostCoupled: listing(
    [{ node: node({ id: CALLER }), fanIn: 4, fanOut: 22, incomingEdges: 4, outgoingEdges: 27 }],
    2244,
  ),
  largestFanIn: listing([]),
  largestFanOut: listing([]),
  mostConnectedFiles: listing([]),
  mostConnectedDeclarations: listing([]),
  largestStronglyConnectedComponent: null,
  fanIn: DISTRIBUTION,
  fanOut: DISTRIBUTION,
};

export const SYMBOL_VIEW: SymbolView = {
  explain: {
    declaration: {
      node: node({ id: FIND, kind: 'Method', name: 'find' }),
      roles: [{ role: 'Service', confidence: 'INFERRED', evidence: 'class name ends with Service' }],
    },
    kind: 'Method',
    sourceFile: { id: 'file:packages/core/src/service.ts', path: 'packages/core/src/service.ts' },
    locations: [{ startLine: 3, startColumn: 3, endLine: 6, endColumn: 4 }],
    enclosingDeclaration: { declaration: node({ id: 'sym:packages/core/src/service.ts#UserService', kind: 'Class' }) },
    incomingCalls: [{ edge: edge({ id: 'e1' }), source: node({ id: CALLER }) }],
    // A `null` target is the case that matters: the graph recorded the edge but could not name the node.
    outgoingCalls: [{ edge: edge({ id: 'e2', type: 'CALLS', confidence: 'INFERRED' }), target: null }],
    references: [],
    typeReferences: [],
    routes: [],
    environmentVariables: [],
    externalDependencies: [],
    confidence: 'CERTAIN',
    provenance: { producer: 'explain-symbol', fileId: 'file:packages/core/src/service.ts', evidence: 'graph' },
    unresolved: [{ scope: 'call', result: { reference: { text: 'helper()', reason: 'root-not-bound' } } }],
    limitations: [{ code: 'partial-call-coverage', detail: 'not every call site is bound', affected: 3 }],
  },
  children: listing([]),
  impact: { directlyAffected: 2, indirectlyAffected: 5, unknown: 1, maxDepth: 3, routesAffected: 0 },
  health: {
    fanIn: 4,
    fanOut: 1,
    incomingEdges: 4,
    outgoingEdges: 1,
    isolated: false,
    inCycle: true,
    recursive: false,
    findings: ['declaration-in-dependency-cycle'],
  },
  packageName: 'packages/core',
};

export const IMPACT: ImpactAnalysis = {
  target: { node: node({ id: FIND, kind: 'Method' }) },
  directlyAffected: [
    {
      node: node({ id: CALLER }),
      category: 'DIRECT',
      depth: 1,
      via: edge({ id: 'e1', sourceId: CALLER, targetId: FIND }),
    },
  ],
  indirectlyAffected: [
    {
      node: node({ id: 'sym:packages/api/src/routes.ts#router' }),
      category: 'INDIRECT',
      depth: 2,
      via: edge({ id: 'e3', sourceId: 'sym:packages/api/src/routes.ts#router', targetId: CALLER }),
    },
  ],
  callers: [{ edge: edge({ id: 'e1' }), source: node({ id: CALLER }) }],
  callees: [],
  typeReferences: [],
  imports: [],
  environmentVariables: [],
  externalDependencies: [],
  routesAffected: [],
  unknown: [{ scope: 'call', at: FIND, result: { reference: { text: 'helper()', reason: 'root-not-bound' } } }],
  statistics: { nodesVisited: 12, maxDepth: 2 },
  limitations: [{ code: 'unknown-is-not-no-impact', detail: 'unbound calls are reported separately', affected: 1 }],
};

export const ARCHITECTURE: ArchitectureNavigation = {
  packages: listing([
    { name: 'packages/core', files: 10, declarations: 140, dependencies: 0, dependents: 1 },
    { name: 'packages/api', files: 8, declarations: 90, dependencies: 1, dependents: 0 },
  ]),
  architectureTree: listing([
    { group: 'Service', category: 'role', entries: listing([{ id: FIND, name: 'find', kind: 'Method' }]) },
  ]),
  packageTree: listing([
    { name: 'packages/core', files: listing([]), declarations: 140 },
    { name: 'packages/api', files: listing([]), declarations: 90 },
  ]),
  roleTree: listing([
    {
      role: 'Service',
      packages: listing([{ name: 'packages/core', declarations: listing([{ id: FIND, name: 'find', kind: 'Method' }]) }]),
      total: 1,
    },
  ]),
  dependencyTree: listing([
    { name: 'packages/core', dependsOn: listing([]), dependedOnBy: listing([{ name: 'packages/api', edges: 4 }]) },
    { name: 'packages/api', dependsOn: listing([{ name: 'packages/core', edges: 4 }]), dependedOnBy: listing([]) },
  ]),
  limitations: [],
};

export const HEALTH: HealthReport = {
  summary: { files: 228, declarations: 3148, graph: { nodes: 3428, edges: 12911, unresolvedReferences: 11418 } },
  metrics: METRICS,
  callGraphHealth: {
    callEdges: 3200,
    unresolvedCalls: 11346,
    coverage: 0.22,
    unresolvedByReason: { 'root-not-bound': 8000, 'root-type-unknown': 3346 },
    recursive: { count: 2, nodes: [] },
    cycles: [{ nodes: [node({ id: FIND })], relationshipType: 'CALLS' }],
    declarationsInCycles: 20,
    clusters: { count: 100, largest: 40, singletons: 12 },
    entryPoints: 5,
    maxCallDepth: 4,
  },
  dependencyHealth: {
    mostReferenced: [],
    mostCoupledFiles: [],
    isolated: { count: 904 },
    withoutIncoming: { count: 1200 },
    withoutOutgoing: { count: 1500 },
  },
  routing: { routes: 0, byMethod: {}, orphanRoutes: [], duplicateRegistrations: [], unresolvedHandlers: 0 },
  environment: { variables: 1, used: [{ node: node({ id: 'env:JWT_SECRET', kind: 'EnvironmentVariable' }), reads: 2 }], neverRead: [] },
  findings: [
    {
      code: 'declaration-isolated',
      category: 'connectivity',
      nodes: [node({ id: FIND })],
      nodeCount: 904,
      truncated: true,
      evidence: { metric: 'edges', value: 0 },
      confidence: 'CERTAIN',
    },
  ],
  limitations: [{ code: 'capped-lists', detail: 'each list carries at most a fixed number of entries', affected: null }],
};

export const CYCLES: CycleReport = {
  importCycles: listing([]),
  callCycles: listing([
    {
      kind: 'call',
      relationshipTypes: ['CALLS'],
      nodes: [node({ id: FIND }), node({ id: CALLER })],
      edges: listing([edge({ id: 'e1' })]),
    },
  ]),
  referenceCycles: listing([]),
  inheritanceCycles: listing([]),
  totals: { import: 0, call: 1, reference: 0, inheritance: 0 },
  largest: null,
  limitations: [],
};

export const SEARCH: SearchResults = {
  query: { text: 'find' },
  match: 'prefix',
  declarations: listing([node({ id: FIND, kind: 'Method', name: 'find' })], 3),
  files: listing([node({ id: 'file:packages/core/src/service.ts', kind: 'File', fileId: null })]),
  routes: listing([]),
  environmentVariables: listing([]),
  externalPackages: listing([]),
  total: 4,
};
