import type { ExplainSymbolResult } from '@traceiq/explain';
import type {
  Cycle,
  Listing,
  PackageSummary,
  ReachedNode,
  SymbolHealthSummary,
  SymbolImpactSummary,
} from '@traceiq/explorer';
import type { GraphEdge, GraphNode, GraphUnresolvedReference, NodeKind } from '@traceiq/graph-api';
import type { PathComposition } from '@traceiq/query';
import type { NodeId, Role } from '@traceiq/types';

/** How many entries a navigation list carries. A cap is never silent — see `Listing`. */
export const NAVIGATION_LIMIT = 100;

/**
 * A node as a tree carries it: identifier, name and kind.
 *
 * A tree is a navigation index, not a reading surface — its job is to let a caller find an
 * identifier and then ask `browseSymbol` or `browseFile` about it. Carrying the whole `GraphNode` at
 * every position would multiply a repository-wide tree into hundreds of kilobytes of fields the
 * caller has not asked for yet. All three fields come straight from the node.
 */
export interface TreeRef {
  readonly id: NodeId;
  readonly name: string;
  readonly kind: NodeKind;
}

/** A node reached by traversal, with the shortest distance to it. */
export interface ReachedRef {
  readonly ref: TreeRef;
  readonly depth: number;
}

export const LIMITATION_CODES = [
  'route-prefix-composition-unsupported',
  'route-handler-not-linked',
  'role-reach-follows-coupling',
  'roles-are-judgements',
  'call-coverage-partial',
  'package-boundary-is-derived-from-paths',
  'cross-package-imports-resolve-outside-analysis',
  'capped-lists',
] as const;

export type LimitationCode = (typeof LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: LimitationCode;
  /** Fixed text for this code. Never composed. */
  readonly detail: string;
  readonly affected: number | null;
}

// ---------------------------------------------------------------------------------------------
// Explain Route
// ---------------------------------------------------------------------------------------------

/** A route named by method and path, or by its graph identifier. */
export type RouteSelector = { readonly method: string; readonly path: string } | NodeId;

export interface RouteSummary {
  readonly route: TreeRef;
  readonly method: string;
  /** The path exactly as written at the registration. */
  readonly path: string;
  /**
   * The path a request would match, as far as the graph can tell.
   *
   * Equal to `path` whenever `composed` is false, which it always is today: no mount information
   * reaches the graph. The route is never reported under a path the graph does not state.
   */
  readonly effectivePath: string;
  readonly composed: boolean;
  readonly handlers: number;
}

export const CHAIN_POSITIONS = ['middleware', 'handler'] as const;

export type ChainPosition = (typeof CHAIN_POSITIONS)[number];

/**
 * One link in a route's chain.
 *
 * `explain` is the **whole** `ExplainSymbolResult` for the handler, taken from Repository Explorer's
 * `browseSymbol`. Nothing is re-assembled here.
 */
export interface HandlerStep {
  readonly position: ChainPosition;
  /** Position in the chain, from the `HANDLED_BY` edge. */
  readonly ordinal: number | null;
  readonly declaration: GraphNode | null;
  readonly explain: ExplainSymbolResult | null;
  readonly impact: SymbolImpactSummary | null;
  readonly health: SymbolHealthSummary | null;
}

export interface RouteImpactSummary {
  readonly directlyAffected: number;
  readonly indirectlyAffected: number;
  readonly unknown: number;
  readonly maxDepth: number;
}

export interface RouteCallGraphSummary {
  readonly callers: number;
  readonly callees: number;
  /** Declarations reached from the chain by coupling, at any depth. */
  readonly reached: number;
  readonly maxDepth: number;
  readonly inCycle: number;
}

export interface RouteHealthSummary {
  readonly handlersLinked: number;
  readonly handlersUnlinked: number;
  readonly isolatedHandlers: number;
  readonly recursiveHandlers: number;
  /** Repository finding codes naming any declaration in the chain. */
  readonly findings: readonly string[];
}

/**
 * Everything the repository records about one route.
 *
 * `controllers`, `services`, `repositories` and `middleware` are declarations carrying that role
 * **reached from the chain**, each with the distance to it — see the `role-reach-follows-coupling`
 * limitation for what "reached" means.
 */
