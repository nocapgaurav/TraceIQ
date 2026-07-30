import type { NodeId } from '@traceiq/types';

import type { Adjacency } from './graph-index.js';

/**
 * Graph algorithms over an adjacency snapshot.
 *
 * All three are **iterative**, not recursive: a deep call chain or a long import chain would
 * otherwise overflow the stack on a large repository, and a health analyser is exactly the thing
 * that meets the worst case.
 *
 * All three take an identifier-ordered node list and iterate it in that order, so the output is
 * deterministic down to the order of members inside a component.
 */

/**
 * Strongly connected components with more than one member, plus self-loops.
 *
 * Tarjan's algorithm, iterative. A component of size one is only a cycle when the node points at
 * itself, which is why self-loops are handled explicitly rather than by size alone — recursion is
 * a real cycle and dropping it would under-report.
 *
 * **Members within a component are identifier-ordered; components themselves come out in Tarjan's
 * reverse topological order** — a component is emitted once everything it reaches has been. Both
 * orders are deterministic, and the second carries information, so neither is re-sorted.
 *
 * O(V + E).
 */
export function stronglyConnectedComponents(
  adjacency: Adjacency,
  ordered: readonly NodeId[],
): readonly (readonly NodeId[])[] {
  const index = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const components: NodeId[][] = [];

  let counter = 0;

  for (const root of ordered) {
    if (index.has(root)) {
      continue;
    }

    // Each frame keeps its own cursor into the neighbour list, which is what replaces recursion.
    const frames: { readonly node: NodeId; cursor: number }[] = [{ node: root, cursor: 0 }];

    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames.at(-1);

      if (frame === undefined) {
        break;
      }

      const neighbours = adjacency.out.get(frame.node) ?? [];

      if (frame.cursor < neighbours.length) {
        const next = neighbours[frame.cursor];

        frame.cursor += 1;

        if (next === undefined) {
          continue;
        }

        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, cursor: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(next) ?? 0));
        }

        continue;
      }

      frames.pop();

      const parent = frames.at(-1);

      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: NodeId[] = [];

        for (;;) {
          const member = stack.pop();

          if (member === undefined) {
            break;
          }

          onStack.delete(member);
          component.push(member);

          if (member === frame.node) {
            break;
          }
        }

        const isSelfLoop =
          component.length === 1 &&
          component[0] !== undefined &&
          (adjacency.out.get(component[0]) ?? []).includes(component[0]);

        if (component.length > 1 || isSelfLoop) {
          components.push(component.sort());
        }
      }
    }
  }

  return components;
}

export interface ClusterSummary {
  readonly count: number;
  readonly largest: number;
  readonly singletons: number;
}

/**
 * Connected components, ignoring edge direction.
 *
 * "Disconnected call clusters" is an undirected question: two functions that call a common helper
 * belong together even though neither calls the other. Only nodes with at least one edge are
 * considered, so the thousands of declarations that participate in no call at all do not each
 * count as a cluster.
 *
 * O(V + E).
 */
export function connectedComponents(
  adjacency: Adjacency,
  ordered: readonly NodeId[],
): ClusterSummary {
  const seen = new Set<NodeId>();
  const sizes: number[] = [];

  for (const root of ordered) {
    if (seen.has(root)) {
      continue;
    }

    const queue: NodeId[] = [root];

    seen.add(root);

    let size = 0;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];

      if (current === undefined) {
        continue;
      }

      size += 1;

      for (const neighbour of [
        ...(adjacency.out.get(current) ?? []),
        ...(adjacency.in.get(current) ?? []),
      ]) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }

    sizes.push(size);
  }

  return {
    count: sizes.length,
    largest: sizes.length === 0 ? 0 : Math.max(...sizes),
    singletons: sizes.filter((size) => size === 1).length,
  };
}

/**
 * The greatest distance any node sits below an entry point.
 *
 * Multi-source breadth-first from every root at once, so each node gets its **shortest** distance
 * from the nearest root and the answer is one O(V + E) pass rather than one per root.
 *
 * Shortest-from-a-root, maximised, is chosen because the longest path in a graph with cycles is
 * not computable in polynomial time — and a metric that cannot be computed exactly should not be
 * reported as if it were. What this measures is well defined: how deep the call graph gets.
 */
export function maxDepthFromRoots(
  adjacency: Adjacency,
  roots: readonly NodeId[],
): number {
  const depth = new Map<NodeId, number>();
  const queue: NodeId[] = [];

  for (const root of roots) {
    depth.set(root, 0);
    queue.push(root);
  }

  let deepest = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];

    if (current === undefined) {
      continue;
    }

    const currentDepth = depth.get(current) ?? 0;

    for (const neighbour of adjacency.out.get(current) ?? []) {
      if (depth.has(neighbour)) {
        continue;
      }

      depth.set(neighbour, currentDepth + 1);
      deepest = Math.max(deepest, currentDepth + 1);
      queue.push(neighbour);
    }
  }

  return deepest;
}
