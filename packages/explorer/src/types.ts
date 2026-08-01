import type { ExplainSymbolResult } from '@traceiq/explain';
import type { GraphEdge, GraphNode, NodeKind, RepositoryCapabilities } from '@traceiq/graph-api';
import type {
  CallGraphHealthReport,
  Distribution,
  HealthFinding,
  NodeMetric,
  RepositoryHealthReport,
  RepositoryMetrics,
  RepositorySummary,
} from '@traceiq/health';
import type { ImpactAnalysisResult } from '@traceiq/impact';
import type { CalleeResult, ReferenceResult, RouteResult } from '@traceiq/query';
import type { RelationshipType, Role } from '@traceiq/types';

/**
 * How many entries a list in an explorer response carries.
 *
 * Every capped list reports its true `total` and sets `truncated`, so a cap is never silent. The
 * number is a response-size choice, not a threshold: nothing is classified or excluded by it.
 */
export const RESULT_LIMIT = 100;

export const LIMITATION_CODES = [
  'package-boundary-is-derived-from-paths',
  'cross-package-imports-resolve-outside-analysis',
  'call-cycles-may-include-false-self-recursion',
  'connected-component-spans-the-repository',
  'capped-lists',
] as const;

export type LimitationCode = (typeof LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: LimitationCode;
  /** Fixed text for this code. Never composed. */
  readonly detail: string;
  readonly affected: number | null;
}

