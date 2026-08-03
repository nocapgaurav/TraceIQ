import type {
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
  RepositoryCapabilities,
  RepositoryGraphApi,
} from '@traceiq/graph-api';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

/**
 * An in-memory `RepositoryGraphApi`.
 *
 * The Query Engine's tests run against this rather than a database, which is the point:
 * if the engine works with no SQLite present anywhere, it provably depends on the
 * interface alone. It also counts calls, so a test can assert that traversal stays
 * bounded instead of taking it on trust.
 *
 * Ordering matches the real implementation — nodes and edges by identifier, roles by
 * role name — so a test cannot pass here and fail against SQLite.
 */
export class FakeGraph implements RepositoryGraphApi {
  /** Overridable, so a test can exercise a capability-aware consumer. */
  capabilities: RepositoryCapabilities = {
    depth: 'universal',
    regions: [],
    languages: [],
    isPolyglot: false,
  };

  readonly #nodes = new Map<NodeId, GraphNode>();
  readonly #edges: GraphEdge[] = [];
  readonly #roles: GraphRole[] = [];
  readonly #unresolved: GraphUnresolvedReference[] = [];

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

  resetCalls(): void {
    for (const key of Object.keys(this.calls) as (keyof FakeGraph['calls'])[]) {
      this.calls[key] = 0;
    }
  }

  addNode(node: GraphNode): this {
    this.#nodes.set(node.id, node);

    return this;
  }

  addEdge(edge: GraphEdge): this {
    this.#edges.push(edge);

    return this;
  }

  addRole(role: GraphRole): this {
    this.#roles.push(role);

    return this;
  }

  addUnresolved(reference: GraphUnresolvedReference): this {
    this.#unresolved.push(reference);

    return this;
  }

  getNode(id: NodeId): GraphNode | null {
    this.calls.getNode += 1;

    return this.#nodes.get(id) ?? null;
  }

  exists(id: NodeId): boolean {
    this.calls.exists += 1;

    return this.#nodes.has(id);
  }

  getOutgoing(id: NodeId, type?: RelationshipType): readonly GraphEdge[] {
    this.calls.getOutgoing += 1;

    return this.#sorted(
      this.#edges.filter((edge) => edge.sourceId === id && (type === undefined || edge.type === type)),
    );
  }

  getIncoming(id: NodeId, type?: RelationshipType): readonly GraphEdge[] {
    this.calls.getIncoming += 1;

    return this.#sorted(
      this.#edges.filter((edge) => edge.targetId === id && (type === undefined || edge.type === type)),
    );
  }

  getEdges(type: RelationshipType): readonly GraphEdge[] {
    this.calls.getEdges += 1;

    return this.#sorted(this.#edges.filter((edge) => edge.type === type));
  }

  getNodes(kind: NodeKind): readonly GraphNode[] {
    this.calls.getNodes += 1;

    return [...this.#nodes.values()]
      .filter((node) => node.kind === kind)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getRoles(nodeId: NodeId): readonly GraphRole[] {
    this.calls.getRoles += 1;

    return this.#roles
      .filter((role) => role.nodeId === nodeId)
      .sort((left, right) => left.role.localeCompare(right.role));
  }

  /**
   * A fake graph describes no repository, so it claims no analysis depth.
   *
   * `universal` with no regions is the honest answer for hand-built nodes: a test that
   * needs a specific capability states it through `capabilities`.
   */
  getCapabilities(): RepositoryCapabilities {
    return this.capabilities;
  }

  getUnresolved(): readonly GraphUnresolvedReference[] {
    this.calls.getUnresolved += 1;

    return [...this.#unresolved].sort((left, right) => left.id.localeCompare(right.id));
  }

  #sorted(edges: readonly GraphEdge[]): readonly GraphEdge[] {
    return [...edges].sort((left, right) => left.id.localeCompare(right.id));
  }
}

const RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 };

export function node(input: {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name?: string;
  readonly fileId?: string | null;
  readonly confidence?: ConfidenceLevel;
  readonly externalKind?: GraphNode['externalKind'];
  readonly externalName?: string | null;
  readonly locations?: readonly { startLine: number }[];
}): GraphNode {
  return {
    id: input.id as NodeId,
    kind: input.kind,
    name: input.name ?? input.id,
    fileId: (input.fileId ?? null) as NodeId | null,
    containerChain: null,
    visibility: null,
    isExported: false,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
    isDeclarationFile: null,
    hasSymbol: null,
    isExportedFromModule: null,
    externalKind: input.externalKind ?? null,
    externalName: input.externalName ?? null,
    language: null,
    fileRole: null,
    category: null,
    artifactKind: null,
    confidence: input.confidence ?? 'CERTAIN',
    provenance: {
      producer: 'graph-builder',
      fileId: (input.fileId ?? null) as NodeId | null,
      evidence: `synthetic ${input.kind} node for testing`,
    },
    locations: (input.locations ?? [{ startLine: 1 }]).map((entry) => ({
      ...RANGE,
      startLine: entry.startLine,
      endLine: entry.startLine,
    })),
  };
}

export function edge(input: {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly name?: string | null;
  readonly ordinal?: number | null;
  readonly confidence?: ConfidenceLevel;
  readonly fileId?: string;
  readonly line?: number;
}): GraphEdge {
  const line = input.line ?? 1;

  return {
    id: `edge:${input.type}|${input.sourceId}|${input.targetId}|${input.name ?? ''}|${line}`,
    type: input.type,
    sourceId: input.sourceId as NodeId,
    targetId: input.targetId as NodeId,
    name: input.name ?? null,
    confidence: input.confidence ?? 'RESOLVED',
    candidateGroup: null,
    ordinal: input.ordinal ?? null,
    provenance: {
      producer: 'resolver',
      fileId: (input.fileId ?? 'file:src/a.ts') as NodeId,
      evidence: `synthetic ${input.type} edge for testing`,
    },
    location: { ...RANGE, startLine: line, endLine: line },
  };
}

export function role(input: {
  readonly nodeId: string;
  readonly role: Role;
}): GraphRole {
  return {
    nodeId: input.nodeId as NodeId,
    role: input.role,
    confidence: 'INFERRED',
    evidence: `synthetic ${input.role} role for testing`,
  };
}

export function unresolved(input: {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly reason?: string;
  readonly text?: string;
  readonly name?: string | null;
}): GraphUnresolvedReference {
  return {
    id: `unresolved|${input.type}|${input.sourceId}|${input.text ?? 'x'}`,
    type: input.type,
    sourceId: input.sourceId as NodeId,
    name: input.name ?? null,
    reason: input.reason ?? 'no-symbol',
    text: input.text ?? 'x',
    provenance: {
      producer: 'resolver',
      fileId: 'file:src/a.ts' as NodeId,
      evidence: 'synthetic unresolved reference for testing',
    },
    location: RANGE,
  };
}
