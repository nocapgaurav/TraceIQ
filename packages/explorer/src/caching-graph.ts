import type { GraphEdge, GraphNode, GraphRole, GraphUnresolvedReference, NodeKind, RepositoryGraphApi } from '@traceiq/graph-api';
import type { NodeId, RelationshipType } from '@traceiq/types';

/**
 * A memoising `RepositoryGraphApi`.
 *
 * The explorer reuses Explain Symbol, Impact Analysis and Repository Health rather than
 * reimplementing them — and each of those reads the graph for itself. Passing them the same
 * adapter means the second reader of a node, an edge list or the unresolved set is answered from
 * memory, so reuse costs one graph read rather than one per capability.
 *
 * Every operation it wraps is a **pure read** of one immutable revision, which is what makes
 * caching sound rather than a correctness risk: the graph holds a single revision and nothing in
 * the read layer writes. `calls` records what actually reached the underlying graph and `hits` what
 * the cache answered, so the saving is measured rather than asserted.
 */
export class CachingGraph implements RepositoryGraphApi {
  readonly #api: RepositoryGraphApi;

  readonly #nodes = new Map<NodeId, GraphNode | null>();
  readonly #outgoing = new Map<string, readonly GraphEdge[]>();
  readonly #incoming = new Map<string, readonly GraphEdge[]>();
  readonly #edges = new Map<RelationshipType, readonly GraphEdge[]>();
  readonly #nodesByKind = new Map<NodeKind, readonly GraphNode[]>();
  readonly #roles = new Map<NodeId, readonly GraphRole[]>();

  #unresolved: readonly GraphUnresolvedReference[] | null = null;

  /** Calls that reached the underlying graph. */
  readonly calls = {
    getNode: 0,
    exists: 0,
    getOutgoing: 0,
    getIncoming: 0,
    getEdges: 0,
    getNodes: 0,
    getRoles: 0,
    getUnresolved: 0,
  };

  /** Calls the cache answered without touching the graph. */
  #hits = 0;

  constructor(api: RepositoryGraphApi) {
    this.#api = api;
  }

  get hits(): number {
    return this.#hits;
  }

  get graphCalls(): number {
    return Object.values(this.calls).reduce((total, count) => total + count, 0);
  }

  getNode(id: NodeId): GraphNode | null {
    const cached = this.#nodes.get(id);

    if (cached !== undefined) {
      this.#hits += 1;

      return cached;
    }

    this.calls.getNode += 1;

    const node = this.#api.getNode(id);

    this.#nodes.set(id, node);

    return node;
  }

  exists(id: NodeId): boolean {
    // Answered from the node cache when possible: `exists` and `getNode` ask the same question.
    const cached = this.#nodes.get(id);

    if (cached !== undefined) {
      this.#hits += 1;

      return cached !== null;
    }

    this.calls.exists += 1;

    return this.#api.exists(id);
  }

  getOutgoing(id: NodeId, type?: RelationshipType): readonly GraphEdge[] {
    return this.#edgeList(this.#outgoing, id, type, () => this.#api.getOutgoing(id, type), 'getOutgoing');
  }

  getIncoming(id: NodeId, type?: RelationshipType): readonly GraphEdge[] {
    return this.#edgeList(this.#incoming, id, type, () => this.#api.getIncoming(id, type), 'getIncoming');
  }

  getEdges(type: RelationshipType): readonly GraphEdge[] {
    const cached = this.#edges.get(type);

    if (cached !== undefined) {
      this.#hits += 1;

      return cached;
    }

    this.calls.getEdges += 1;

    const edges = this.#api.getEdges(type);

    this.#edges.set(type, edges);

    return edges;
  }

  getNodes(kind: NodeKind): readonly GraphNode[] {
    const cached = this.#nodesByKind.get(kind);

    if (cached !== undefined) {
      this.#hits += 1;

      return cached;
    }

    this.calls.getNodes += 1;

    const nodes = this.#api.getNodes(kind);

    this.#nodesByKind.set(kind, nodes);

    // Every node of a kind is a node, so this also warms the identifier cache.
    for (const node of nodes) {
      if (!this.#nodes.has(node.id)) {
        this.#nodes.set(node.id, node);
      }
    }

    return nodes;
  }

  getRoles(nodeId: NodeId): readonly GraphRole[] {
    const cached = this.#roles.get(nodeId);

    if (cached !== undefined) {
      this.#hits += 1;

      return cached;
    }

    this.calls.getRoles += 1;

    const roles = this.#api.getRoles(nodeId);

    this.#roles.set(nodeId, roles);

    return roles;
  }

  getUnresolved(): readonly GraphUnresolvedReference[] {
    if (this.#unresolved !== null) {
      this.#hits += 1;

      return this.#unresolved;
    }

    this.calls.getUnresolved += 1;
    this.#unresolved = this.#api.getUnresolved();

    return this.#unresolved;
  }

  #edgeList(
    cache: Map<string, readonly GraphEdge[]>,
    id: NodeId,
    type: RelationshipType | undefined,
    read: () => readonly GraphEdge[],
    counter: 'getOutgoing' | 'getIncoming',
  ): readonly GraphEdge[] {
    const key = `${id}\u0000${type ?? ''}`;
    const cached = cache.get(key);

    if (cached !== undefined) {
      this.#hits += 1;

      return cached;
    }

    this.calls[counter] += 1;

    const edges = read();

    cache.set(key, edges);

    return edges;
  }
}
