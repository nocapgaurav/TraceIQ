import type { RepositoryContext } from '@traceiq/context';

/**
 * Contexts shaped exactly like the Context Builder's, hand-built so each test states its own case.
 *
 * Built rather than recorded: a recorded context is 600 KB of whatever a real repository happened to
 * contain, and a test that depends on it cannot say what it is testing. These are small, and each is
 * shaped to exercise one thing — a null reference source, a capped list, a node in a cycle.
 *
 * `pipeline.test.ts` then drives the same code over a real scanned repository, so a passing unit test
 * cannot be an artefact of these.
 */

export const SUBJECT = 'sym:packages/core/src/service.ts#UserService.find';
export const CALLER = 'sym:packages/api/src/routes.ts#getUser';
export const FILE = 'file:packages/core/src/service.ts';

const RANGE = { startLine: 3, startColumn: 3, endLine: 6, endColumn: 4 };

const PROVENANCE = { producer: 'ir-builder', fileId: FILE, evidence: 'declaration' } as const;

export function node(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'Method',
    name: id.split('#').at(-1) ?? id,
    fileId: FILE,
    containerChain: null,
    visibility: 'public',
    isExported: true,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
    isDeclarationFile: false,
    hasSymbol: true,
    isExportedFromModule: true,
    externalKind: null,
    externalName: null,
    confidence: 'CERTAIN',
    provenance: PROVENANCE,
    locations: [RANGE],
    ...overrides,
  };
}

function edge(id: string, sourceId: string, targetId: string, type = 'CALLS', confidence = 'INFERRED') {
  return { id, type, sourceId, targetId, confidence, location: RANGE };
}

function listing<T>(entries: readonly T[], total = entries.length) {
  return { entries, total, truncated: total > entries.length };
}

const EMPTY_REFERENCES = { incomingCalls: [], outgoingCalls: [], references: [], typeReferences: [] };

const EMPTY_DEPENDENCIES = { view: null, externalPackages: [], environmentVariables: [], cycles: null };

const STATISTICS = {
  capabilityCalls: {},
  totalCapabilityCalls: 0,
  relatedNodes: 0,
  explainedNodes: 0,
  referenceEdges: 0,
};

const PROVENANCE_PART = { producer: 'context', parts: [], subject: null };

function base(kind: string, primary: unknown, overrides: Record<string, unknown> = {}): RepositoryContext {
  return {
    kind,
    primary,
    related: [],
    references: EMPTY_REFERENCES,
    dependencies: EMPTY_DEPENDENCIES,
    impact: { analysis: null, summary: null },
    routes: [],
    health: { report: null, subject: null },
    limitations: [],
    provenance: PROVENANCE_PART,
    statistics: STATISTICS,
    ...overrides,
  } as unknown as RepositoryContext;
}

/**
 * A symbol context with one caller, one unresolvable callee, a role, a cycle and a limitation.
 *
 * The unresolvable callee matters: the graph records an edge whose target it could not name, and a
 * projection must not turn a `null` into an invented identifier.
 */
export function symbolContext(overrides: Record<string, unknown> = {}): RepositoryContext {
  return base(
    'symbol',
    {
      type: 'symbol',
      value: {
        explain: {
          declaration: {
            node: node(SUBJECT, { name: 'find' }),
            roles: [{ role: 'Service', confidence: 'INFERRED', evidence: 'class name ends with Service' }],
          },
          kind: 'Method',
          sourceFile: { id: FILE, path: 'packages/core/src/service.ts' },
          locations: [RANGE],
          enclosingDeclaration: { edge: null, declaration: node('sym:packages/core/src/service.ts#UserService') },
          incomingCalls: [],
          outgoingCalls: [],
          references: [],
          typeReferences: [],
          routes: [],
          environmentVariables: [],
          externalDependencies: [],
          confidence: 'CERTAIN',
          provenance: PROVENANCE,
          unresolved: [],
          limitations: [],
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
      },
    },
    {
      related: [
        { node: node('sym:packages/core/src/service.ts#UserService', { kind: 'Class' }), relation: 'enclosing', depth: 1, explain: null },
      ],
      references: {
        incomingCalls: [{ edge: edge('e1', CALLER, SUBJECT), source: node(CALLER) }],
        // A `null` target: the graph holds the edge but could not name the node. It must not be invented.
        outgoingCalls: [{ edge: edge('e2', SUBJECT, 'sym:unknown#helper'), target: null }],
        references: [],
        typeReferences: [],
      },
      dependencies: {
        view: null,
        externalPackages: [node('ext:npm:express', { kind: 'External', fileId: null })],
        environmentVariables: [node('env:JWT_SECRET', { kind: 'EnvironmentVariable', name: 'JWT_SECRET', fileId: null })],
        cycles: null,
      },
      impact: {
        analysis: null,
        summary: { directlyAffected: 2, indirectlyAffected: 5, unknown: 1, maxDepth: 3, routesAffected: 0 },
      },
      health: {
        report: null,
        subject: { fanIn: 4, fanOut: 1, isolated: false, inCycle: true, recursive: false, findings: ['declaration-in-dependency-cycle'] },
      },
      limitations: [
        { code: 'capped-lists', detail: 'every list carries at most a fixed number of entries', affected: null },
        { code: 'impact-summary-only', detail: 'impact is carried as counts', affected: null },
      ],
      ...overrides,
    },
  );
}

/** A symbol context with `count` callers, for asserting a cap and its omission. */
export function wideSymbolContext(count: number): RepositoryContext {
  const incomingCalls = Array.from({ length: count }, (_, index) => ({
    edge: edge(`e${index}`, `sym:packages/api/src/c${index}.ts#call${index}`, SUBJECT),
    source: node(`sym:packages/api/src/c${index}.ts#call${index}`),
  }));

  return symbolContext({
    references: { incomingCalls, outgoingCalls: [], references: [], typeReferences: [] },
  });
}

/** A repository context: no single subject, a health report, and metrics. */
export function repositoryContext(): RepositoryContext {
  return base(
    'repository',
    {
      type: 'repository',
      value: {
        overview: {
          repository: { files: 228, declarations: 3148, routes: 0 },
          graph: { nodes: 3428, edges: 12911, unresolvedReferences: 11418 },
        },
        architecture: {},
        hotspots: {},
      },
    },
    {
      health: {
        report: {
          callGraphHealth: { coverage: 0.22, maxCallDepth: 4, declarationsInCycles: 20 },
          dependencyHealth: { isolated: { count: 904 } },
          findings: [
            { code: 'declaration-isolated', nodeCount: 904 },
            { code: 'file-high-fan-in', nodeCount: 12 },
          ],
        },
        subject: null,
      },
      limitations: [{ code: 'capped-lists', detail: 'lists are capped', affected: 960 }],
    },
  );
}
