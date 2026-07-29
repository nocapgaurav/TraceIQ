import type { NodeId, RelationshipType } from '@traceiq/types';

import type {
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
} from './types.js';

/**
 * The only way to read the repository graph.
 *
 * A thin abstraction over storage: six operations, each a direct lookup. It exists so
 * that a reader never depends on SQLite — no SQL, no connection, no driver type appears
 * in this interface or in the model it returns.
 *
 * **It does not traverse.** `getOutgoing` returns one step from one node; following
 * those edges further, deciding how deep to go, and deciding what to keep is the Query
 * Engine's work. Nothing here ranks, filters by relevance, or infers.
 *
 * The one filter it accepts is a relationship type on the edge accessors, because a
 * traversal that wants a single edge type should not have to read and discard the rest.
 * That is the only filtering: no predicates, no ranges, no ordering options.
 *
 * **Every operation is deterministic.** Lists are returned in a defined order — nodes by
 * identifier, edges by identifier — so the same graph always answers the same way and a
 * caller never has to sort defensively.
 */
export interface RepositoryGraphApi {
  /** The node, or `null` when no node has that identifier. */
  getNode(id: NodeId): GraphNode | null;

  /** Whether a node with that identifier exists. */
  exists(id: NodeId): boolean;

  /**
   * Edges whose source is this node, ordered by edge identifier.
   *
   * Restricted to one relationship type when `type` is given.
   */
  getOutgoing(id: NodeId, type?: RelationshipType): readonly GraphEdge[];

  /**
   * Edges whose target is this node, ordered by edge identifier.
   *
   * Restricted to one relationship type when `type` is given.
   */
  getIncoming(id: NodeId, type?: RelationshipType): readonly GraphEdge[];

  /** Every edge of one relationship type, ordered by edge identifier. */
  getEdges(type: RelationshipType): readonly GraphEdge[];

  /** Every node of one kind, ordered by node identifier. */
  getNodes(kind: NodeKind): readonly GraphNode[];

  /**
   * Architectural roles annotating this node, ordered by role name.
   *
   * A role is a confidence-bearing judgement, so each carries its own confidence and
   * the evidence behind it.
   */
  getRoles(nodeId: NodeId): readonly GraphRole[];

  /**
   * Every reference that could not be resolved, ordered by identifier.
   *
   * Exposed so that the absence of an edge stays distinguishable from the absence of a
   * reference: a consumer can show a dead end rather than silently nothing.
   */
  getUnresolved(): readonly GraphUnresolvedReference[];
}
