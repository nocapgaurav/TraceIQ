import {
  DECLARATION_NODE_KINDS,
  NODE_KINDS,
  type GraphEdge,
  type GraphNode,
  type GraphRole,
  type GraphUnresolvedReference,
  type NodeKind,
} from '@traceiq/graph-api';
import { CONFIDENCE_LEVELS, RELATIONSHIP_TYPES, ROLES } from '@traceiq/types';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

import type { HealthGraph } from './types.js';

/**
 * Relationship types that express a **reference** from one node to another.
 *
 * `DECLARES` is excluded, for the same reason the Query Engine's `findReferences` excludes it: a
 * class declaring a method is containment, not a reference to it. Counting it would give every
 * member an incoming edge from its own container — so nothing would ever read as unreferenced —
 * and would inflate every file's fan-out by the number of declarations it holds.
 *
 * It is still counted in `edgeCount` and in the relationship totals, because it is a real edge.
 */
/**
 * `CONTAINS` is excluded for exactly the reason `DECLARES` is: it is containment, not a reference.
 *
 * A workflow file holding twelve steps would otherwise have a fan-out of twelve and every step a fan-in
 * of one, so a repository whose YAML is thorough would read as its most coupled region — which is the
 * hotspot-as-importance failure arriving through a new door. Artefact containment is counted in
 * `edgeCount` and in the relationship totals, because it is a real edge.
 */
export const REFERENCE_TYPES: readonly RelationshipType[] = RELATIONSHIP_TYPES.filter(
  (type) => type !== 'DECLARES' && type !== 'CONTAINS',
);

/** Neighbours of one node, in the order the edges arrived — which is identifier order. */
export interface Adjacency {
  readonly out: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly in: ReadonlyMap<NodeId, readonly NodeId[]>;
}

/**
 * Everything the report needs, read in **one pass** over the graph.
 *
 * The whole analysis is a function of this index: `getNodes` is called once per node kind,
 * `getEdges` once per relationship type, `getRoles` once per role-bearing node, and
 * `getUnresolved` once. Nothing afterwards touches the graph, so no section can accidentally
 * re-traverse and every section sees the same snapshot.
 *
 * Adjacency is built per relationship type rather than merged, because a dependency cycle and a
 * call cycle are different questions and merging them would make either unanswerable.
 */
export interface GraphIndex {
  readonly nodesByKind: ReadonlyMap<NodeKind, readonly GraphNode[]>;
  readonly nodeById: ReadonlyMap<NodeId, GraphNode>;
  readonly declarations: readonly GraphNode[];
  readonly files: readonly GraphNode[];

  readonly edgesByType: ReadonlyMap<RelationshipType, readonly GraphEdge[]>;
  readonly edgeCount: number;

  /** Distinct neighbours across every **reference** type — containment excluded. */
  readonly coupling: Adjacency;
  /** Reference-edge counts, which exceed the distinct counts wherever a pair is related twice. */
  readonly incomingEdgeCount: ReadonlyMap<NodeId, number>;
  readonly outgoingEdgeCount: ReadonlyMap<NodeId, number>;

  /** Adjacency restricted to one relationship type, for cycle and cluster questions. */
  adjacencyOf(type: RelationshipType): Adjacency;

  readonly rolesByNode: ReadonlyMap<NodeId, readonly GraphRole[]>;
  readonly nodesByRole: ReadonlyMap<Role, readonly GraphNode[]>;
  readonly roleAnnotationCount: number;

  readonly unresolved: readonly GraphUnresolvedReference[];
  readonly unresolvedByType: ReadonlyMap<RelationshipType, readonly GraphUnresolvedReference[]>;

  /**
   * The weakest confidence observed among all edges of a type, or `null` when the repository has
   * none. This is what a finding resting on that relationship can honestly claim.
   */
  weakestConfidenceOf(types: readonly RelationshipType[]): ConfidenceLevel;

  readonly graphApiCalls: number;
}

/** Ordered strongest to weakest, so "weakest observed" is a maximum index. */
const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = CONFIDENCE_LEVELS;

