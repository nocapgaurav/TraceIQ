import type { RepositoryCapabilities } from '@traceiq/graph-api';
import type {
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
} from '@traceiq/graph-api';
import type {
  CalleeResult,
  DeclarationResult,
  DependencyResult,
  EnvironmentVariableResult,
  ReferenceResult,
  RouteResult,
  UnresolvedResult,
} from '@traceiq/query';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

import type { ImpactQueries } from './types.js';

const DECLARATION_KINDS: readonly NodeKind[] = [
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

/**
 * An `ImpactQueries` backed by an in-memory node and edge set.
 *
 * Traversal is the thing under test, so the fake has to be graph-shaped rather than a fixed
 * list of answers: `findReferences` really does return the incoming edges of whatever node it
 * is asked about. Ordering matches the real implementation — edges by identifier — so a test
 * cannot pass here and fail against SQLite.
 *
 * There is no database and no Query Engine anywhere in it, and it counts calls, so the query
 * budget is asserted rather than trusted.
 */
export class FakeQueries implements ImpactQueries {
  readonly #nodes = new Map<NodeId, GraphNode>();
  readonly #edges: GraphEdge[] = [];
  readonly #roles: GraphRole[] = [];
  readonly #unresolved: GraphUnresolvedReference[] = [];

  routes: readonly RouteResult[] = [];
  environmentVariables: readonly EnvironmentVariableResult[] = [];
  dependencies: readonly DependencyResult[] = [];

  readonly calls = {
    findDeclaration: 0,
    findReferences: 0,
    findCallees: 0,
    findRoutes: 0,
    findEnvironmentVariables: 0,
    findDependencies: 0,
    findUnresolved: 0,
  };

  /** Every node `findReferences` was asked about, in order, so revisits are visible. */
  readonly referenceTargets: NodeId[] = [];

  resetCalls(): void {
    for (const key of Object.keys(this.calls) as (keyof FakeQueries['calls'])[]) {
      this.calls[key] = 0;
    }

    this.referenceTargets.length = 0;
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

  findDeclaration(id: NodeId): DeclarationResult | null {
    this.calls.findDeclaration += 1;

    const node = this.#nodes.get(id);

    if (node === undefined || !DECLARATION_KINDS.includes(node.kind)) {
      return null;
    }

    return { node, roles: this.#roles.filter((entry) => entry.nodeId === id) };
  }

  findReferences(id: NodeId): readonly ReferenceResult[] {
    this.calls.findReferences += 1;
    this.referenceTargets.push(id);

    return this.#edges
      .filter((entry) => entry.targetId === id && entry.type !== 'DECLARES')
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ edge: entry, source: this.#nodes.get(entry.sourceId) ?? null }));
  }

  findCallees(id: NodeId): readonly CalleeResult[] {
    this.calls.findCallees += 1;

    return this.#edges
      .filter((entry) => entry.sourceId === id && entry.type === 'CALLS')
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ edge: entry, target: this.#nodes.get(entry.targetId) ?? null }));
  }

  findRoutes(): readonly RouteResult[] {
    this.calls.findRoutes += 1;

    return this.routes;
  }

  findEnvironmentVariables(): readonly EnvironmentVariableResult[] {
    this.calls.findEnvironmentVariables += 1;

    return this.environmentVariables;
  }

  findDependencies(): readonly DependencyResult[] {
    this.calls.findDependencies += 1;

    return this.dependencies;
  }

  /**
   * Fully analysed unless a test says otherwise.
   *
   * `semantic` is the right default here: these fixtures are hand-built TypeScript-shaped
   * graphs, and defaulting to `universal` would attach an "unanalysed region" caveat to
   * every existing impact test.
   */
  capabilities(): RepositoryCapabilities {
    return this.capabilityRecord;
  }

  capabilityRecord: RepositoryCapabilities = {
    depth: 'semantic',
    regions: [
      {
        path: '',
        primaryLanguage: 'typescript',
        languages: [],
        ecosystems: [],
        fileCount: 0,
        sourceFileCount: 0,
        depth: 'semantic',
        reason: 'stated by a test',
      },
    ],
    languages: [],
    isPolyglot: false,
  };

  findUnresolved(): readonly UnresolvedResult[] {
    this.calls.findUnresolved += 1;

    return this.#unresolved.map((reference) => ({
      reference,
      source: this.#nodes.get(reference.sourceId) ?? null,
    }));
  }
}

const RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 };

export function node(input: {
  readonly id: string;
  readonly kind: NodeKind;
  readonly fileId?: string | null;
  readonly confidence?: ConfidenceLevel;
}): GraphNode {
  return {
    id: input.id as NodeId,
    kind: input.kind,
    name: input.id.split(/[#.]/).at(-1) ?? input.id,
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
    externalKind: null,
    externalName: null,
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
    locations: [RANGE],
  };
}

export function edge(input: {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence?: ConfidenceLevel;
  readonly candidateGroup?: string | null;
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
    confidence: input.confidence ?? 'INFERRED',
    candidateGroup: input.candidateGroup ?? null,
    ordinal: input.ordinal ?? null,
    provenance: {
      producer: 'call-graph',
      fileId: (input.sourceId.startsWith('file:') ? input.sourceId : 'file:src/a.ts') as NodeId,
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

/** A `ReferenceResult`, which is an edge plus the node it came from. */
export function reference(from: GraphNode, at: GraphEdge): ReferenceResult {
  return { edge: at, source: from };
}
