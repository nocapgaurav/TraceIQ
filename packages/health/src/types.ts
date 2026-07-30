import type {
  GraphEdge,
  GraphNode,
  GraphProvenance,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
} from '@traceiq/graph-api';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

/**
 * The graph operations repository health consumes, and nothing more.
 *
 * Health is the one capability that must read the **whole** graph: a count of classes, a fan-in
 * distribution and a dependency cycle are all statements about every node and every edge. No
 * Query Engine operation enumerates, so this reads the Graph API — the abstract read model,
 * which carries no storage concept — through the four operations below.
 *
 * Both enumerating operations return **identifier-ordered** lists, which is what makes every
 * derived number and every list in the report deterministic without sorting defensively.
 */
export interface HealthGraph {
  getNodes(kind: NodeKind): readonly GraphNode[];
  getEdges(type: RelationshipType): readonly GraphEdge[];
  getRoles(nodeId: NodeId): readonly GraphRole[];
  getUnresolved(): readonly GraphUnresolvedReference[];
}

/** A count with the nodes behind it, saying plainly when the list was capped. */
export interface CountedNodes {
  readonly count: number;
  readonly nodes: readonly GraphNode[];
  /** True when `nodes` holds fewer than `count`. Never a silent cap. */
  readonly truncated: boolean;
}

/**
 * How connected one node is.
 *
 * `fanIn`/`fanOut` count **distinct** neighbours, which is what an engineer means by coupling.
 * `incomingEdges`/`outgoingEdges` count relationships, which is higher wherever the same pair is
 * related twice — two call sites in one caller, for instance. Both are reported because
 * conflating them hides that difference.
 */
export interface NodeMetric {
  readonly node: GraphNode;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly incomingEdges: number;
  readonly outgoingEdges: number;
}

export interface Distribution {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p90: number;
  readonly total: number;
}

export interface RepositorySummary {
  readonly files: number;
  readonly declarations: number;
  readonly classes: number;
  readonly interfaces: number;
  readonly methods: number;
  readonly functions: number;
  readonly routes: number;
  readonly environmentVariables: number;
  readonly externalPackages: number;
  readonly nodesByKind: Readonly<Record<NodeKind, number>>;
  readonly externalsByKind: Readonly<Record<string, number>>;
  readonly graph: {
    readonly nodes: number;
    readonly edges: number;
    readonly unresolvedReferences: number;
    readonly roleAnnotations: number;
  };
}

export interface ArchitectureReport {
  readonly roleCounts: Readonly<Record<Role, number>>;
  /** The declarations carrying each role, so a caller can name the controllers. */
  readonly byRole: Readonly<Record<Role, readonly GraphNode[]>>;
  readonly relationshipCounts: Readonly<Record<RelationshipType, number>>;
  /** `IMPORTS` and `EXPORTS`: how modules are wired together. */
  readonly dependencyGraph: { readonly nodes: number; readonly edges: number };
  /** `CALLS`: how behaviour is wired together. */
  readonly callGraph: { readonly nodes: number; readonly edges: number };
  readonly routes: number;
}

export interface ExternalUsage {
  readonly node: GraphNode;
  readonly importingFiles: number;
  readonly importEdges: number;
}

export interface DependencyHealthReport {
  /** Ordered by `fanIn` descending, then identifier. Capped — see `MOST_CONNECTED_LIMIT`. */
  readonly mostReferenced: readonly NodeMetric[];
  /** Ordered by `fanOut` descending, then identifier. */
  readonly mostDepending: readonly NodeMetric[];
  readonly mostCoupledFiles: readonly NodeMetric[];
  /** Neither referenced nor referring: unreachable and unreaching. */
  readonly isolated: CountedNodes;
  readonly withoutIncoming: CountedNodes;
  readonly withoutOutgoing: CountedNodes;
  readonly externalUsage: readonly ExternalUsage[];
}

export interface Cycle {
  /** Identifier-ordered members, so the same cycle always reads the same way. */
  readonly nodes: readonly GraphNode[];
  readonly relationshipType: RelationshipType;
}

export interface CallGraphHealthReport {
  readonly callEdges: number;
  readonly unresolvedCalls: number;
  /** Bound calls as a share of every call site the pipeline saw. */
  readonly coverage: number;
  readonly unresolvedByReason: Readonly<Record<string, number>>;
  readonly recursive: CountedNodes;
  readonly cycles: readonly Cycle[];
  readonly declarationsInCycles: number;
  /** Connected components of the call graph, ignoring direction. */
  readonly clusters: {
    readonly count: number;
    readonly largest: number;
    readonly singletons: number;
  };
  /** Declarations with no incoming call: where call chains begin. */
  readonly entryPoints: number;
  readonly maxCallDepth: number;
}

export interface DuplicateRegistration {
  readonly route: GraphNode;
  readonly ordinal: number | null;
  readonly edges: readonly GraphEdge[];
}

export interface HandlerReuse {
  readonly declaration: GraphNode;
  readonly routes: readonly GraphNode[];
}