export function buildGraphIndex(graph: HealthGraph): GraphIndex {
  let graphApiCalls = 0;

  const nodesByKind = new Map<NodeKind, readonly GraphNode[]>();
  const nodeById = new Map<NodeId, GraphNode>();

  for (const kind of NODE_KINDS) {
    const nodes = graph.getNodes(kind);

    graphApiCalls += 1;
    nodesByKind.set(kind, nodes);

    for (const node of nodes) {
      nodeById.set(node.id, node);
    }
  }

  const edgesByType = new Map<RelationshipType, readonly GraphEdge[]>();
  const weakestByType = new Map<RelationshipType, ConfidenceLevel | null>();

  const couplingOut = new Map<NodeId, NodeId[]>();
  const couplingIn = new Map<NodeId, NodeId[]>();
  const seenPair = new Set<string>();
  const incomingEdgeCount = new Map<NodeId, number>();
  const outgoingEdgeCount = new Map<NodeId, number>();

  let edgeCount = 0;

  for (const type of RELATIONSHIP_TYPES) {
    const edges = graph.getEdges(type);

    graphApiCalls += 1;
    edgesByType.set(type, edges);
    edgeCount += edges.length;

    let weakest: ConfidenceLevel | null = null;
    // Containment is not a reference, so it is counted in `edgeCount` but kept out of coupling.
    const isReference = type !== 'DECLARES';

    for (const edge of edges) {
      weakest = weaker(weakest, edge.confidence);

      if (!isReference) {
        continue;
      }

      outgoingEdgeCount.set(edge.sourceId, (outgoingEdgeCount.get(edge.sourceId) ?? 0) + 1);
      incomingEdgeCount.set(edge.targetId, (incomingEdgeCount.get(edge.targetId) ?? 0) + 1);

      // Coupling counts distinct neighbours, so a pair related twice contributes once.
      const pair = `${edge.sourceId}\u0000${edge.targetId}`;

      if (!seenPair.has(pair)) {
        seenPair.add(pair);
        push(couplingOut, edge.sourceId, edge.targetId);
        push(couplingIn, edge.targetId, edge.sourceId);
      }
    }

    weakestByType.set(type, weakest);
  }

  // Roles are annotations on declarations only, so files, routes and externals are skipped.
  const rolesByNode = new Map<NodeId, readonly GraphRole[]>();
  const nodesByRole = new Map<Role, GraphNode[]>(ROLES.map((role) => [role, []]));

  let roleAnnotationCount = 0;

  const declarations = DECLARATION_NODE_KINDS.flatMap((kind) => nodesByKind.get(kind) ?? []);

  for (const node of declarations) {
    const roles = graph.getRoles(node.id);

    graphApiCalls += 1;

    if (roles.length === 0) {
      continue;
    }

    rolesByNode.set(node.id, roles);
    roleAnnotationCount += roles.length;

    for (const role of roles) {
      nodesByRole.get(role.role)?.push(node);
    }
  }

  const unresolved = graph.getUnresolved();

  graphApiCalls += 1;

  const unresolvedByType = new Map<RelationshipType, GraphUnresolvedReference[]>();

  for (const reference of unresolved) {
    const bucket = unresolvedByType.get(reference.type);

    if (bucket === undefined) {
      unresolvedByType.set(reference.type, [reference]);
    } else {
      bucket.push(reference);
    }
  }

  // Per-type adjacency is derived on demand and memoised: only a few types are ever asked for,
  // and building all thirteen upfront would allocate maps nothing reads.
  const adjacencyCache = new Map<RelationshipType, Adjacency>();

  return {
    nodesByKind,
    nodeById,
    declarations,
    files: nodesByKind.get('File') ?? [],
    edgesByType,
    edgeCount,
    coupling: { out: couplingOut, in: couplingIn },
    incomingEdgeCount,
    outgoingEdgeCount,
    adjacencyOf(type) {
      const cached = adjacencyCache.get(type);

      if (cached !== undefined) {
        return cached;
      }

      const built = adjacencyFor(edgesByType.get(type) ?? []);

      adjacencyCache.set(type, built);

      return built;
    },
    rolesByNode,
    nodesByRole,
    roleAnnotationCount,
    unresolved,
    unresolvedByType,
    weakestConfidenceOf(types) {
      let result: ConfidenceLevel | null = null;

      for (const type of types) {
        result = weaker(result, weakestByType.get(type) ?? null);
      }

      // With no edge of any of those types present, nothing weakens the claim: it rests on the
      // structure of the graph itself.
      return result ?? 'CERTAIN';
    },
    graphApiCalls,
  };
}

function adjacencyFor(edges: readonly GraphEdge[]): Adjacency {
  const out = new Map<NodeId, NodeId[]>();
  const incoming = new Map<NodeId, NodeId[]>();
  const seen = new Set<string>();

  for (const edge of edges) {
    const pair = `${edge.sourceId}\u0000${edge.targetId}`;

    if (seen.has(pair)) {
      continue;
    }

    seen.add(pair);
    push(out, edge.sourceId, edge.targetId);
    push(incoming, edge.targetId, edge.sourceId);
  }

  return { out, in: incoming };
}

function push(map: Map<NodeId, NodeId[]>, key: NodeId, value: NodeId): void {
  const existing = map.get(key);

  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function weaker(left: ConfidenceLevel | null, right: ConfidenceLevel | null): ConfidenceLevel | null {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return CONFIDENCE_ORDER.indexOf(left) >= CONFIDENCE_ORDER.indexOf(right) ? left : right;
}
