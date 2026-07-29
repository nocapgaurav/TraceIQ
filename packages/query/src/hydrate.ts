import type { GraphEdge, RepositoryGraphApi } from '@traceiq/graph-api';

import type { ReferenceResult, RouteHandlerResult } from './types.js';

/**
 * Turning an edge into a result needs the node at its other end, which every query does.
 * Both helpers live here so that lookup exists once rather than in each query.
 *
 * Each costs one `getNode` per edge. The Graph API offers no batch accessor, so this is
 * the one place that would benefit if it ever did.
 */
export function toReference(api: RepositoryGraphApi, edge: GraphEdge): ReferenceResult {
  return { edge, source: api.getNode(edge.sourceId) };
}

export function toHandler(api: RepositoryGraphApi, edge: GraphEdge): RouteHandlerResult {
  return { edge, declaration: api.getNode(edge.targetId) };
}

/** Ordered by ordinal, so middleware order is the order it runs in. */
export function byOrdinal(left: RouteHandlerResult, right: RouteHandlerResult): number {
  return (left.edge.ordinal ?? 0) - (right.edge.ordinal ?? 0);
}
