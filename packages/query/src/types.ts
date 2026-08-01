import type { GraphEdge, GraphNode, GraphRole, GraphUnresolvedReference } from '@traceiq/graph-api';
import type { Role } from '@traceiq/types';

/**
 * Query results.
 *
 * Every result **carries the graph node or edge it came from** rather than flattening a
 * few fields out of it. That is deliberate: confidence, provenance and source locations
 * live on those objects, and copying selected fields is how explainability gets lost.
 * A caller can always answer "why does this result exist" without asking again.
 */

export interface DeclarationResult {
  readonly node: GraphNode;
  /** Architectural roles attributed to it, each with its own confidence and evidence. */
  readonly roles: readonly GraphRole[];
}

/**
 * The declaration containing another, with the `DECLARES` edge that establishes it.
 *
 * The edge is carried rather than only the container, so a caller can see *why* the
 * containment holds. Containment is a separate question from reference, which is why
 * `findReferences` excludes `DECLARES` and this exists instead.
 */
export interface EnclosingResult {
  readonly edge: GraphEdge;
  /** `null` only if the graph is inconsistent, which validation should prevent. */
  readonly declaration: GraphNode | null;
}

/** An edge arriving at a node, with the node it came from. */
export interface ReferenceResult {
  readonly edge: GraphEdge;
  /** `null` only if the graph is inconsistent, which validation should prevent. */
  readonly source: GraphNode | null;
}

/**
 * An edge leaving a node, with the node it points at.
 *
 * The mirror of `ReferenceResult`: a reference looks backwards, a callee looks forwards.
 */
export interface CalleeResult {
  readonly edge: GraphEdge;
  readonly target: GraphNode | null;
}

/** One handler in a route's chain. `edge.ordinal` is its position. */
export interface RouteHandlerResult {
  readonly edge: GraphEdge;
  readonly declaration: GraphNode | null;
}

/**
 * What happened when a route's path was composed.
 *
 * Composition is performed per query and never materialised, so this is computed on
 * every read. It reports honestly when nothing could be composed: a caller must be able
 * to tell "this path is complete" from "this path is local and may be mounted under a
 * prefix we cannot see".
 */
export interface PathComposition {
  readonly composed: boolean;
  /** Mount prefixes applied, outermost first. Empty when none were found. */
  readonly prefixes: readonly string[];
  /** The path a request would actually match, as far as the graph can tell. */
  readonly effectivePath: string;
  readonly note: string;
}

export interface RouteResult {
  readonly node: GraphNode;
  readonly method: string;
  /** The path exactly as written at the registration. */
  readonly path: string;
  readonly composition: PathComposition;
  /** Every handler, ordered by ordinal, so middleware order survives. */
  readonly handlers: readonly RouteHandlerResult[];
}

export interface RouteExplanation {
  readonly route: RouteResult;
  /** Handlers running ahead of the final one. */
  readonly middleware: readonly RouteHandlerResult[];
  /** The final handler, or `null` when the route has none linked. */
  readonly handler: RouteHandlerResult | null;
  /** Handlers the pipeline could not link, kept visible rather than omitted. */
  readonly unresolvedHandlers: readonly GraphUnresolvedReference[];
}

export interface EnvironmentVariableResult {
  readonly node: GraphNode;
  /** Every read of it, each carrying the declaration that performs the read. */
  readonly reads: readonly ReferenceResult[];
}

export interface DependencyResult {
  /** The `External` node: a package in any ecosystem, a standard-library module, or a language builtin. */
  readonly node: GraphNode;
  readonly importedBy: readonly ReferenceResult[];
}

export interface UnresolvedResult {
  readonly reference: GraphUnresolvedReference;
  readonly source: GraphNode | null;
}

export interface RoleQueryResult extends DeclarationResult {
  /** The role that matched, for callers that asked for several. */
  readonly matched: Role;
}

/**
 * One technology the repository is built from, read back from its `Technology` node.
 *
 * Structurally the same as the Explorer's and the Context's, and deliberately so: three consumers
 * reading one set of nodes should see one shape. The duplication is in the type declaration rather
 * than in the derivation, which is the half that could drift.
 */
export interface TechnologyResult {
  readonly id: string;
  readonly name: string;
  /** `frontend`, `backend`, `infrastructure`, `build`, `testing`, `data`. */
  readonly category: string;
  /** The region it was found in; `''` is the repository root. */
  readonly regionPath: string;
  readonly confidence: string;
  /** Why the claim is made, naming the files that prove it. */
  readonly evidence: string;
}