export interface RoutingReport {
  readonly routes: number;
  readonly byMethod: Readonly<Record<string, number>>;
  /** Routes with no handler edge at all. */
  readonly orphanRoutes: readonly GraphNode[];
  /** Two handler edges at one position on one route: the same registration made twice. */
  readonly duplicateRegistrations: readonly DuplicateRegistration[];
  /** One declaration handling several routes. A fact, not a fault. */
  readonly reusedHandlers: readonly HandlerReuse[];
  readonly unresolvedHandlers: number;
  readonly handlersPerRoute: Distribution;
}

export interface VariableUsage {
  readonly node: GraphNode;
  readonly reads: number;
  readonly readingDeclarations: number;
}

export interface EnvironmentReport {
  readonly variables: number;
  /** Ordered by read count descending, then identifier. */
  readonly used: readonly VariableUsage[];
  readonly neverRead: readonly GraphNode[];
  readonly readRepeatedly: readonly VariableUsage[];
}

export const FINDING_CATEGORIES = [
  'DEPENDENCY',
  'CALL_GRAPH',
  'ROUTING',
  'ENVIRONMENT',
  'ANALYSIS_QUALITY',
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_CODES = [
  'declaration-never-referenced',
  'exported-declaration-never-imported',
  'declaration-isolated',
  'file-high-fan-in',
  'file-high-fan-out',
  'declaration-in-dependency-cycle',
  'file-in-import-cycle',
  'route-without-handler',
  'route-registered-twice',
  'environment-variable-never-read',
  'unresolved-relationships-limit-analysis',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

/**
 * Why a finding exists, as data rather than a sentence.
 *
 * `metric` names the measurement, `value` is what it came to, and `edges` are the relationships
 * that establish it — empty when the finding rests on an **absence**, which is itself the
 * evidence. Nothing here is composed text.
 */
export interface FindingEvidence {
  readonly metric: string;
  readonly value: number;
  readonly edges: readonly GraphEdge[];
}

/**
 * One fact about the repository.
 *
 * No severity, no ranking, no recommendation. A finding says what is measurably true and names
 * the nodes and edges it is true of.
 */
export interface HealthFinding {
  readonly code: FindingCode;
  readonly category: FindingCategory;
  /** Capped at `SAMPLE_LIMIT`. `nodeCount` carries the true total, so the cap is never silent. */
  readonly nodes: readonly GraphNode[];
  readonly nodeCount: number;
  readonly truncated: boolean;
  readonly evidence: FindingEvidence;
  /**
   * The **weakest** confidence observed across every edge of the relationship types this
   * finding rests on. A finding about calls can be no stronger than the call graph.
   */
  readonly confidence: ConfidenceLevel;
  readonly provenance: GraphProvenance;
}

export interface RepositoryMetrics {
  readonly averageDeclarationsPerFile: number;
  readonly averageReferencesPerDeclaration: number;
  readonly graphDensity: number;
  readonly callGraphCoverage: number;
  readonly referenceCoverage: number;
  readonly maxCallDepth: number;
  readonly fanIn: Distribution;
  readonly fanOut: Distribution;
  readonly declarationsPerFile: Distribution;
}

export const LIMITATION_CODES = [
  'call-coverage-partial',
  'calls-are-inferred',
  'no-interface-or-dynamic-dispatch',
  'unresolved-relationships-limit-analysis',
  'file-level-attribution',
  'reference-absence-is-not-proof',
  'property-references-not-recorded',
  'duplicate-route-identities-collapse',
  'route-prefixes-not-composed',
  'roles-are-judgements',
  'no-history',
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
 * What the analysis cost and how big the biggest piece of work was.
 *
 * **Deliberately carries no timing.** Elapsed milliseconds differ between runs, and the report
 * has to be byte-identical for identical input; timing is measured around `analyze` instead.
 */
export interface AnalysisStatistics {
  readonly graphApiCalls: number;
  readonly nodesScanned: number;
  readonly edgesScanned: number;
  readonly unresolvedScanned: number;
  readonly largestTraversal: {
    readonly name: string;
    readonly nodes: number;
    readonly edges: number;
  };
  readonly largestCategory: { readonly name: string; readonly entries: number };
}

/**
 * A structured architectural health report for an indexed repository.
 *
 * Every number and every list is derived from the graph as it stands. Nothing is predicted,
 * scored, graded or recommended, and there is no overall health number — a single score would
 * be a judgement dressed as a measurement.
 */
export interface RepositoryHealthReport {
  readonly summary: RepositorySummary;
  readonly architecture: ArchitectureReport;
  readonly dependencyHealth: DependencyHealthReport;
  readonly callGraphHealth: CallGraphHealthReport;
  readonly routing: RoutingReport;
  readonly environment: EnvironmentReport;
  readonly findings: readonly HealthFinding[];
  readonly metrics: RepositoryMetrics;
  readonly limitations: readonly Limitation[];
  readonly statistics: AnalysisStatistics;
}
