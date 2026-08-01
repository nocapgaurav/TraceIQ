import type { RepositoryCapabilities } from '@traceiq/graph-api';
import type { GraphEdge, GraphNode, GraphProvenance } from '@traceiq/graph-api';
import type {
  CalleeResult,
  DeclarationResult,
  DependencyResult,
  EnvironmentVariableResult,
  ReferenceResult,
  RouteResult,
  UnresolvedResult,
} from '@traceiq/query';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

/**
 * The Query Engine operations impact analysis consumes, and nothing more.
 *
 * Declared as an interface rather than taking a `QueryEngine` so the consumed surface is
 * written down: seven questions, of which four are asked exactly once per analysis however
 * large the closure grows. `QueryEngine` satisfies it structurally and is what production
 * passes.
 *
 * **No storage concept appears here** — no connection, statement, path or driver — which is
 * what makes it impossible for this package to reach a database.
 */
export interface ImpactQueries {
  findDeclaration(id: NodeId): DeclarationResult | null;
  /** The one traversal primitive: every incoming edge except `DECLARES`. */
  findReferences(id: NodeId): readonly ReferenceResult[];
  findCallees(id: NodeId): readonly CalleeResult[];
  findRoutes(): readonly RouteResult[];
  findEnvironmentVariables(): readonly EnvironmentVariableResult[];
  findDependencies(): readonly DependencyResult[];
  findUnresolved(): readonly UnresolvedResult[];
  /**
   * What the graph can answer, by region.
   *
   * Needed so an empty result can be distinguished from an unanalysed one. Without it,
   * impact analysis of a Go declaration would report "nothing depends on this" with the
   * same confidence as it does for a fully analysed TypeScript one.
   */
  capabilities(): RepositoryCapabilities;
}

/**
 * How certainly something belongs in the result.
 *
 * The three are **never merged**. `DIRECT` and `INDIRECT` are both established by edges that
 * exist in the graph and differ only in distance. `UNKNOWN` is the opposite kind of fact: a
 * relationship the pipeline could not resolve, so the impact may be wider than the closure
 * shows.
 */
export const IMPACT_CATEGORIES = ['DIRECT', 'INDIRECT', 'UNKNOWN'] as const;

export type ImpactCategory = (typeof IMPACT_CATEGORIES)[number];

/**
 * Something a change to the target could affect.
 *
 * `node` may be a `File` as well as a declaration: a module-level call is attributed to its
 * file, so a file really can depend on the target, and dropping it would silently lose every
 * top-level invocation's impact. `node.kind` distinguishes them.
 *
 * `via` is the edge that **first** reached it, and `via.targetId` is the already-affected
 * node it was reached through — so following `via.targetId` walks a path back to the target
 * without any path being stored.
 */
export interface AffectedNode {
  readonly node: GraphNode;
  readonly category: 'DIRECT' | 'INDIRECT';
  /** Edges from the target. 1 is direct. */
  readonly depth: number;
  readonly via: GraphEdge;
}

/**
 * A route whose handler chain reaches something in the closure.
 *
 * `reaches` is that node. A route is always `INDIRECT`, including one whose chain names the
 * target itself: a route is not a declaration, and the category vocabulary places every
 * route reaching the declaration in `INDIRECT`.
 */
export interface RouteImpact {
  readonly route: RouteResult;
  readonly reaches: NodeId;
  readonly via: GraphEdge;
}

/** An environment variable read by something in the closure. */
export interface EnvironmentVariableImpact {
  readonly node: GraphNode;
  /** Only the reads performed from inside the closure. */
  readonly reads: readonly ReferenceResult[];
}

/**
 * An external imported by a file holding something in the closure.
 *
 * File-scoped because `IMPORTS` is recorded at a file, never at a declaration. Narrowing it
 * would need import-usage analysis that no stage performs.
 */
export interface ExternalDependencyImpact {
  readonly node: GraphNode;
  readonly importedBy: readonly ReferenceResult[];
}

