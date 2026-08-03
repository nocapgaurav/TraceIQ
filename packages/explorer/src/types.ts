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
   * What non-code artefacts this repository holds, counted by family.
   *
   * **The shortest true answer to "what is this repository made of" for a repository whose files are
   * mostly not source.** A tree of forty workflows and one Python script is not a Python project, and
   * until this existed nothing above the graph could say so — the language distribution reported Python,
   * the declaration count reported the script, and every surface agreed on a description the repository
   * would not recognise.
   *
   * Sorted by file count descending, ties by family name, so two scans agree.
   */
  readonly artifacts: readonly ArtifactFamilySummary[];
  /**
   * The artefacts that describe the running system, each with what it declares.
   *
   * **Counts cannot answer an architecture question and this is what can.** "Three compose files" tells a
   * reader nothing; "docker-compose.yml declares api, worker, postgres and redis, and api depends on
   * postgres" is the architecture — and on a repository whose services are wired in YAML rather than in
   * code, it is the *only* place that architecture is written down.
   *
   * Restricted to `SYSTEM_ARTIFACT_KINDS` and capped, because an `.editorconfig` describes nothing about
   * the running system however carefully it was read. Ordered by family significance then by path, so two
   * scans agree and no ordering here is a ranking of importance.
   */
  readonly keyArtifacts: Listing<ArtifactDigest>;
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

/** One artefact family the repository holds, with how much of it there is. */
export interface ArtifactFamilySummary {
  /** The family, from `ARTIFACT_KINDS`. */
  readonly kind: string;
  readonly files: number;
  /** Structural pieces extracted across those files: jobs, steps, services, headings. */
  readonly elements: number;
  /** A few paths, identifier-ordered. Deliberately not a ranking. */
  readonly examples: readonly string[];
}

/**
 * One artefact, compressed to what a repository-wide answer can use.
 *
 * Deliberately much smaller than an `ArtifactView`: the names of the things it declares rather than every
 * element, and the paths it reaches rather than every edge. A repository-wide projection has a token
 * budget, and an answer needs to know that a compose file declares `api`, `postgres` and `redis` far more
 * than it needs each service's volume list.
 */
export interface ArtifactDigest {
  readonly path: string;
  readonly kind: string;
  /** What it declares, counted by element kind, largest first. */
  readonly declares: readonly { readonly kind: string; readonly count: number }[];
  /**
   * The names of its most significant elements — services, jobs, stages, resources, entities.
   *
   * "Most significant" is decided by **element kind**, from a fixed vocabulary order, and never by size or
   * connectedness. A compose file's services matter more than its volumes because of what a service is,
   * not because there are more or fewer of them.
   */
  readonly names: readonly string[];
  /** Prerequisites the artefact itself declares between its own elements, as `from → to`. */
  readonly ordering: readonly string[];
  /** Repository files it runs, references or documents. */
  readonly reaches: readonly { readonly type: RelationshipType; readonly path: string }[];
  /** Environment variable names it supplies or names. */
  readonly variables: readonly string[];
}

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

// ---------------------------------------------------------------------------------------------
// Artefacts
// ---------------------------------------------------------------------------------------------

/**
 * What a non-code artefact declares, as the graph holds it.
 *
 * **This exists because the Explorer was a declaration explorer wearing a repository explorer's name.**
 * Asked to show `.github/workflows/release.yml`, it showed six zeroes and the sentence "This file declares
 * nothing" — which is true of declarations and false of the file, and a reader has no way to tell those
 * apart from a count. What the file actually declares is four jobs, one of which needs another, eleven
 * steps and the two scripts they run; all of that is now in the graph, and this is the shape that carries
 * it to a reader.
 *
 * `null` on a `FileView` means artefact analysis did not classify the file — which is the case for every
 * source file, whose structure the language analysers produce at far greater fidelity. It never means the
 * file has no purpose.
 */
