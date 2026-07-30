import type { GraphNode } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import type { Adjacency } from '@traceiq/health';

import { RESULT_LIMIT, type Listing, type ReachedNode } from './types.js';

/**
 * Caps a list while keeping its true size visible.
 *
 * Used for every list the explorer returns. A cap is never silent: `total` is exact and `truncated`
 * says whether `entries` is the whole set.
 */
export function listing<T>(entries: readonly T[], limit = RESULT_LIMIT): Listing<T> {
  return {
    entries: entries.slice(0, limit),
    total: entries.length,
    truncated: entries.length > limit,
  };
}

/** Identifier-ordered, which is the only ordering the explorer applies to node lists. */
export function byId(nodes: readonly GraphNode[]): readonly GraphNode[] {
  return [...nodes].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Everything reachable from a node, with each one's shortest distance.
 *
 * Breadth-first with a visited set, so a cycle terminates and every node is recorded at its shortest
 * distance. Written here because no existing capability answers it: Impact Analysis walks the
 * *dependents* direction and deliberately does not follow the other, and Repository Health's
 * `maxDepthFromRoots` returns a maximum rather than the members.
 *
 * O(V + E) over the adjacency given.
 */
export function reachableFrom(adjacency: Adjacency, start: NodeId): ReadonlyMap<NodeId, number> {
  const depths = new Map<NodeId, number>();
  const queue: NodeId[] = [start];

  depths.set(start, 0);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];

    if (current === undefined) {
      continue;
    }

    const depth = depths.get(current) ?? 0;

    for (const neighbour of adjacency.out.get(current) ?? []) {
      if (depths.has(neighbour)) {
        continue;
      }

      depths.set(neighbour, depth + 1);
      queue.push(neighbour);
    }
  }

  // The subject itself is not something it reaches.
  depths.delete(start);

  return depths;
}

/**
 * Reached nodes ordered by depth, then by identifier.
 *
 * Depth-major because that is the useful reading — what is one step away, then two — and the
 * identifier tiebreak means ties never depend on traversal order.
 */
export function reachedNodes(
  depths: ReadonlyMap<NodeId, number>,
  resolve: (id: NodeId) => GraphNode | null,
): readonly ReachedNode[] {
  const entries: ReachedNode[] = [];

  for (const [id, depth] of depths) {
    const node = resolve(id);

    if (node !== null) {
      entries.push({ node, depth });
    }
  }

  return entries.sort(
    (left, right) => left.depth - right.depth || left.node.id.localeCompare(right.node.id),
  );
}
