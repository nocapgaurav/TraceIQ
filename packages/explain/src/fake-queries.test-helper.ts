import type { GraphEdge, GraphNode, GraphRole, GraphUnresolvedReference, NodeKind } from '@traceiq/graph-api';
import type {
  CalleeResult,
  DeclarationResult,
  DependencyResult,
  EnclosingResult,
  EnvironmentVariableResult,
  ReferenceResult,
  RouteExplanation,
  RouteResult,
  UnresolvedResult,
} from '@traceiq/query';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

import type { ExplainSymbolQueries } from './types.js';

/**
 * An `ExplainSymbolQueries` that answers from fixed lists and counts what it was asked.
 *
 * The explainer's unit suite runs against this rather than a Query Engine, and there is no
 * graph and no database anywhere in it. That is the point: if assembly works with nothing
 * but nine answers, it provably depends on the interface alone. Counting the calls is what
 * lets "one query per question" be asserted instead of trusted.
 *
 * `pipeline.test.ts` then asks the same questions of a real `QueryEngine` over real SQLite,
 * so a passing test here cannot be an artefact of this stub.
 */
export class FakeQueries implements ExplainSymbolQueries {
  readonly calls = {
    findDeclaration: 0,
    findEnclosingDeclaration: 0,
    findReferences: 0,
    findCallees: 0,
    findRoutes: 0,
    explainRoute: 0,
    findEnvironmentVariables: 0,
    findDependencies: 0,
    findUnresolved: 0,
  };

  declaration: DeclarationResult | null = null;
  enclosing: EnclosingResult | null = null;
  references: readonly ReferenceResult[] = [];
  callees: readonly CalleeResult[] = [];
  routes: readonly RouteResult[] = [];
  explanations = new Map<string, RouteExplanation>();
  environmentVariables: readonly EnvironmentVariableResult[] = [];
  dependencies: readonly DependencyResult[] = [];
  unresolvedReferences: readonly UnresolvedResult[] = [];

  resetCalls(): void {
    for (const key of Object.keys(this.calls) as (keyof FakeQueries['calls'])[]) {
      this.calls[key] = 0;
    }
  }

  findDeclaration(id: NodeId): DeclarationResult | null {
    this.calls.findDeclaration += 1;

    return this.declaration?.node.id === id ? this.declaration : null;
  }

  findEnclosingDeclaration(): EnclosingResult | null {
    this.calls.findEnclosingDeclaration += 1;

    return this.enclosing;
  }

  findReferences(): readonly ReferenceResult[] {
    this.calls.findReferences += 1;

    return this.references;
  }

  findCallees(): readonly CalleeResult[] {
    this.calls.findCallees += 1;

    return this.callees;
  }

  findRoutes(): readonly RouteResult[] {
    this.calls.findRoutes += 1;

    return this.routes;
  }

  explainRoute(routeId: NodeId): RouteExplanation | null {
    this.calls.explainRoute += 1;

    return this.explanations.get(routeId) ?? null;
  }

  findEnvironmentVariables(): readonly EnvironmentVariableResult[] {
    this.calls.findEnvironmentVariables += 1;

    return this.environmentVariables;
  }

  findDependencies(): readonly DependencyResult[] {
    this.calls.findDependencies += 1;

    return this.dependencies;
  }

  findUnresolved(): readonly UnresolvedResult[] {
    this.calls.findUnresolved += 1;

    return this.unresolvedReferences;
  }
}

const RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 };

export function node(input: {
  readonly id: string;
  readonly kind: NodeKind;
  readonly fileId?: string | null;
  readonly confidence?: ConfidenceLevel;
  readonly lines?: readonly number[];
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
    confidence: input.confidence ?? 'CERTAIN',
    provenance: {
      producer: 'graph-builder',
      fileId: (input.fileId ?? null) as NodeId | null,
      evidence: `synthetic ${input.kind} node for testing`,
    },
    locations: (input.lines ?? [1]).map((line) => ({ ...RANGE, startLine: line, endLine: line })),
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
    confidence: input.confidence ?? 'RESOLVED',
    candidateGroup: input.candidateGroup ?? null,
    ordinal: input.ordinal ?? null,
    provenance: {
      producer: 'resolver',
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
  readonly text?: string;
  readonly reason?: string;
}): GraphUnresolvedReference {
  return {
    id: `unresolved|${input.type}|${input.sourceId}|${input.text ?? 'x'}`,
    type: input.type,
    sourceId: input.sourceId as NodeId,
    name: null,
    reason: input.reason ?? 'root-not-bound',
    text: input.text ?? 'x',
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