export interface RouteExplanationView {
  readonly route: RouteSummary;
  readonly method: string;
  readonly pathComposition: PathComposition;
  /** The whole chain in running order: middleware first, handler last. */
  readonly chain: readonly HandlerStep[];
  readonly middleware: readonly HandlerStep[];
  readonly handler: HandlerStep | null;
  readonly controllers: readonly ReachedRef[];
  readonly services: readonly ReachedRef[];
  readonly repositories: readonly ReachedRef[];
  readonly middlewareRoles: readonly ReachedRef[];
  /** Declarations and externals the chain depends on, at any depth. */
  readonly dependencies: Listing<ReachedRef>;
  readonly externalPackages: Listing<TreeRef>;
  readonly environmentVariables: Listing<GraphNode>;
  readonly impact: RouteImpactSummary;
  readonly callGraph: RouteCallGraphSummary;
  readonly health: RouteHealthSummary;
  /** Handlers the pipeline could not link, kept visible rather than omitted. */
  readonly unresolvedHandlers: readonly GraphUnresolvedReference[];
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// Architecture navigation
// ---------------------------------------------------------------------------------------------

export const GROUP_CATEGORIES = ['role', 'kind'] as const;

export type GroupCategory = (typeof GROUP_CATEGORIES)[number];

export interface ArchitectureGroup {
  readonly group: string;
  readonly category: GroupCategory;
  readonly entries: Listing<TreeRef>;
}

export interface FileTreeNode {
  readonly file: TreeRef;
  readonly declarations: Listing<TreeRef>;
}

export interface PackageTreeNode {
  readonly name: string;
  readonly files: Listing<FileTreeNode>;
  readonly declarations: number;
}

export interface RoleTreePackage {
  readonly name: string;
  readonly declarations: Listing<TreeRef>;
}

export interface RoleTreeNode {
  readonly role: Role;
  readonly packages: Listing<RoleTreePackage>;
  readonly total: number;
}

export interface DependencyTreeEdge {
  readonly name: string;
  readonly edges: number;
}

export interface DependencyTreeNode {
  readonly name: string;
  readonly dependsOn: Listing<DependencyTreeEdge>;
  readonly dependedOnBy: Listing<DependencyTreeEdge>;
}

/**
 * The repository's architecture as four trees.
 *
 * Repository Explorer's flat grouping is **used to build these and not re-emitted**: `architectureTree`
 * already carries every role and kind group, so embedding the explorer's `ArchitectureView` alongside
 * would state the same declarations twice in one response — 420 KB of it on this repository. A caller
 * wanting the full `GraphNode` for anything in a tree asks the explorer for it by identifier.
 */
export interface ArchitectureNavigation {
  readonly packages: Listing<PackageSummary>;
  readonly architectureTree: Listing<ArchitectureGroup>;
  readonly packageTree: Listing<PackageTreeNode>;
  readonly roleTree: Listing<RoleTreeNode>;
  readonly dependencyTree: Listing<DependencyTreeNode>;
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// Dependency navigation
// ---------------------------------------------------------------------------------------------

export const SUBJECT_KINDS = ['package', 'file', 'declaration', 'route'] as const;

export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** A package by name, or anything else by graph identifier. */
export type DependencySubject = { readonly package: string } | NodeId;

export interface DependencySubjectRef {
  readonly kind: SubjectKind;
  /** `null` for a package, which is a derived grouping rather than a node. */
  readonly id: NodeId | null;
  readonly name: string;
  /** The files a subject covers: one for a file, its package's for a package, the chain's for a route. */
  readonly files: Listing<TreeRef>;
}

/** Relationships of one type around the subject, in both directions. */
export interface RelationshipGraph {
  readonly outgoing: Listing<GraphEdge>;
  readonly incoming: Listing<GraphEdge>;
}

export interface DependencyNavigation {
  readonly subject: DependencySubjectRef;
  readonly directDependencies: Listing<ReachedRef>;
  readonly reverseDependencies: Listing<ReachedRef>;
  readonly importGraph: RelationshipGraph;
  readonly referenceGraph: RelationshipGraph;
  readonly callGraph: RelationshipGraph;
  readonly closure: Listing<ReachedNode>;
  readonly reverseClosure: Listing<ReachedNode>;
  readonly cycles: readonly Cycle[];
  readonly connectedComponent: Listing<GraphNode>;
  readonly impact: RouteImpactSummary;
  readonly health: DependencyHealthSummary;
  readonly limitations: readonly Limitation[];
}

export interface DependencyHealthSummary {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly isolated: boolean;
  readonly inCycle: boolean;
  readonly findings: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------------------------

/**
 * What one navigation operation cost.
 *
 * **Carries no timing.** Elapsed milliseconds differ between runs and every response must be
 * byte-identical for identical input, so callers time the call themselves.
 */
export interface OperationProfile {
  readonly operation: string;
  /** Reads that reached the database, after the shared cache. */
  readonly graphApiCalls: number;
  readonly cacheHits: number;
  readonly queryEngineCalls: number;
  readonly explorerCalls: number;
  readonly largestTraversal: { readonly name: string; readonly nodes: number };
  readonly largestResult: { readonly name: string; readonly entries: number };
}

export interface Profiled<T> {
  readonly result: T;
  readonly profile: OperationProfile;
}

export type { Cycle, Listing, PackageSummary, ReachedNode, PathComposition };
