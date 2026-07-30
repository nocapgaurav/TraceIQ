import type { ExplainSymbolResult } from '@traceiq/explain';
import type {
  ArchitectureView,
  CycleReport,
  DependencyView,
  FileView,
  HotspotReport,
  Listing,
  PackageSummary,
  PackageView,
  RepositoryOverview,
  SearchQuery,
  SearchResults,
  SymbolView,
} from '@traceiq/explorer';
import type { GraphEdge, GraphNode, GraphProvenance } from '@traceiq/graph-api';
import type { RepositoryHealthReport } from '@traceiq/health';
import type { ImpactAnalysisResult } from '@traceiq/impact';
import type { RouteExplanation, RouteResult } from '@traceiq/query';
import type { NodeId } from '@traceiq/types';

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const CONTEXT_KINDS = [
  'symbol',
  'impact',
  'file',
  'package',
  'route',
  'repository',
  'search',
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

/**
 * What to assemble context for.
 *
 * Discriminated by `kind` rather than by class, so a request is plain data a caller can hold, log,
 * serialise and replay. The result type is `RepositoryContext` for every kind — a consumer renders one
 * shape, and `kind` says which parts are populated.
 */
export type ContextRequest =
  | { readonly kind: 'symbol'; readonly id: NodeId }
  | { readonly kind: 'impact'; readonly id: NodeId }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'route'; readonly method: string; readonly path: string }
  | { readonly kind: 'repository' }
  | { readonly kind: 'search'; readonly query: SearchQuery };

// ---------------------------------------------------------------------------------------------
// The context envelope
// ---------------------------------------------------------------------------------------------

/**
 * How a node relates to the subject.
 *
 * A closed vocabulary, so a consumer groups by relation without parsing prose. Every value names a
 * relationship a capability already established — nothing here is inferred.
 */
export const RELATIONS = [
  'enclosing',
  'child',
  'caller',
  'callee',
  'type-reference',
  'declaration',
  'package-file',
  'handler',
  'middleware',
  'affected',
  'search-result',
] as const;

export type Relation = (typeof RELATIONS)[number];

export interface RelatedNode {
  readonly node: GraphNode;
  readonly relation: Relation;
  /** Edges from the subject, where the capability that supplied it reported one. */
  readonly depth: number | null;
  /**
   * Everything the repository records about this node, when the request asked for it.
   *
   * Populated only where a kind's contract says so — `impact` explains its affected declarations,
   * `search` explains its results, `route` explains its handlers. Left `null` elsewhere rather than
   * explained speculatively, because explaining a thousand affected nodes would cost more than the
   * whole rest of the context.
   */
  readonly explain: ExplainSymbolResult | null;
}

/**
 * References around the subject, as the capability reported them.
 *
 * Carried as the capability's own result objects rather than flattened, so confidence, provenance and
 * source locations survive.
 *
 * **A kind-independent view, not additional data.** These edges also appear inside `primary` — under
 * `explain.incomingCalls` for a symbol, under `callers` for an impact analysis — and they are mirrored
 * here so a consumer reads `context.references` without knowing which kind it holds. The cost is a
 * modest amount of repetition in the payload; the alternative is every consumer learning where each kind
 * keeps its edges.
 */
export interface ContextReferences {
  readonly incomingCalls: readonly ReferenceLike[];
  readonly outgoingCalls: readonly CalleeLike[];
  readonly references: readonly ReferenceLike[];
  readonly typeReferences: readonly ReferenceLike[];
}

export interface ReferenceLike {
  readonly edge: GraphEdge;
  readonly source: GraphNode | null;
}

export interface CalleeLike {
  readonly edge: GraphEdge;
  readonly target: GraphNode | null;
}

/**
 * What the subject depends on and what depends on it.
 *
 * `view` is the explorer's own `DependencyView` when the kind has one subject node; `externals` and
 * `environmentVariables` are lifted out because every kind that has them has them.
 */
export interface ContextDependencies {
  readonly view: DependencyView | null;
  readonly externalPackages: readonly GraphNode[];
  readonly environmentVariables: readonly GraphNode[];
  readonly cycles: CycleReport | null;
}

export interface ContextImpact {
  /** The whole analysis, for a kind whose subject is one declaration. */
  readonly analysis: ImpactAnalysisResult | null;
  /** Counts, always present when an analysis was run. */
  readonly summary: ImpactSummary | null;
}

