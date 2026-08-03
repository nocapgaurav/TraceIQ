import type { GraphEdge, GraphNode, NodeKind } from '@traceiq/graph-api';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

import type {
  ContextCapabilities,
  ExplainCapability,
  ExplorerCapability,
  HealthCapability,
  ImpactCapability,
  QueryCapability,
} from './capabilities.js';

/**
 * Capabilities that answer from fixed values and record every call.
 *
 * The builder's suite runs against these rather than a graph, which is the point: the package takes
 * capabilities and nothing else, so if composition works with fabricated answers it provably reaches no
 * database, no compiler and no filesystem. There is no `RepositoryGraphApi` in this file either.
 *
 * `pipeline.test.ts` then drives the same builder over a real scanned repository, so a passing unit test
 * cannot be an artefact of these fakes.
 */
export class FakeCapabilities implements ContextCapabilities {
  readonly calls: string[] = [];

  /** Values each operation returns. Assign before building. */
  results: {
    overview?: unknown;
    architecture?: unknown;
    hotspots?: unknown;
    cycles?: unknown;
    browsePackages?: unknown;
    browsePackage?: unknown;
    browseFile?: unknown;
    browseSymbol?: unknown;
    dependencies?: unknown;
    search?: unknown;
    explain?: unknown;
    impact?: unknown;
    health?: unknown;
    explainRoute?: unknown;
    findRoutes?: unknown;
    capabilities?: unknown;
    technologies?: unknown;
  } = {};

  readonly explorer: ExplorerCapability;
  readonly explain: ExplainCapability;
  readonly impact: ImpactCapability;
  readonly health: HealthCapability;
  readonly queries: QueryCapability;

  constructor() {
    const record = <T>(name: string, value: T): T => {
      this.calls.push(name);

      return value;
    };

    this.explorer = {
      overview: () => record('explorer.overview', this.results.overview) as never,
      architecture: () => record('explorer.architecture', this.results.architecture) as never,
      hotspots: () => record('explorer.hotspots', this.results.hotspots) as never,
      cycles: () => record('explorer.cycles', this.results.cycles) as never,
      browsePackages: () => record('explorer.browsePackages', this.results.browsePackages) as never,
      browsePackage: () => record('explorer.browsePackage', this.results.browsePackage ?? null) as never,
      browseFile: () => record('explorer.browseFile', this.results.browseFile ?? null) as never,
      browseSymbol: () => record('explorer.browseSymbol', this.results.browseSymbol ?? null) as never,
      dependencies: () => record('explorer.dependencies', this.results.dependencies ?? null) as never,
      search: () => record('explorer.search', this.results.search) as never,
    };

    this.explain = { explain: () => record('explain.explain', this.results.explain ?? null) as never };
    this.impact = { analyze: () => record('impact.analyze', this.results.impact ?? null) as never };
    this.health = { analyze: () => record('health.analyze', this.results.health) as never };
    this.queries = {
      explainRoute: () => record('queries.explainRoute', this.results.explainRoute ?? null) as never,
      findRoutes: () => record('queries.findRoutes', this.results.findRoutes ?? []) as never,
      // Every build reads this now: capability is carried on every context kind, because a claim about
      // a Python symbol needs its region's depth as much as a claim about the repository does.
      capabilities: () =>
        record(
          'queries.capabilities',
          this.results.capabilities ?? {
            depth: 'semantic',
            isPolyglot: false,
            languages: [],
            regions: [],
          },
        ) as never,
      // Read on every build too, beside capabilities, for the same reason: an answer that cannot
      // say what a repository *is* can only describe a pile of files.
      technologies: () => record('queries.technologies', this.results.technologies ?? []) as never,
    };
  }

  countOf(operation: string): number {
    return this.calls.filter((entry) => entry === operation).length;
  }
}

const RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 };

export function node(input: {
  readonly id: string;
  readonly kind: NodeKind;
  readonly fileId?: string | null;
  readonly name?: string;
}): GraphNode {
  return {
    id: input.id as NodeId,
    kind: input.kind,
    name: input.name ?? input.id.split(/[#.]/).at(-1) ?? input.id,
    fileId: (input.fileId ?? null) as NodeId | null,
    containerChain: null,
    visibility: null,
    isExported: false,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
    isDeclarationFile: null,
    hasSymbol: null,
    isExportedFromModule: null,
    externalKind: null,
    externalName: null,
    language: null,
    fileRole: null,
    category: null,
    artifactKind: null,
    confidence: 'CERTAIN',
    provenance: {
      producer: 'graph-builder',
      fileId: (input.fileId ?? null) as NodeId | null,
      evidence: `synthetic ${input.kind} node for testing`,
    },
    locations: [RANGE],
  };
}

export function edge(input: {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence?: ConfidenceLevel;
}): GraphEdge {
  return {
    id: `edge:${input.type}|${input.sourceId}|${input.targetId}|1`,
    type: input.type,
    sourceId: input.sourceId as NodeId,
    targetId: input.targetId as NodeId,
    name: null,
    confidence: input.confidence ?? 'INFERRED',
    candidateGroup: null,
    ordinal: null,
    provenance: {
      producer: 'call-graph',
      fileId: 'file:src/a.ts' as NodeId,
      evidence: `synthetic ${input.type} edge for testing`,
    },
    location: RANGE,
  };
}

export function listing<T>(entries: readonly T[]): { entries: readonly T[]; total: number; truncated: boolean } {
  return { entries, total: entries.length, truncated: false };
}

export function limitation(code: string): { code: string; detail: string; affected: number | null } {
  return { code, detail: `fixed text for ${code}`, affected: null };
}

/** A minimal `ExplainSymbolResult` shape, with only the fields the builder reads populated. */
export function explainResult(subject: GraphNode, overrides: Record<string, unknown> = {}): unknown {
  return {
    declaration: { node: subject, roles: [] as readonly { role: Role }[] },
    kind: subject.kind,
    sourceFile: subject.fileId === null ? null : { id: subject.fileId, path: subject.fileId.slice(5) },
    locations: subject.locations,
    enclosingDeclaration: null,
    incomingCalls: [],
    outgoingCalls: [],
    references: [],
    typeReferences: [],
    routes: [],
    environmentVariables: [],
    externalDependencies: [],
    confidence: subject.confidence,
    provenance: subject.provenance,
    unresolved: [],
    limitations: [limitation('call-coverage-partial')],
    ...overrides,
  };
}
