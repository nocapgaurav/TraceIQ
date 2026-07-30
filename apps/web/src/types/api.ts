/**
 * The wire format, as this app reads it.
 *
 * **Hand-written on purpose.** The frontend must not import a backend package, so it cannot reuse
 * `@traceiq/explorer`'s types — the only contract between the two is the REST surface. These are a
 * **projection** of that surface rather than a mirror of it: each interface declares the fields this UI
 * reads and nothing more, so a payload growing a field does not require a change here.
 *
 * Every response is `{ success, data, meta }`; `data` is a capability result the API returns unchanged.
 */

export interface ResponseMeta {
  readonly endpoint: string;
  readonly capability: string;
  readonly graphApiCalls: number;
}

export interface ApiSuccess<T> {
  readonly success: true;
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface ApiFailure {
  readonly success: false;
  readonly error: { readonly code: string; readonly detail: string; readonly hint: string };
  readonly meta: ResponseMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** A capped list. `total` is exact even where `entries` is not, so a cap is never silent. */
export interface Listing<T> {
  readonly entries: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface Limitation {
  readonly code: string;
  readonly detail: string;
  readonly affected: number | null;
}

export interface SourceRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface Provenance {
  readonly producer: string;
  readonly fileId: string | null;
  readonly evidence: string;
}

export type NodeKind =
  | 'File'
  | 'Class'
  | 'Interface'
  | 'TypeAlias'
  | 'Enum'
  | 'EnumMember'
  | 'Function'
  | 'Method'
  | 'Property'
  | 'Accessor'
  | 'Constructor'
  | 'Variable'
  | 'Namespace'
  | 'Route'
  | 'EnvironmentVariable'
  | 'External';

export type Confidence = 'CERTAIN' | 'RESOLVED' | 'INFERRED' | 'AMBIGUOUS';

export type Role = 'Controller' | 'Service' | 'Repository' | 'Middleware' | 'Model' | 'Test';

export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly fileId: string | null;
  readonly containerChain?: string | null;
  readonly isExported: boolean;
  readonly externalKind: string | null;
  readonly confidence: Confidence;
  readonly provenance: Provenance;
  readonly locations: readonly SourceRange[];
}

export interface GraphEdge {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence: Confidence;
  readonly location: SourceRange;
}

export interface Reference {
  readonly edge: GraphEdge;
  readonly source: GraphNode | null;
}

export interface Callee {
  readonly edge: GraphEdge;
  readonly target: GraphNode | null;
}

// ---------------------------------------------------------------------------------------------
// GET /version, /ping
// ---------------------------------------------------------------------------------------------

export interface VersionInfo {
  readonly version: string;
  readonly scanned: boolean;
  readonly databasePath: string;
}

// ---------------------------------------------------------------------------------------------
// POST /scan
// ---------------------------------------------------------------------------------------------

export interface ScanSummary {
  readonly repository: string;
  readonly files: number;
  readonly declarations: number;
  readonly nodes: number;
  readonly edges: number;
  readonly routes: number;
  readonly externalPackages: number;
  readonly callEdges: number;
  readonly unresolvedCalls: number;
}

// ---------------------------------------------------------------------------------------------
// GET /overview
// ---------------------------------------------------------------------------------------------

export interface PackageSummary {
  readonly name: string;
  readonly files: number;
  readonly declarations: number;
  readonly dependencies: number;
  readonly dependents: number;
}

export interface Distribution {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p90: number;
  readonly total: number;
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

export interface Overview {
  readonly repository: {
    readonly files: number;
    readonly declarations: number;
    readonly classes: number;
    readonly interfaces: number;
    readonly methods: number;
    readonly functions: number;
    readonly routes: number;
    readonly environmentVariables: number;
    readonly externalPackages: number;
    readonly nodesByKind: Readonly<Record<string, number>>;
    readonly externalsByKind: Readonly<Record<string, number>>;
  };
  readonly architecture: {
    readonly roleCounts: Readonly<Record<Role, number>>;
    readonly routes: number;
    readonly environmentVariables: number;
    readonly externalPackages: number;
    readonly dependencyGraph: { readonly nodes: number; readonly edges: number };
    readonly callGraph: { readonly nodes: number; readonly edges: number };
  };
  readonly packages: Listing<PackageSummary>;
  readonly graph: {
    readonly nodes: number;
    readonly edges: number;
    readonly unresolvedReferences: number;
    readonly relationshipCounts: Readonly<Record<string, number>>;
    readonly nodesByKind: Readonly<Record<string, number>>;
  };
  readonly health: {
    readonly callGraphCoverage: number;
    readonly referenceCoverage: number;
    readonly maxCallDepth: number;
    readonly declarationsInCycles: number;
    readonly isolatedDeclarations: number;
    readonly findingCounts: Readonly<Record<string, number>>;
    readonly limitationCodes: readonly string[];
  };
  readonly metrics: RepositoryMetrics;
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// GET /packages, /packages/{name}
// ---------------------------------------------------------------------------------------------

export interface PackageEdge {
  readonly name: string;
  readonly edges: Listing<GraphEdge>;
}

export interface PackageView {
  readonly name: string;
  readonly files: Listing<GraphNode>;
  readonly dependencies: Listing<PackageEdge>;
  readonly dependents: Listing<PackageEdge>;
  readonly externalPackages: Listing<GraphNode>;
  readonly roles: Readonly<Record<Role, readonly GraphNode[]>>;
  readonly statistics: {
    readonly files: number;
    readonly declarations: number;
    readonly declarationsByKind: Readonly<Record<string, number>>;
  };
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// GET /files/{path}
// ---------------------------------------------------------------------------------------------

export interface RouteResult {
  readonly node: GraphNode;
  readonly method: string;
  readonly path: string;
  readonly composition: {
    readonly composed: boolean;
    readonly effectivePath: string;
    readonly note: string;
  };
  readonly handlers: readonly { readonly declaration: GraphNode | null }[];
}

export interface FileView {
  readonly file: GraphNode;
  readonly packageName: string;
  readonly declarations: Listing<GraphNode>;
  readonly imports: Listing<Callee>;
  readonly exports: Listing<Callee>;
  readonly externalPackages: Listing<GraphNode>;
  readonly routes: Listing<RouteResult>;
  readonly environmentVariables: Listing<GraphNode>;
  readonly statistics: {
    readonly declarations: number;
    readonly imports: number;
    readonly exports: number;
    readonly fanIn: number;
    readonly fanOut: number;
    readonly declarationsByKind: Readonly<Record<string, number>>;
  };
}

// ---------------------------------------------------------------------------------------------
// GET /symbol/{id}
// ---------------------------------------------------------------------------------------------

export interface ExplainSymbol {
  readonly declaration: { readonly node: GraphNode; readonly roles: readonly { readonly role: Role; readonly confidence: Confidence; readonly evidence: string }[] };
  readonly kind: NodeKind;
  readonly sourceFile: { readonly id: string; readonly path: string } | null;
  readonly locations: readonly SourceRange[];
  readonly enclosingDeclaration: { readonly declaration: GraphNode | null } | null;
  readonly incomingCalls: readonly Reference[];
  readonly outgoingCalls: readonly Callee[];
  readonly references: readonly Reference[];
  readonly typeReferences: readonly Reference[];
  readonly routes: readonly { readonly explanation: { readonly route: RouteResult }; readonly position: string }[];
  readonly environmentVariables: readonly { readonly node: GraphNode; readonly reads: readonly Reference[] }[];
  readonly externalDependencies: readonly { readonly node: GraphNode }[];
  readonly confidence: Confidence;
  readonly provenance: Provenance;
  readonly unresolved: readonly { readonly scope: string; readonly result: { readonly reference: { readonly text: string; readonly reason: string } } }[];
  readonly limitations: readonly Limitation[];
}

export interface SymbolView {
  readonly explain: ExplainSymbol;
  readonly children: Listing<GraphNode>;
  readonly impact: ImpactSummary;
  readonly health: SymbolHealth;
  readonly packageName: string | null;
}

export interface ImpactSummary {
  readonly directlyAffected: number;
  readonly indirectlyAffected: number;
  readonly unknown: number;
  readonly maxDepth: number;
  readonly routesAffected: number;
}

export interface SymbolHealth {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly incomingEdges: number;
  readonly outgoingEdges: number;
  readonly isolated: boolean;
  readonly inCycle: boolean;
  readonly recursive: boolean;
  readonly findings: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// GET /impact/{id}
// ---------------------------------------------------------------------------------------------

export interface AffectedNode {
  readonly node: GraphNode;
  readonly category: 'DIRECT' | 'INDIRECT';
  readonly depth: number;
  readonly via: GraphEdge;
}

export interface ImpactAnalysis {
  readonly target: { readonly node: GraphNode };
  readonly directlyAffected: readonly AffectedNode[];
  readonly indirectlyAffected: readonly AffectedNode[];
  readonly callers: readonly Reference[];
  readonly callees: readonly Callee[];
  readonly typeReferences: readonly Reference[];
  readonly imports: readonly Reference[];
  readonly environmentVariables: readonly { readonly node: GraphNode }[];
  readonly externalDependencies: readonly { readonly node: GraphNode }[];
  readonly routesAffected: readonly { readonly route: RouteResult; readonly reaches: string }[];
  readonly unknown: readonly { readonly scope: string; readonly at: string; readonly result: { readonly reference: { readonly text: string; readonly reason: string } } }[];
  readonly statistics: { readonly nodesVisited: number; readonly maxDepth: number };
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// GET /route, /routes
// ---------------------------------------------------------------------------------------------

export interface RouteSummary {
  readonly route: { readonly id: string; readonly name: string; readonly kind: NodeKind };
  readonly method: string;
  readonly path: string;
  readonly effectivePath: string;
  readonly composed: boolean;
  readonly handlers: number;
}

export interface RouteExplanationView {
  readonly route: RouteSummary;
  readonly method: string;
  readonly pathComposition: { readonly composed: boolean; readonly effectivePath: string; readonly note: string };
  readonly chain: readonly {
    readonly position: string;
    readonly ordinal: number | null;
    readonly declaration: GraphNode | null;
  }[];
  readonly controllers: readonly { readonly ref: { readonly id: string; readonly name: string } }[];
  readonly services: readonly { readonly ref: { readonly id: string; readonly name: string } }[];
  readonly repositories: readonly { readonly ref: { readonly id: string; readonly name: string } }[];
  readonly environmentVariables: Listing<GraphNode>;
  readonly externalPackages: Listing<{ readonly id: string; readonly name: string }>;
  readonly health: {
    readonly handlersLinked: number;
    readonly handlersUnlinked: number;
  };
  readonly unresolvedHandlers: readonly { readonly text: string; readonly reason: string }[];
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// GET /architecture
// ---------------------------------------------------------------------------------------------

export interface TreeRef {
  readonly id: string;
  readonly name: string;
  readonly kind: NodeKind;
}

export interface ArchitectureGroup {
  readonly group: string;
  readonly category: 'role' | 'kind';
  readonly entries: Listing<TreeRef>;
}

export interface DependencyTreeNode {
  readonly name: string;
  readonly dependsOn: Listing<{ readonly name: string; readonly edges: number }>;
  readonly dependedOnBy: Listing<{ readonly name: string; readonly edges: number }>;
}

export interface PackageTreeNode {
  readonly name: string;
  readonly files: Listing<{ readonly file: TreeRef; readonly declarations: Listing<TreeRef> }>;
  readonly declarations: number;
}

export interface RoleTreeNode {
  readonly role: Role;
  readonly packages: Listing<{ readonly name: string; readonly declarations: Listing<TreeRef> }>;
  readonly total: number;
}

export interface ArchitectureNavigation {
  readonly packages: Listing<PackageSummary>;
  readonly architectureTree: Listing<ArchitectureGroup>;
  readonly packageTree: Listing<PackageTreeNode>;
  readonly roleTree: Listing<RoleTreeNode>;
  readonly dependencyTree: Listing<DependencyTreeNode>;
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------------------------

export interface HealthFinding {
  readonly code: string;
  readonly category: string;
  readonly nodes: readonly GraphNode[];
  readonly nodeCount: number;
  readonly truncated: boolean;
  readonly evidence: { readonly metric: string; readonly value: number };
  readonly confidence: Confidence;
}

export interface HealthReport {
  readonly summary: {
    readonly files: number;
    readonly declarations: number;
    readonly graph: { readonly nodes: number; readonly edges: number; readonly unresolvedReferences: number };
  };
  readonly metrics: RepositoryMetrics;
  readonly callGraphHealth: {
    readonly callEdges: number;
    readonly unresolvedCalls: number;
    readonly coverage: number;
    readonly unresolvedByReason: Readonly<Record<string, number>>;
    readonly recursive: { readonly count: number; readonly nodes: readonly GraphNode[] };
    readonly cycles: readonly { readonly nodes: readonly GraphNode[]; readonly relationshipType: string }[];
    readonly declarationsInCycles: number;
    readonly clusters: { readonly count: number; readonly largest: number; readonly singletons: number };
    readonly entryPoints: number;
    readonly maxCallDepth: number;
  };
  readonly dependencyHealth: {
    readonly mostReferenced: readonly NodeMetric[];
    readonly mostCoupledFiles: readonly NodeMetric[];
    readonly isolated: { readonly count: number };
    readonly withoutIncoming: { readonly count: number };
    readonly withoutOutgoing: { readonly count: number };
  };
  readonly routing: {
    readonly routes: number;
    readonly byMethod: Readonly<Record<string, number>>;
    readonly orphanRoutes: readonly GraphNode[];
    readonly duplicateRegistrations: readonly { readonly method: string; readonly path: string }[];
    readonly unresolvedHandlers: number;
  };
  readonly environment: {
    readonly variables: number;
    readonly used: readonly { readonly node: GraphNode; readonly reads: number }[];
    readonly neverRead: readonly { readonly node: GraphNode }[];
  };
  readonly findings: readonly HealthFinding[];
  readonly limitations: readonly Limitation[];
}

export interface NodeMetric {
  readonly node: GraphNode;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly incomingEdges: number;
  readonly outgoingEdges: number;
}

// ---------------------------------------------------------------------------------------------
// GET /hotspots, /cycles
// ---------------------------------------------------------------------------------------------

export interface HotspotReport {
  readonly mostReferenced: Listing<NodeMetric>;
  readonly mostCoupled: Listing<NodeMetric>;
  readonly largestFanIn: Listing<NodeMetric>;
  readonly largestFanOut: Listing<NodeMetric>;
  readonly mostConnectedFiles: Listing<NodeMetric>;
  readonly mostConnectedDeclarations: Listing<NodeMetric>;
  readonly largestStronglyConnectedComponent: Cycle | null;
  readonly fanIn: Distribution;
  readonly fanOut: Distribution;
}

export interface Cycle {
  readonly kind: string;
  readonly relationshipTypes: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly edges: Listing<GraphEdge>;
}

export interface CycleReport {
  readonly importCycles: Listing<Cycle>;
  readonly callCycles: Listing<Cycle>;
  readonly referenceCycles: Listing<Cycle>;
  readonly inheritanceCycles: Listing<Cycle>;
  readonly totals: Readonly<Record<string, number>>;
  readonly largest: Cycle | null;
  readonly limitations: readonly Limitation[];
}

// ---------------------------------------------------------------------------------------------
// GET /search
// ---------------------------------------------------------------------------------------------

export interface SearchResults {
  readonly query: Readonly<Record<string, string>>;
  readonly match: 'prefix' | 'exact';
  readonly declarations: Listing<GraphNode>;
  readonly files: Listing<GraphNode>;
  readonly routes: Listing<GraphNode>;
  readonly environmentVariables: Listing<GraphNode>;
  readonly externalPackages: Listing<GraphNode>;
  readonly total: number;
}

// ---------------------------------------------------------------------------------------------
// GET /dependencies/{id}
// ---------------------------------------------------------------------------------------------

export interface DependencyNavigation {
  readonly subject: {
    readonly kind: string;
    readonly id: string | null;
    readonly name: string;
    readonly files: Listing<TreeRef>;
  };
  readonly directDependencies: Listing<{ readonly ref: TreeRef; readonly depth: number }>;
  readonly reverseDependencies: Listing<{ readonly ref: TreeRef; readonly depth: number }>;
  readonly importGraph: { readonly outgoing: Listing<GraphEdge>; readonly incoming: Listing<GraphEdge> };
  readonly referenceGraph: { readonly outgoing: Listing<GraphEdge>; readonly incoming: Listing<GraphEdge> };
  readonly callGraph: { readonly outgoing: Listing<GraphEdge>; readonly incoming: Listing<GraphEdge> };
  readonly closure: Listing<{ readonly node: GraphNode; readonly depth: number }>;
  readonly reverseClosure: Listing<{ readonly node: GraphNode; readonly depth: number }>;
  readonly cycles: readonly Cycle[];
  readonly connectedComponent: Listing<GraphNode>;
  readonly limitations: readonly Limitation[];
}
