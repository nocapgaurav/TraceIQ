import type {
  RepositoryCapabilities,
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
} from '@traceiq/graph-api';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

import type { HealthGraph } from './types.js';

/**
 * An in-memory `HealthGraph`.
 *
 * The health suite runs against this rather than a database: if the analyser works with no SQLite
 * present anywhere, it provably depends on the read interface alone. Ordering matches the real
 * implementation — nodes and edges by identifier, roles by role name — so a test cannot pass here
 * and fail against SQLite.
 *
 * It counts calls, which is what lets "one pass over the graph" be asserted rather than trusted.
 */
export class FakeGraph implements HealthGraph {
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

  readonly calls = { getNodes: 0, getEdges: 0, getRoles: 0, getUnresolved: 0 };

  resetCalls(): void {
    for (const key of Object.keys(this.calls) as (keyof FakeGraph['calls'])[]) {
      this.calls[key] = 0;
    }
  }

  addNode(node: GraphNode): this {
    this.#nodes.set(node.id, node);

    return this;
  }

  addEdge(entry: GraphEdge): this {
    this.#edges.push(entry);

    return this;
  }

  addRole(entry: GraphRole): this {
    this.#roles.push(entry);

    return this;
  }

  addUnresolved(entry: GraphUnresolvedReference): this {
    this.#unresolved.push(entry);

    return this;
  }

  getNodes(kind: NodeKind): readonly GraphNode[] {
    this.calls.getNodes += 1;

    return [...this.#nodes.values()]
      .filter((node) => node.kind === kind)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getEdges(type: RelationshipType): readonly GraphEdge[] {
    this.calls.getEdges += 1;

    return this.#edges
      .filter((edge) => edge.type === type)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getRoles(nodeId: NodeId): readonly GraphRole[] {
    this.calls.getRoles += 1;

    return this.#roles
      .filter((entry) => entry.nodeId === nodeId)
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
}

const RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 };

export function node(input: {
  readonly id: string;
  readonly kind: NodeKind;
  readonly fileId?: string | null;
  readonly isExported?: boolean;
  readonly externalKind?: GraphNode['externalKind'];
  readonly confidence?: ConfidenceLevel;
}): GraphNode {
  return {
    id: input.id as NodeId,
    kind: input.kind,
    name: input.id.split(/[#.]/).at(-1) ?? input.id,
    fileId: (input.fileId ?? null) as NodeId | null,
    containerChain: null,
    visibility: null,
    isExported: input.isExported ?? false,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
    isDeclarationFile: null,
    hasSymbol: null,
    isExportedFromModule: null,
    externalKind: input.externalKind ?? null,
    externalName: null,
    language: null,
    fileRole: null,
    category: null,
    confidence: input.confidence ?? 'CERTAIN',
    provenance: {
      producer: 'graph-builder',
      fileId: (input.fileId ?? null) as NodeId | null,
      evidence: `synthetic ${input.kind} node for testing`,
    },
    locations: [RANGE],
  };
}

export function edge(input: {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence?: ConfidenceLevel;
  readonly ordinal?: number | null;
  readonly line?: number;
}): GraphEdge {
  const line = input.line ?? 1;

  return {
    id: `edge:${input.type}|${input.sourceId}|${input.targetId}|${line}`,
    type: input.type,
    sourceId: input.sourceId as NodeId,
    targetId: input.targetId as NodeId,
    name: null,
    confidence: input.confidence ?? 'RESOLVED',
    candidateGroup: null,
    ordinal: input.ordinal ?? null,
    provenance: {
      producer: 'graph-builder',
      fileId: 'file:src/a.ts' as NodeId,
      evidence: `synthetic ${input.type} edge for testing`,
    },
    location: { ...RANGE, startLine: line, endLine: line },
  };
}

export function role(nodeId: string, name: Role): GraphRole {
  return {
    nodeId: nodeId as NodeId,
    role: name,
    confidence: 'INFERRED',
    evidence: `synthetic ${name} role for testing`,
  };
}

export function unresolved(input: {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly text: string;
  readonly reason?: string;
}): GraphUnresolvedReference {
  return {
    id: `unresolved|${input.type}|${input.sourceId}|${input.text}`,
    type: input.type,
    sourceId: input.sourceId as NodeId,
    name: null,
    reason: input.reason ?? 'root-not-bound',
    text: input.text,
    provenance: {
      producer: 'call-graph',
      fileId: 'file:src/a.ts' as NodeId,
      evidence: 'synthetic unresolved reference for testing',
    },
    location: RANGE,
  };
}