/** A capped list that states its own true size. */
export interface Listing<T> {
  readonly entries: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Repository overview
// ---------------------------------------------------------------------------------------------

export interface PackageSummary {
  /** The derived package path — see `packageOf`. */
  readonly name: string;
  readonly files: number;
  readonly declarations: number;
  /** Distinct packages this one imports from. */
  readonly dependencies: number;
  /** Distinct packages importing from this one. */
  readonly dependents: number;
}

export interface GraphSummary {
  readonly nodes: number;
  readonly edges: number;
  readonly unresolvedReferences: number;
  readonly relationshipCounts: Readonly<Record<RelationshipType, number>>;
  readonly nodesByKind: Readonly<Record<NodeKind, number>>;
}

export interface HealthSummary {
  readonly callGraphCoverage: number;
  readonly referenceCoverage: number;
  readonly maxCallDepth: number;
  readonly declarationsInCycles: number;
  readonly isolatedDeclarations: number;
  readonly findingCounts: Readonly<Record<string, number>>;
  readonly limitationCodes: readonly string[];
}

export interface ArchitectureSummary {
  readonly roleCounts: Readonly<Record<Role, number>>;
  readonly routes: number;
  readonly environmentVariables: number;
  readonly externalPackages: number;
  readonly dependencyGraph: { readonly nodes: number; readonly edges: number };
  readonly callGraph: { readonly nodes: number; readonly edges: number };
}

/**
 * One technology the repository is built from, as a reader sees it.
 *
 * Flattened from the `Technology` nodes rather than recomputed: the graph is the record, and a
 * second derivation would be a second chance to disagree with what search returns.
 */
export interface TechnologySummary {
  readonly id: string;
  readonly name: string;
  /** `frontend`, `backend`, `infrastructure`, `build`, `testing`, `data`. */
  readonly category: string;
  /** The region it was found in; `''` is the repository root. */
  readonly regionPath: string;
  readonly confidence: string;
  /** Why the claim is made, in words a reader can check against the files it names. */
  readonly evidence: string;
}

export interface RepositoryOverview {
  readonly repository: RepositorySummary;
  /**
   * The frameworks, runtimes and infrastructure this repository is built from.
   *
   * On the overview beside `capabilities` and for the same reason: every surface needs it, and a
   * reader shown a file count with no idea whether they are looking at a Next.js application or a
   * Terraform module has been told the least useful true thing about the repository.
   *
   * Sorted by region then name, so two scans agree.
   */
  readonly technologies: readonly TechnologySummary[];
  /**
   * What this repository's graph can answer, by technology region.
   *
   * Carried on the overview because every surface needs it and the overview is what every
   * surface already reads. A region at `universal` depth has no declarations, no calls and
   * no types — and a reader shown zero of each without being told why would reasonably
   * conclude the code has no dependencies.
   */
  readonly capabilities: RepositoryCapabilities;
  readonly architecture: ArchitectureSummary;
  readonly packages: Listing<PackageSummary>;
  readonly graph: GraphSummary;
  readonly health: HealthSummary;
  readonly metrics: RepositoryMetrics;
  /** The explorer's own limitations. Reused capabilities carry theirs on their own results. */
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface FileStatistics {
  readonly declarations: number;
  readonly imports: number;
  readonly exports: number;
  readonly outgoingEdges: number;
  readonly incomingEdges: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly declarationsByKind: Readonly<Record<string, number>>;
}

export interface FileView {
  readonly file: GraphNode;
  /** The derived package this file belongs to. */
  readonly packageName: string;
  readonly declarations: Listing<GraphNode>;
  readonly imports: Listing<CalleeResult>;
  readonly exports: Listing<CalleeResult>;
  readonly externalPackages: Listing<GraphNode>;
  readonly routes: Listing<RouteResult>;
  readonly environmentVariables: Listing<GraphNode>;
  readonly outgoingRelationships: Listing<GraphEdge>;
  readonly incomingRelationships: Listing<GraphEdge>;
  readonly statistics: FileStatistics;
}

// ---------------------------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------------------------

export interface SymbolImpactSummary {
  readonly directlyAffected: number;
  readonly indirectlyAffected: number;
  readonly unknown: number;
  readonly maxDepth: number;
  readonly routesAffected: number;
}

export interface SymbolHealthSummary {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly incomingEdges: number;
  readonly outgoingEdges: number;
  readonly isolated: boolean;
  readonly inCycle: boolean;
  readonly recursive: boolean;
  /** Repository findings whose node set includes this declaration. */
  readonly findings: readonly string[];
}

/**
 * Everything the repository records about one declaration, plus navigation.
 *
 * `explain` is the **whole** `ExplainSymbolResult`, not a copy of selected fields: that capability
 * already assembles declaration, file, locations, enclosing declaration, calls, references, routes,
 * environment variables, externals, confidence, provenance and its own limitations. Re-flattening
 * them here would duplicate assembly and let the two drift.
 */
export interface SymbolView {
  readonly explain: ExplainSymbolResult;
  /** Declarations this one contains, from `DECLARES`. Explain Symbol reports only the container. */
  readonly children: Listing<GraphNode>;
  readonly impact: SymbolImpactSummary;
  readonly health: SymbolHealthSummary;
  readonly packageName: string | null;
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

export interface PackageView {
  readonly name: string;
  readonly files: Listing<GraphNode>;
  /** Packages this one imports from, with the edges that establish it. */
  readonly dependencies: Listing<PackageEdge>;
  readonly dependents: Listing<PackageEdge>;
  readonly exports: Listing<CalleeResult>;
  readonly imports: Listing<CalleeResult>;
  readonly externalPackages: Listing<GraphNode>;
  readonly roles: Readonly<Record<Role, readonly GraphNode[]>>;
  readonly statistics: {
    readonly files: number;
    readonly declarations: number;
    readonly declarationsByKind: Readonly<Record<string, number>>;
  };
  readonly limitations: readonly Limitation[];
}

export interface PackageEdge {
  readonly name: string;
  /** Import edges crossing the boundary, capped. */
  readonly edges: Listing<GraphEdge>;
}

// ---------------------------------------------------------------------------------------------
// Dependency explorer
// ---------------------------------------------------------------------------------------------

/** One step out: relationships that exist on the subject itself. */
export interface DirectDependencies {
  readonly imports: Listing<CalleeResult>;
  readonly exports: Listing<CalleeResult>;
  readonly references: Listing<ReferenceResult>;
  readonly callees: Listing<CalleeResult>;
  readonly callers: Listing<ReferenceResult>;
}

export interface ReachedNode {
  readonly node: GraphNode;
  /** Shortest number of edges from the subject. */
  readonly depth: number;
}

/**
 * Transitive reach in both directions.
 *
 * `reverse` is produced by **Impact Analysis**, which already owns the dependents closure. `forward`
 * is a reachability walk in the opposite direction, which no existing capability performs — Impact
 * deliberately does not follow callees.
 */
export interface IndirectDependencies {
  readonly forward: Listing<ReachedNode>;
  readonly reverse: Listing<ReachedNode>;
  readonly forwardDepth: number;
  readonly reverseDepth: number;
  readonly cycles: readonly Cycle[];
  readonly connectedComponent: Listing<GraphNode>;
}

export interface DependencyView {
  readonly subject: GraphNode;
  readonly direct: DirectDependencies;
  readonly indirect: IndirectDependencies;
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// Architecture explorer
// ---------------------------------------------------------------------------------------------

export interface ArchitectureView {
  readonly controllers: Listing<GraphNode>;
  readonly services: Listing<GraphNode>;
  readonly repositories: Listing<GraphNode>;
  readonly middleware: Listing<GraphNode>;
  readonly models: Listing<GraphNode>;
  readonly tests: Listing<GraphNode>;
  readonly routes: Listing<RouteResult>;
  readonly environmentVariables: Listing<GraphNode>;
  readonly externalPackages: Listing<GraphNode>;
  readonly classes: Listing<GraphNode>;
  readonly interfaces: Listing<GraphNode>;
  readonly functions: Listing<GraphNode>;
  readonly methods: Listing<GraphNode>;
  readonly variables: Listing<GraphNode>;
  readonly namespaces: Listing<GraphNode>;
}

// ---------------------------------------------------------------------------------------------
// Cycle explorer
// ---------------------------------------------------------------------------------------------

export const CYCLE_KINDS = ['import', 'call', 'reference', 'inheritance'] as const;

export type CycleKind = (typeof CYCLE_KINDS)[number];

/**
 * One cycle, with its members named.
 *
 * Members are identifier-ordered. Every cycle is returned rather than counted, so a caller can act
 * on it — `edges` carries the relationships inside the cycle that form it.
 */
export interface Cycle {
  readonly kind: CycleKind;
  readonly relationshipTypes: readonly RelationshipType[];
  readonly nodes: readonly GraphNode[];
  readonly edges: Listing<GraphEdge>;
}

export interface CycleReport {
  readonly importCycles: Listing<Cycle>;
  readonly callCycles: Listing<Cycle>;
  readonly referenceCycles: Listing<Cycle>;
  readonly inheritanceCycles: Listing<Cycle>;
  readonly totals: Readonly<Record<CycleKind, number>>;
  readonly largest: Cycle | null;
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------------------------

export interface HotspotReport {
  readonly mostReferenced: Listing<NodeMetric>;
  /** Ordered by distinct neighbours in both directions — `fanIn + fanOut`. */
  readonly mostCoupled: Listing<NodeMetric>;
  readonly largestFanIn: Listing<NodeMetric>;
  readonly largestFanOut: Listing<NodeMetric>;
  /** Ordered by total relationships — `incomingEdges + outgoingEdges`, which counts repeats. */
  readonly mostConnectedFiles: Listing<NodeMetric>;
  readonly mostConnectedDeclarations: Listing<NodeMetric>;
  readonly largestStronglyConnectedComponent: Cycle | null;
  readonly fanIn: Distribution;
  readonly fanOut: Distribution;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export const MATCH_MODES = ['prefix', 'exact'] as const;

export type MatchMode = (typeof MATCH_MODES)[number];

/**
 * A deterministic search.
 *
 * Every field is an independent filter and all supplied fields must match. Matching is **exact or
 * prefix only** — no fuzzy matching, no ranking, no scoring — and results are alphabetical by
 * identifier throughout.
 */
export interface SearchQuery {
  /** Matched against a node's name and its identifier. */
  readonly text?: string;
  /** Matched against a file path, and against the file a declaration belongs to. */
  readonly path?: string;
  readonly kind?: NodeKind;
  readonly role?: Role;
  /** Matched against a route's method and its path. */
  readonly route?: string;
  readonly environmentVariable?: string;
  readonly externalPackage?: string;
  /**
   * Matched against a declared dependency's name.
   *
   * Separate from `externalPackage`, and it must stay separate: an `External` is a target the checker
   * resolved a reference to, a `Dependency` is a name a manifest states. Merging them would let a
   * declared-but-unused package look like a used one.
   *
   * For a region with no semantic analyser this is the **only** dependency evidence there is, which
   * is why search has to reach it: without this a Python user searching `fastapi` was told nothing
   * matched, while the graph held a `Dependency` node of exactly that name.
   */
  readonly dependency?: string;
  /** Matched against a manifest's path. */
  readonly manifest?: string;
  /**
   * Matched against a technology's display name — `React`, `Next.js`, `Docker Compose`.
   *
   * A technology is a fact about the software, of the same kind as a declaration, so it is
   * searchable like one. Without this a reader who can *see* "Next.js" on the Overview could not
   * find it by typing it, which is exactly the special-casing this search exists to avoid.
   */
  readonly technology?: string;
  /** Defaults to `prefix`. */
  readonly match?: MatchMode;
}

export interface SearchResults {
  readonly query: SearchQuery;
  readonly match: MatchMode;
  readonly declarations: Listing<GraphNode>;
  readonly files: Listing<GraphNode>;
  readonly routes: Listing<GraphNode>;
  readonly environmentVariables: Listing<GraphNode>;
  readonly externalPackages: Listing<GraphNode>;
  /** Dependencies a manifest declares. Present for every repository, analysed or not. */
  readonly dependencies: Listing<GraphNode>;
  readonly manifests: Listing<GraphNode>;
  /** Frameworks, runtimes and infrastructure the repository is built from. */
  readonly technologies: Listing<GraphNode>;
  readonly total: number;
}

// ---------------------------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------------------------

/**
 * What one explorer operation cost.
 *
 * **Deliberately carries no timing.** Elapsed milliseconds differ between runs and every response
 * must be byte-identical for identical input; timing is measured around the call instead.
 */
export interface OperationProfile {
  readonly operation: string;
  /** Calls that reached the underlying graph, after caching. */
  readonly graphApiCalls: number;
  /** Calls the shared cache answered instead. */
  readonly cacheHits: number;
  readonly queryEngineCalls: number;
  readonly largestTraversal: { readonly name: string; readonly nodes: number };
  readonly largestResult: { readonly name: string; readonly entries: number };
}

/** Anything the explorer returns, paired with what producing it cost. */
export interface Profiled<T> {
  readonly result: T;
  readonly profile: OperationProfile;
}

export type { ExplainSymbolResult, ImpactAnalysisResult, RepositoryHealthReport, HealthFinding, CallGraphHealthReport };
