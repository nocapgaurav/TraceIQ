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
// POST /analysis, GET /analysis/{id}
// ---------------------------------------------------------------------------------------------

/**
 * Repository Analysis, as the wire carries it.
 *
 * Hand-written like the rest of this file. **There is no percentage here and there must not be**: the
 * server reports which stage it is on, because that is what it can observe. A field this app computed to
 * look like progress would be invented.
 */
export type AnalysisStageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface AnalysisStage {
  readonly name: string;
  readonly label: string;
  readonly status: AnalysisStageStatus;
  /** What the stage produced, once it has. Null while pending. */
  readonly detail: string | null;
}

export type AnalysisJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AnalysisResult {
  readonly repository: string;
  readonly slug: string;
  readonly htmlUrl: string;
  readonly files: number;
  readonly declarations: number;
  readonly nodes: number;
  readonly edges: number;
  readonly routes: number;
  readonly environmentVariables: number;
  readonly externalPackages: number;
  readonly callEdges: number;
  readonly unresolvedCalls: number;
  readonly unresolvedReferences: number;
  /** What the repository turned out to be made of, and how deeply it was read. */
  readonly languages: readonly LanguageFileCount[];
  readonly regions: number;
  readonly depth: AnalysisDepth;
  readonly isPolyglot: boolean;
  readonly analyzerFailures: readonly { readonly analyzer: string; readonly failure: string }[];
}

export interface AnalysisJob {
  readonly id: string;
  readonly url: string;
  readonly slug: string | null;
  readonly htmlUrl: string | null;
  readonly status: AnalysisJobStatus;
  readonly stages: readonly AnalysisStage[];
  readonly result: AnalysisResult | null;
  readonly error: { readonly code: string; readonly detail: string; readonly hint: string } | null;
  /** How long the analysis has taken. Elapsed time, never a share of an unknown total. */
  readonly elapsedMs: number;
  readonly workspaceWarning: string | null;
}

/** What `GET /analysis` returns: the running analysis if there is one, and the recent history. */
export interface AnalysisList {
  readonly running: AnalysisJob | null;
  readonly entries: readonly AnalysisJob[];
}