export const UNKNOWN_SCOPES = ['declaration', 'file'] as const;

export type UnknownScope = (typeof UNKNOWN_SCOPES)[number];

/**
 * A relationship the pipeline could not resolve, recorded at a node in the closure.
 *
 * This is the `UNKNOWN` category: it does not say something *is* affected, it says the graph
 * could not settle a relationship at that point.
 *
 * `scope` matters more here than it looks. A file enters the closure by importing the target,
 * and it then contributes **every** unbound call in its top-level code — which on a
 * test-heavy repository is thousands of `expect(...)` calls that have no bearing on the
 * target. Those are labelled `file`; a relationship recorded at an affected declaration is
 * labelled `declaration`. Nothing is dropped and no judgement is applied, so a consumer can
 * filter on a fact rather than trusting a heuristic.
 */
export interface UnknownImpact {
  readonly result: UnresolvedResult;
  /** The closure node it was recorded at — the target, or something affected. */
  readonly at: NodeId;
  readonly scope: UnknownScope;
}

/**
 * What the traversal cost and how far it went.
 *
 * Reported rather than logged, so a caller can see the shape of the closure it received.
 * These are counts, not scores: nothing is ranked by them.
 */
export interface ImpactStatistics {
  readonly nodesVisited: number;
  readonly maxDepth: number;
  /** `findReferences` calls, which is one per visited node. */
  readonly referenceQueries: number;
  /** Queries issued once regardless of closure size. */
  readonly wholeCollectionQueries: number;
}

export const LIMITATION_CODES = [
  'call-coverage-partial',
  'calls-are-inferred',
  'no-interface-or-dynamic-dispatch',
  'unresolved-relationships-in-closure',
  'closure-may-miss-hidden-dependents',
  'file-level-unresolved-dominates',
  'ambiguous-relationships',
  'file-level-attribution',
  'containment-not-followed',
  'external-dependencies-are-file-scoped',
  'route-prefixes-not-composed',
  /**
   * The target sits in a region no semantic analyser covered.
   *
   * The most important limitation in this table, because without it the result is
   * indistinguishable from "nothing depends on this". A Python or Go declaration has no
   * calls and no imports in the graph — not because none exist in the code, but because
   * nothing read it.
   */
  'region-has-no-semantic-analysis',
] as const;

export type LimitationCode = (typeof LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: LimitationCode;
  /** Fixed text for this code. Never composed. */
  readonly detail: string;
  /** How many parts of this result it bears on, or `null` when it is general. */
  readonly affected: number | null;
}

/**
 * Everything inside the repository a change to one declaration could affect.
 *
 * Assembled by traversing edges that already exist in the graph. Nothing is predicted,
 * simulated, ranked, scored or generated: every reported relationship carries the
 * `GraphEdge` it came from.
 */
export interface ImpactAnalysisResult {
  readonly target: DeclarationResult;

  /** Reached in one edge. */
  readonly directlyAffected: readonly AffectedNode[];
  /** Reached in two or more. */
  readonly indirectlyAffected: readonly AffectedNode[];

  /** Direct relationships at the target, as edges rather than nodes. */
  readonly callers: readonly ReferenceResult[];
  readonly callees: readonly CalleeResult[];
  readonly typeReferences: readonly ReferenceResult[];
  readonly imports: readonly ReferenceResult[];

  readonly routesAffected: readonly RouteImpact[];
  readonly environmentVariables: readonly EnvironmentVariableImpact[];
  readonly externalDependencies: readonly ExternalDependencyImpact[];

  /** The `UNKNOWN` category. */
  readonly unknown: readonly UnknownImpact[];

  /** The target's own. No confidence is aggregated across a path. */
  readonly confidence: ConfidenceLevel;
  readonly provenance: GraphProvenance;

  readonly limitations: readonly Limitation[];
  readonly statistics: ImpactStatistics;
}
