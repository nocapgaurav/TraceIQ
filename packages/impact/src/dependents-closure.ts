import type { GraphEdge, GraphNode, NodeKind } from '@traceiq/graph-api';
import type { ReferenceResult } from '@traceiq/query';
import type { NodeId } from '@traceiq/types';

import type { AffectedNode, ImpactQueries } from './types.js';

/**
 * Node kinds whose own dependents are worth following.
 *
 * Declarations, and `File` — because a module-level call is attributed to its file, so a file
 * genuinely depends on what those calls reach, and stopping there would lose the impact of
 * every top-level invocation.
 *
 * A `Route` is deliberately absent: nothing references a route, so expanding one would always
 * find nothing, and a route belongs in `routesAffected` rather than among affected
 * declarations. `External` and `EnvironmentVariable` can never be an edge source under the
 * graph's endpoint matrix, so they cannot arrive here at all.
 */
const EXPANDABLE_KINDS: readonly NodeKind[] = [
  'File',
  'Class',
  'Interface',
  'TypeAlias',
  'Enum',
  'EnumMember',
  'Function',
  'Method',
  'Property',
  'Accessor',
  'Constructor',
  'Variable',
  'Namespace',
];

/** A `HANDLED_BY` edge found during traversal, with the closure node it reaches. */
export interface RouteReach {
  readonly routeId: NodeId;
  readonly reaches: NodeId;
  readonly via: GraphEdge;
}

export interface DependentsClosure {
  /**
   * Everything affected, in **breadth-first discovery order** — so depth-major, and within a
   * depth in the order the Query Engine returned the edges. No sorting is applied.
   */
  readonly affected: readonly AffectedNode[];
  /** Every node in the closure, including the target. Used to scope the other queries. */
  readonly members: ReadonlySet<NodeId>;
  /** The target's own incoming edges, so the direct edge-level fields cost no extra query. */
  readonly directReferences: readonly ReferenceResult[];
  readonly routeReaches: readonly RouteReach[];
  readonly referenceQueries: number;
  readonly maxDepth: number;
}

/**
 * Walks outwards from the target along **incoming** edges: who depends on this.
 *
 * That direction is what impact means. A caller breaks when the target changes; a callee does
 * not, which is why callees are reported at depth 1 and never expanded — expanding them would
 * fill the result with declarations a change to the target cannot reach.
 *
 * **Breadth-first, so every node is recorded at its shortest distance from the target.** The
 * queue is FIFO and nothing is sorted, so ordering follows the Query Engine's edge order and
 * is deterministic.
 *
 * **Cycles terminate.** A node is added to `visited` the moment it is discovered, and the
 * target is in `visited` before the walk starts — so mutual recursion, a reference cycle
 * between modules, and a self-call all halt. Each node is dequeued at most once, giving one
 * `findReferences` call per node in the closure.
 *
 * **Duplicates are eliminated per node, not per edge.** Two call sites from the same caller
 * are two edges but one affected node, recorded with the first edge that reached it. The
 * edge-level fields keep every edge, because "where are the call sites" needs them all.
 */
export function dependentsClosure(
  queries: Pick<ImpactQueries, 'findReferences'>,
  targetId: NodeId,
): DependentsClosure {
  const visited = new Set<NodeId>([targetId]);
  const affected: AffectedNode[] = [];
  const routeReaches: RouteReach[] = [];
  const queue: { readonly id: NodeId; readonly depth: number }[] = [{ id: targetId, depth: 0 }];

  let directReferences: readonly ReferenceResult[] = [];
  let referenceQueries = 0;
  let maxDepth = 0;

  // A cursor rather than shift(), so the queue stays O(1) per step.
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];

    if (current === undefined) {
      continue;
    }

    const references = queries.findReferences(current.id);

    referenceQueries += 1;

    if (current.depth === 0) {
      directReferences = references;
    }

    for (const reference of references) {
      const dependent = reference.source;

      // Null only if the graph is inconsistent, which validation should prevent. Skipped
      // rather than guessed at: there is no node to report.
      if (dependent === null) {
        continue;
      }

      if (dependent.kind === 'Route') {
        routeReaches.push({
          routeId: dependent.id,
          reaches: current.id,
          via: reference.edge,
        });

        continue;
      }

      if (visited.has(dependent.id)) {
        continue;
      }

      visited.add(dependent.id);

      const depth = current.depth + 1;

      affected.push({
        node: dependent,
        category: depth === 1 ? 'DIRECT' : 'INDIRECT',
        depth,
        via: reference.edge,
      });

      maxDepth = Math.max(maxDepth, depth);

      if (isExpandable(dependent)) {
        queue.push({ id: dependent.id, depth });
      }
    }
  }

  return { affected, members: visited, directReferences, routeReaches, referenceQueries, maxDepth };
}

function isExpandable(node: GraphNode): boolean {
  return EXPANDABLE_KINDS.includes(node.kind);
}