/** `accepted: false` means an analysis was already running; `job` is that one, to follow instead. */
export interface StartAnalysis {
  readonly accepted: boolean;
  readonly job: AnalysisJob;
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

/** How deeply one part of a repository was actually analysed. Ordered least to most capable. */
export type AnalysisDepth = 'universal' | 'structural' | 'semantic' | 'framework';

export interface LanguageFileCount {
  readonly language: string;
  readonly files: number;
}

/**
 * One technology the repository is built from, and how far analysis got with it.
 *
 * A region is a directory anchored on a dependency manifest, or the repository root.
 */
export interface RegionCapability {
  /** Repository-relative directory; `''` for the repository root. */
  readonly path: string;
  readonly primaryLanguage: string | null;
  readonly languages: readonly LanguageFileCount[];
  readonly ecosystems: readonly string[];
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly depth: AnalysisDepth;
  /** Why analysis stopped where it did, in words the API supplies to be shown verbatim. */
  readonly reason: string;
}

/**
 * What this repository's graph can and cannot answer.
 *
 * **The UI was blind to this and it showed.** `/overview` has carried it, but the type omitted it, so
 * the interface had no way to know what language it was looking at — and said "TypeScript" for every
 * repository, including a Python one. Anything that presents an absence must read this first: no calls
 * means "none found" for an analysed region and "never looked at" for a `universal` one.
 */
export interface RepositoryCapabilities {
  readonly depth: AnalysisDepth;
  readonly regions: readonly RegionCapability[];
  readonly languages: readonly LanguageFileCount[];
  readonly isPolyglot: boolean;
}

/**
 * One technology the repository is built from, with the evidence for it.
 *
 * Hand-written like the rest of this file: the frontend consumes the REST API and imports no
 * `@traceiq` package, so the wire shape is declared here rather than shared.
 */
export interface TechnologySummary {
  readonly id: string;
  readonly name: string;
  /** `frontend`, `backend`, `infrastructure`, `build`, `testing`, `data`. */
  readonly category: string;
  /** The region it was found in; `''` is the repository root. */
  readonly regionPath: string;
  readonly confidence: string;
  /** The files that prove it, and what was found in each. Shown verbatim. */
  readonly evidence: string;
}

export interface Overview {
  /**
   * What the repository is built with.
   *
   * Optional because an older API answers without it, and a UI that crashed on a field a
   * deployment mid-upgrade does not send would be worse than one that shows nothing.
   */
  readonly technologies?: readonly TechnologySummary[];
  readonly capabilities: RepositoryCapabilities;
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

// ---------------------------------------------------------------------------------------------
// POST /chat, POST /chat/stream
// ---------------------------------------------------------------------------------------------

/**
 * Repository Chat, as the wire carries it.
 *
 * Hand-written like the rest of this file: the frontend cannot import `@traceiq/ai`, so these mirror
 * `apps/api/src/chat.ts` by contract rather than by type. Only the fields this UI reads are declared.
 *
 * A citation is **flat** — the fact's fields, not a fact object — because that is what the API sends and
 * what a consumer needs to display the evidence without a second request.
 */
export interface ChatCitation {
  readonly factId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: string;
  /** Which capability established the fact. */
  readonly provenance: string;
}

/** What a cap left out of the facts the model was shown. Never omitted, so a cap is never silent. */
export interface ChatOmission {
  readonly part: string;
  readonly kept: number;
  readonly total: number;
}

export interface ChatGrounding {
  readonly kind: string;
  readonly subject: string | null;
  readonly factCount: number;
  /** How many of those facts are the stable core the provider can reuse between questions. */
  readonly coreCount: number;
  /** What the question was taken to be about. Decides the supplement, never the core. */
  readonly intent: string;
  readonly tier: string;
  readonly tokens: number;
  /** Identity of the facts that grounded this answer. Two equal digests ground identically. */
  readonly digest: string;
  readonly omissions: readonly ChatOmission[];
}

export type ChatVerdict = 'grounded' | 'ungrounded' | 'unverifiable';

export interface ChatAnswer {
  readonly question: string;
  readonly subject: ChatSubject;
  readonly text: string;
  readonly verdict: ChatVerdict;
  readonly citations: readonly ChatCitation[];
  /** Identifiers the answer named that no fact contained. Empty unless the verdict is `ungrounded`. */
  readonly fabricatedIdentifiers: readonly string[];
  /**
   * Package, framework and dependency names the answer claimed that no fact carried.
   *
   * Kept apart from `fabricatedIdentifiers` because the two differ in how damning they are: an
   * invented identifier has no defence, while an unsupported term may be a real thing the budget did
   * not reach. The UI says which.
   */
  readonly unsupportedTerms: readonly string[];
  readonly unknownCitations: readonly string[];
  readonly grounding: ChatGrounding;
  readonly model: string;
  readonly stopReason: string;
  readonly usage: { readonly promptTokens: number | null; readonly outputTokens: number | null };
}

/**
 * What to ask about, already resolved.
 *
 * The API refuses to turn free text into a subject, so this UI resolves one through `GET /search` — the
 * Explorer, not the AI layer — and sends the result.
 */
export type ChatSubject =
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'impact'; readonly id: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'route'; readonly method: string; readonly path: string }
  | { readonly kind: 'repository' }
  | { readonly kind: 'search'; readonly query: { readonly text: string } };

/** One prior turn, replayed as conversation. Facts are never replayed — each turn grounds itself. */
export interface ChatHistoryTurn {
  readonly question: string;
  readonly answer: string;
}

export interface ChatRequest {
  readonly question: string;
  readonly subject: ChatSubject;
  readonly history?: readonly ChatHistoryTurn[];
  readonly maxOutputTokens?: number;
}

/**
 * A frame from `POST /chat/stream`.
 *
 * `grounding` always arrives before any `delta`, and again if the prompt had to be re-projected smaller.
 * `error` is terminal and arrives instead of `complete`: once the stream has opened the status line is
 * gone, so a mid-answer failure cannot be an HTTP error.
 */
/**
 * Which stage the answer has reached.
 *
 * Mirrors the API's own closed vocabulary. It exists because the wait is long and was measured: the gap
 * between the last preparatory frame and the first token was 89 seconds on the reference stack, all of
 * it the model reading the prompt, with nothing on the wire.
 */
export type ChatPhase =
  | 'acquiring-context'
  | 'projecting'
  | 're-projecting'
  | 'awaiting-model'
  | 'generating'
  | 'verifying';

export type ChatEvent =
  | { readonly type: 'open'; readonly model: string | null; readonly contextWindow: number | null }
  | { readonly type: 'status'; readonly phase: ChatPhase }
  | { readonly type: 'grounding'; readonly grounding: ChatGrounding }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'complete'; readonly answer: ChatAnswer }
  | {
      readonly type: 'error';
      readonly code: string;
      readonly detail: string;
      readonly hint: string;
      /** Whatever had already been generated when it failed. */
      readonly partial: string | null;
    };
