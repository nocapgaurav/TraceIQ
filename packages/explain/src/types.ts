import type { GraphNode, GraphProvenance, NodeKind } from '@traceiq/graph-api';
import type {
  CalleeResult,
  DeclarationResult,
  DependencyResult,
  EnclosingResult,
  EnvironmentVariableResult,
  ReferenceResult,
  RouteExplanation,
  RouteResult,
  UnresolvedResult,
} from '@traceiq/query';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

/**
 * The Query Engine operations Explain Symbol consumes, and nothing more.
 *
 * Declared as an interface rather than taking a `QueryEngine` so that the consumed surface
 * is written down: a reader sees exactly which nine questions are asked, and a test can
 * count them. `QueryEngine` satisfies it structurally, and that is what production passes.
 *
 * **No storage concept appears here.** There is no connection, no statement, no path and no
 * driver — which is what makes it impossible for this package to reach a database.
 */
export interface ExplainSymbolQueries {
  findDeclaration(id: NodeId): DeclarationResult | null;
  findEnclosingDeclaration(id: NodeId): EnclosingResult | null;
  findReferences(id: NodeId): readonly ReferenceResult[];
  findCallees(id: NodeId): readonly CalleeResult[];
  findRoutes(): readonly RouteResult[];
  explainRoute(routeId: NodeId): RouteExplanation | null;
  findEnvironmentVariables(): readonly EnvironmentVariableResult[];
  findDependencies(): readonly DependencyResult[];
  findUnresolved(): readonly UnresolvedResult[];
}

/**
 * The file a declaration was written in.
 *
 * The identifier and the path it contains, not the `File` node: no Query Engine operation
 * returns one, since a file is not a declaration. The path is read from the identifier
 * rather than stored twice.
 */
export interface SourceFileReference {
  readonly id: NodeId;
  /** Repository-relative, read from the `file:<path>` identifier. */
  readonly path: string;
}

export const ROUTE_POSITIONS = ['middleware', 'handler'] as const;

export type RoutePosition = (typeof ROUTE_POSITIONS)[number];

/**
 * A route whose chain reaches this declaration.
 *
 * One entry per occurrence, not per route: a declaration used twice in one chain appears
 * twice, because both occurrences are real and collapsing them would lose a position.
 */
export interface ReachingRoute {
  readonly explanation: RouteExplanation;
  readonly position: RoutePosition;
  /** Position in the chain, from the `HANDLED_BY` edge. */
  readonly ordinal: number | null;
}

/** An environment variable this declaration reads, with only its own reads. */
export interface EnvironmentVariableUse {
  readonly node: GraphNode;
  readonly reads: readonly ReferenceResult[];
}

/**
 * An external this declaration's **file** imports.
 *
 * `IMPORTS` is sourced at a file, never at a declaration, so this is file-scoped and says
 * so. Narrowing it to the declaration would require import-usage analysis that no stage
 * performs, and claiming declaration scope would overstate what the graph knows.
 */
export interface ExternalDependencyUse {
  readonly node: GraphNode;
  readonly importedByFile: readonly ReferenceResult[];
}

export const UNRESOLVED_SCOPES = ['declaration', 'file'] as const;

export type UnresolvedScope = (typeof UNRESOLVED_SCOPES)[number];

/**
 * An unresolved reference bearing on this result, and how closely.
 *
 * `declaration` means it was recorded at this declaration — an unbound call it makes.
 * `file` means it was recorded at the file containing it, which is where unresolved imports
 * sit. A file-scoped entry may or may not affect this declaration, and the scope is
 * reported so a consumer can decide rather than being told.
 */
export interface ScopedUnresolved {
  readonly result: UnresolvedResult;
  readonly scope: UnresolvedScope;
}

/**
 * Every limitation Explain Symbol can report.
 *
 * A closed vocabulary with fixed text. Nothing is composed, templated or generated: a
 * limitation is *selected* when a fact makes it apply, and its wording is the same on every
 * run. Counts live in `affected` rather than being interpolated into prose.
 *
 * They are emitted in the order listed here, which is what keeps the field deterministic.
 */
export const LIMITATION_CODES = [
  'call-coverage-partial',
  'calls-are-inferred',
  'no-transitive-reach',
  'unbound-calls-at-this-declaration',
  'ambiguous-relationships',
  'external-dependencies-are-file-scoped',
  'route-prefixes-not-composed',
  'roles-are-judgements',
  'source-file-node-not-reachable',
] as const;

export type LimitationCode = (typeof LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: LimitationCode;
  /** Fixed text for this code. Never composed. */
  readonly detail: string;
  /** How many parts of this result the limitation bears on, or `null` when it is general. */
  readonly affected: number | null;
}

/**
 * Everything the repository records about one declaration.
 *
 * Assembled from Query Engine answers and nothing else. No summary, no ranking, no
 * generated language, no inference of its own: every field is a fact carried out of the
 * graph, with the node or edge it came from still attached.
 */
export interface ExplainSymbolResult {
  readonly declaration: DeclarationResult;
  readonly kind: NodeKind;
  /** `null` only for a declaration the graph records with no file, which should not occur. */
  readonly sourceFile: SourceFileReference | null;
  /** Plural: a merged interface or an overload set has one per signature. */
  readonly locations: GraphNode['locations'];
  readonly enclosingDeclaration: EnclosingResult | null;
  readonly incomingCalls: readonly ReferenceResult[];
  readonly outgoingCalls: readonly CalleeResult[];
  /** Every incoming edge except `DECLARES`, so `incomingCalls` is a subset of this. */
  readonly references: readonly ReferenceResult[];
  readonly typeReferences: readonly ReferenceResult[];
  readonly routes: readonly ReachingRoute[];
  readonly environmentVariables: readonly EnvironmentVariableUse[];
  readonly externalDependencies: readonly ExternalDependencyUse[];
  readonly confidence: ConfidenceLevel;
  readonly provenance: GraphProvenance;
  readonly unresolved: readonly ScopedUnresolved[];
  readonly limitations: readonly Limitation[];
}