export interface ArtifactView {
  /** The artefact family, from `ARTIFACT_KINDS`. */
  readonly kind: string;
  /** The language the reader read it as, or `null` where none is recognised. */
  readonly format: string | null;
  /** The scanner's role, kept beside the family so a reader can see the refinement. */
  readonly role: string | null;
  /** The deterministic summary. Graph-backed, never generated — see `ArtifactSummary`. */
  readonly summary: ArtifactSummary;
  /** The artefact's structure, grouped by the section path the reader recorded. */
  readonly sections: readonly ArtifactSection[];
  /** What this artefact names that the repository holds. */
  readonly references: Listing<ArtifactLink>;
  /** What names this artefact. */
  readonly referencedBy: Listing<ArtifactLink>;
  /**
   * What this artefact names that resolved to nothing.
   *
   * **Shown, never hidden.** A workflow invoking a script that no longer exists is one of the more useful
   * things an analysis can tell a reader, and dropping it would make the absence of a `RUNS` relationship
   * indistinguishable from the absence of a command.
   */
  readonly unresolved: Listing<UnresolvedArtifactReference>;
  /**
   * What the reading did not cover, in the reader's own words.
   *
   * Carried verbatim from the file node's provenance. This is the field that makes an empty artefact
   * honest: "read as indentation structure; templating was not expanded" is a completely different claim
   * from silence.
   */
  readonly boundary: string;
}

export interface ArtifactSection {
  /** The section path inside the artefact — `jobs.build`, `services.api` — or `''` for the top level. */
  readonly title: string;
  readonly elements: readonly ArtifactElementView[];
}

export interface ArtifactElementView {
  readonly node: GraphNode;
  /** The element kind, from `ARTIFACT_ELEMENT_KINDS`. */
  readonly kind: string;
  readonly name: string;
  /** The element's own text, as the reader recorded it. */
  readonly detail: string;
  readonly line: number;
  /**
   * Sibling elements this one declares it needs, resolved.
   *
   * The only ordering the Explorer shows, and it is shown because the artefact states it. Nothing here is
   * derived from the order elements appear in the file.
   */
  readonly requires: readonly GraphNode[];
}

/** One artefact relationship, with the node at the far end and the evidence for it. */
export interface ArtifactLink {
  readonly type: RelationshipType;
  readonly node: GraphNode;
  /** The element that carried it, where an element did rather than the file itself. */
  readonly via: GraphNode | null;
  readonly confidence: string;
  readonly evidence: string;
}

export interface UnresolvedArtifactReference {
  readonly type: RelationshipType;
  readonly text: string;
  readonly reason: string;
  readonly evidence: string;
}

/**
 * A compact, deterministic account of one artefact, derived from graph facts alone.
 *
 * **Six questions, answered only where the graph answers them.** What kind of artefact is this, what role
 * has been established for it, what does it define, what references it, what does it reference, and where
 * does it sit. Every field is a projection of nodes and edges; no model is involved, and a field the graph
 * cannot fill is empty rather than filled in.
 *
 * `established` is the field that matters most. `false` means artefact analysis read the file and extracted
 * no structure — which the boundary sentence explains — and it exists so a renderer can say *that* instead
 * of showing a zero.
 */
export interface ArtifactSummary {
  /** What kind of artefact, in the family's own words. */
  readonly kind: string;
  /** What role the repository's conventions establish for it. */
  readonly role: string | null;
  /** What it defines, as `4 jobs`, `11 steps`, `2 services` — counted by element kind, largest first. */
  readonly defines: readonly { readonly kind: string; readonly count: number }[];
  /** Technologies it configures, by name. */
  readonly configures: readonly string[];
  /** Files it documents, references or runs, and how many of each. */
  readonly reaches: readonly { readonly type: RelationshipType; readonly count: number }[];
  /** How many artefacts and files name this one. */
  readonly referencedBy: number;
  /** Environment variable names it supplies or names. */
  readonly variables: readonly string[];
  /** Where it sits: the derived package, and the directory depth. */
  readonly position: string;
  /** Whether any structure was extracted at all. `false` is explained by `ArtifactView.boundary`. */
  readonly established: boolean;
}

export interface FileView {
  readonly file: GraphNode;
  /** The derived package this file belongs to. */
  readonly packageName: string;
  /**
   * What this file declares as a non-code artefact, or `null` where artefact analysis did not classify it.
   *
   * Present beside `declarations` rather than instead of it, because a file can genuinely be both — a
   * `vitest.config.ts` is a tool configuration *and* a TypeScript module with an export — and a reader
   * deserves whichever of the two they came for.
   */
  readonly artifact: ArtifactView | null;
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