export interface ImpactSummary {
  readonly directlyAffected: number;
  readonly indirectlyAffected: number;
  readonly unknown: number;
  readonly maxDepth: number;
  readonly routesAffected: number;
}

export interface ContextHealth {
  /** The whole report, for the repository kind. */
  readonly report: RepositoryHealthReport | null;
  /** The subject's own condition, for a kind whose subject is one declaration or file. */
  readonly subject: SubjectHealth | null;
}

export interface SubjectHealth {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly isolated: boolean;
  readonly inCycle: boolean;
  readonly recursive: boolean;
  /** Repository finding codes naming the subject. */
  readonly findings: readonly string[];
}

/**
 * The repository's own subject.
 *
 * Three capability results rather than one, because the repository kind has no single subject: the
 * milestone names the overview, the architecture and the hotspots together, and each is carried
 * unchanged. The health report is not here — it is `health.report`, where every kind keeps it.
 */
export interface RepositorySubject {
  readonly overview: RepositoryOverview;
  readonly architecture: ArchitectureView;
  readonly hotspots: HotspotReport;
}

/** Whatever the kind's leading capability returned, unchanged. */
export type ContextPrimary =
  | { readonly type: 'symbol'; readonly value: SymbolView }
  | { readonly type: 'impact'; readonly value: ImpactAnalysisResult }
  | { readonly type: 'file'; readonly value: FileView }
  | { readonly type: 'package'; readonly value: PackageView }
  | { readonly type: 'route'; readonly value: RouteExplanation }
  | { readonly type: 'repository'; readonly value: RepositorySubject }
  | { readonly type: 'search'; readonly value: SearchResults };

export const LIMITATION_CODES = [
  'context-is-a-composition',
  'related-nodes-are-not-all-explained',
  'impact-summary-only',
  'repository-health-computed-independently',
  'capped-lists',
] as const;

export type LimitationCode = (typeof LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: LimitationCode;
  /** Fixed text for this code. Never composed. */
  readonly detail: string;
  readonly affected: number | null;
}

/**
 * Which capability produced which part of the context.
 *
 * The point of a composition layer is that a consumer can tell where a fact came from. Every part
 * names the package that produced it and the operation that was called, so a context is auditable
 * without reading this package's source.
 */
export interface ContextProvenance {
  readonly producer: 'context';
  readonly parts: readonly ContextPart[];
  /** Provenance carried by the subject node itself, where the kind has one. */
  readonly subject: GraphProvenance | null;
}

export interface ContextPart {
  readonly part: string;
  readonly capability: string;
  readonly operation: string;
}

export interface ContextStatistics {
  /** Calls this build made into each capability, by name. */
  readonly capabilityCalls: Readonly<Record<string, number>>;
  readonly totalCapabilityCalls: number;
  readonly relatedNodes: number;
  readonly explainedNodes: number;
  readonly referenceEdges: number;
}

/**
 * Deterministic repository context, assembled from existing capabilities.
 *
 * **One shape for every kind.** A consumer renders one object; `kind` says which parts are populated,
 * and a part that does not apply is `null` or empty rather than absent, so no field has to be probed.
 *
 * **Nothing here is generated.** No prose, no markdown, no prompt, no summary written in words, no
 * ranking and no score. Every value is a capability result or a count of one.
 */
export interface RepositoryContext {
  readonly kind: ContextKind;
  readonly primary: ContextPrimary;
  readonly related: readonly RelatedNode[];
  readonly references: ContextReferences;
  readonly dependencies: ContextDependencies;
  readonly impact: ContextImpact;
  readonly routes: readonly RouteResult[];
  readonly health: ContextHealth;
  readonly limitations: readonly Limitation[];
  readonly provenance: ContextProvenance;
  readonly statistics: ContextStatistics;
}

export type {
  ArchitectureView,
  CycleReport,
  DependencyView,
  ExplainSymbolResult,
  FileView,
  HotspotReport,
  ImpactAnalysisResult,
  Listing,
  PackageSummary,
  PackageView,
  RepositoryHealthReport,
  RepositoryOverview,
  RouteExplanation,
  RouteResult,
  SearchQuery,
  SearchResults,
  SymbolView,
};
