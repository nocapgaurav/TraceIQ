import type { GraphNode } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import { maxDepthFromRoots, stronglyConnectedComponents } from './graph-algorithms.js';
import type { Adjacency, GraphIndex } from './graph-index.js';
import type { NodeMetric } from './types.js';

/**
 * Everything computed from the index that more than one section needs.
 *
 * It exists so nothing is derived twice. Coupling metrics, the call-graph components and the
 * module dependency graph are each wanted by both a report section and a finding, and computing
 * them per consumer would traverse the same edges two and three times over. The analyzer builds
 * this once and hands it to every section.
 */
export interface Derived {
  readonly declarationMetrics: readonly NodeMetric[];
  readonly fileMetrics: readonly NodeMetric[];

  readonly callAdjacency: Adjacency;
  /** Identifier-ordered nodes that take part in at least one call. */
  readonly callParticipants: readonly NodeId[];
  readonly callCycles: readonly (readonly NodeId[])[];
  /** Declarations with no incoming call: where call chains begin. */
  readonly callRoots: readonly NodeId[];
  /** Deepest any declaration sits below an entry point. Wanted by two sections, computed once. */
  readonly maxCallDepth: number;

  /**
   * File-to-file dependency, projected from `IMPORTS` through each target's own file.
   *
   * `IMPORTS` targets a declaration far more often than a file, so a file-level cycle is almost
   * never a `File → File` edge. Mapping each import to the file its target lives in recovers the
   * module dependency graph engineers actually mean. This is a projection of existing edges, not
   * a new relationship: nothing is inferred that the graph does not already state.
   */
  readonly fileDependencies: Adjacency;
  readonly fileCycles: readonly (readonly NodeId[])[];
}

export function deriveFrom(index: GraphIndex): Derived {
  const callAdjacency = index.adjacencyOf('CALLS');
  const callParticipants = orderedParticipants(callAdjacency);
  const callRoots = callParticipants.filter((id) => (callAdjacency.in.get(id) ?? []).length === 0);
  const fileDependencies = projectFileDependencies(index);

  return {
    declarationMetrics: index.declarations.map((node) => metricOf(index, node)),
    fileMetrics: index.files.map((node) => metricOf(index, node)),
    callAdjacency,
    callParticipants,
    callCycles: stronglyConnectedComponents(callAdjacency, callParticipants),
    callRoots,
    maxCallDepth: maxDepthFromRoots(callAdjacency, callRoots),
    fileDependencies,
    fileCycles: stronglyConnectedComponents(fileDependencies, orderedParticipants(fileDependencies)),
  };
}

export function metricOf(index: GraphIndex, node: GraphNode): NodeMetric {
  return {
    node,
    fanIn: (index.coupling.in.get(node.id) ?? []).length,
    fanOut: (index.coupling.out.get(node.id) ?? []).length,
    incomingEdges: index.incomingEdgeCount.get(node.id) ?? 0,
    outgoingEdges: index.outgoingEdgeCount.get(node.id) ?? 0,
  };
}

function projectFileDependencies(index: GraphIndex): Adjacency {
  const out = new Map<NodeId, NodeId[]>();
  const incoming = new Map<NodeId, NodeId[]>();
  const seen = new Set<string>();

  for (const edge of index.edgesByType.get('IMPORTS') ?? []) {
    const source = index.nodeById.get(edge.sourceId);
    const target = index.nodeById.get(edge.targetId);

    if (source?.kind !== 'File' || target === undefined) {
      continue;
    }

    // A file target is itself the dependency; anything else contributes the file it lives in.
    const targetFile = target.kind === 'File' ? target.id : target.fileId;

    // An import of an external has no file, and a self-import is not a dependency.
    if (targetFile === null || targetFile === source.id) {
      continue;
    }

    const pair = `${source.id} ${targetFile}`;

    if (seen.has(pair)) {
      continue;
    }

    seen.add(pair);
    append(out, source.id, targetFile);
    append(incoming, targetFile, source.id);
  }

  return { out, in: incoming };
}

function append(map: Map<NodeId, NodeId[]>, key: NodeId, value: NodeId): void {
  const existing = map.get(key);

  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

/** Identifier-ordered, so every algorithm over this adjacency iterates the same way. */
export function orderedParticipants(adjacency: Adjacency): readonly NodeId[] {
  return [...new Set([...adjacency.out.keys(), ...adjacency.in.keys()])].sort();
}
