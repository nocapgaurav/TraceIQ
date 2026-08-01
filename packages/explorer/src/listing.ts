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
 * External identity kinds that are not an ecosystem dependency.
 *
 * A language's own builtins, a language's own standard library, and the sentinel for a reference whose
 * target could not be named. Everything else is something a manifest could declare — npm, pip, Maven,
 * Gradle, Go modules, Cargo, NuGet, Composer, Bundler, and any ecosystem added later.
 */
const NON_DEPENDENCY_EXTERNAL_KINDS: ReadonlySet<string> = new Set([
  'builtin',
  'node',
  'stdlib',
  'outside-analysis',
]);

/**
 * External nodes with the repository's real dependencies first.
 *
 * **The cap made identifier ordering actively misleading here, which is why this is the one node list
 * with an ordering of its own.** Measured on `facebook/react`: 740 external nodes, of which 395 are
 * `ext:builtin:*` and 11 are `ext:node:*`. Alphabetically, `ext:builtin:` precedes `ext:npm:` — so the
 * 100 entries that survived `RESULT_LIMIT` were `AbortController`, `AbortSignal`, `AnalyserNode`,
 * `Animation`, … and **not one** of React's 333 npm packages appeared in the architecture view, in the
 * context assembled from it, or in any answer built on that context.
 *
 * A cap that keeps a hundred true things and drops the only useful ones is not a cap, it is a filter
 * nobody chose. Ordering by whether a node is a dependency puts the answer inside the cap; nothing is
 * excluded, `total` is unchanged, and ties still break on the identifier so two scans agree.
 */
export function byDependencyFirst(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const rank = (node: GraphNode): number =>
    node.externalKind !== null && NON_DEPENDENCY_EXTERNAL_KINDS.has(node.externalKind) ? 1 : 0;

  return [...nodes].sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id));
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
