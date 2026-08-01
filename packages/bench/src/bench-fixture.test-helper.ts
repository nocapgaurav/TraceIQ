import type {
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
  RepositoryCapabilities,
  RepositoryGraphApi,
} from '@traceiq/graph-api';
import type { NodeId, RelationshipType } from '@traceiq/types';

/**
 * A `RepositoryGraphApi` holding exactly the edges and unresolved references a test
 * states.
 *
 * The benchmark reads `getEdges`, `getUnresolved`, `getCapabilities` and `getNodes`, so
 * those are answered. The rest of the interface is present to satisfy the type and throws
 * if reached: a silent empty return would let the metrics quietly start depending on an
 * accessor no test had exercised.
 */
export interface FakeGraph {
  readonly edges?: readonly GraphEdge[];
  readonly unresolved?: readonly GraphUnresolvedReference[];
  readonly capabilities?: RepositoryCapabilities;
  /** Only `Manifest` and `Dependency` are read, for the universal counts. */
  readonly nodes?: readonly GraphNode[];
}

/** A fake graph claims no analysis depth unless a test states one. */
const NO_CAPABILITIES: RepositoryCapabilities = {
  depth: 'universal',
  regions: [],
  languages: [],
  isPolyglot: false,
};

export class FakeGraphApi implements RepositoryGraphApi {
  readonly #edges: readonly GraphEdge[];
  readonly #unresolved: readonly GraphUnresolvedReference[];
  readonly #capabilities: RepositoryCapabilities;
  readonly #nodes: readonly GraphNode[];

  constructor(input: FakeGraph) {
    this.#edges = input.edges ?? [];
    this.#unresolved = input.unresolved ?? [];
    this.#capabilities = input.capabilities ?? NO_CAPABILITIES;
    this.#nodes = input.nodes ?? [];
  }

  getEdges(type: RelationshipType): readonly GraphEdge[] {
    return this.#edges.filter((edge) => edge.type === type);
  }

  getUnresolved(): readonly GraphUnresolvedReference[] {
    return this.#unresolved;
  }

  getCapabilities(): RepositoryCapabilities {
    return this.#capabilities;
  }

  getNode(): GraphNode | null {
    throw new Error('the benchmark must not read nodes');
  }

  exists(): boolean {
    throw new Error('the benchmark must not test node existence');
  }

  getOutgoing(): readonly GraphEdge[] {
    throw new Error('the benchmark must not traverse');
  }

  getIncoming(): readonly GraphEdge[] {
    throw new Error('the benchmark must not traverse');
  }

  getNodes(kind: NodeKind): readonly GraphNode[] {
    return this.#nodes.filter((node) => node.kind === kind);
  }

  getRoles(_nodeId: NodeId): readonly GraphRole[] {
    throw new Error('the benchmark must not read roles');
  }
}

const LOCATION = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } as const;

const PROVENANCE = {
  producer: 'test',
  fileId: 'file:src/a.ts' as NodeId,
  evidence: 'stated by a test',
} as const;

let counter = 0;

export function edge(input: {
  readonly type: RelationshipType;
  readonly targetId: string;
  readonly confidence?: GraphEdge['confidence'];
}): GraphEdge {
  counter += 1;

  return {
    id: `edge:${counter}`,
    type: input.type,
    sourceId: 'file:src/a.ts' as NodeId,
    targetId: input.targetId as NodeId,
    name: null,
    confidence: input.confidence ?? 'RESOLVED',
    candidateGroup: null,
    ordinal: null,
    provenance: PROVENANCE,
    location: LOCATION,
  };
}

export function unresolved(input: {
  readonly type: RelationshipType;
  readonly reason: string;
}): GraphUnresolvedReference {
  counter += 1;

  return {
    id: `unresolved:${counter}`,
    type: input.type,
    sourceId: 'file:src/a.ts' as NodeId,
    name: null,
    reason: input.reason,
    text: 'whatever',
    provenance: PROVENANCE,
    location: LOCATION,
  };
}

export const FACTS = {
  repository: 'fixture',
  repositoryPath: '/tmp/fixture',
  files: 1,
  nodes: 2,
  scanMillis: 0,
} as const;
