import type { FrameworkAnnotations, RouteAnnotation } from '@traceiq/framework';
import type { GraphEdge, GraphNode, GraphRole, GraphUnresolvedReference } from '@traceiq/graph-api';
import type { SourceRange } from '@traceiq/ir';
import { InvalidNodeIdError, environmentVariableId, routeId } from '@traceiq/shared';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

import { edgeIdentity, strongerConfidence } from './identity.js';

const PRODUCER = 'graph-builder';

export interface AnnotationTranslation {
  /** `Route` and `EnvironmentVariable` nodes. */
  readonly nodes: readonly GraphNode[];
  /** `HANDLED_BY` and `READS` edges. */
  readonly edges: readonly GraphEdge[];
  /** Handlers and variable names that could not become an edge. */
  readonly unresolved: readonly GraphUnresolvedReference[];
  readonly roles: readonly GraphRole[];
}

interface MergedNode {
  readonly name: string;
  fileId: NodeId | null;
  fileIdSettled: boolean;
  confidence: ConfidenceLevel;
  references: number;
  readonly locations: SourceRange[];
}

/**
 * Translates framework annotations into graph rows.
 *
 * Pure translation, like the rest of the Graph Builder: every field is copied from an
 * annotation, and the only derived values are node identities and the confidence
 * maximum that materialising a shared node requires.
 *
 * Route paths are **as written**. Prefix composition — turning `app.use('/api', router)`
 * plus `router.get('/x')` into `/api/x` — is deliberately not performed here; it is a
 * Query Engine responsibility.
 */
export function translateAnnotations(input: {
  readonly annotations: FrameworkAnnotations;
}): AnnotationTranslation {
  const edges: GraphEdge[] = [];
  const unresolved: GraphUnresolvedReference[] = [];
  const routes = new Map<NodeId, MergedNode>();
  const variables = new Map<NodeId, MergedNode>();

  for (const route of input.annotations.routes) {
    translateRoute({ route, routes, edges, unresolved });
  }

  for (const usage of input.annotations.environmentVariables) {
    let id: NodeId;

    try {
      id = environmentVariableId(usage.name);
    } catch (cause) {
      // A name the frozen `env:<NAME>` form cannot carry — `process.env['MY-VAR']`.
      // Kept visible rather than dropped, and never mangled into a different name.
      unresolved.push({
        id: `unresolved|READS|${usage.provenance.fileId}|${usage.name}|${usage.location.startLine}:${usage.location.startColumn}`,
        type: 'READS',
        sourceId: usage.usedInDeclarationId ?? usage.provenance.fileId,
        name: usage.name,
        reason: 'unaddressable-environment-name',
        text: usage.name,
        provenance: {
          producer: usage.provenance.annotator,
          fileId: usage.provenance.fileId,
          evidence:
            cause instanceof InvalidNodeIdError
              ? cause.message
              : `'${usage.name}' cannot form an env: identifier`,
        },
        location: usage.location,
      });

      continue;
    }

    merge(variables, id, {
      name: usage.name,
      fileId: null,
      confidence: usage.confidence,
      location: usage.location,
      // A variable belongs to the process, not to a file, so it never settles a fileId.
      recordFile: false,
    });

    const sourceId = usage.usedInDeclarationId ?? usage.provenance.fileId;

    edges.push({
      id: edgeIdentity(
        'READS',
        sourceId,
        id,
        usage.name,
        usage.provenance.fileId,
        usage.location,
      ),
      type: 'READS',
      sourceId,
      targetId: id,
      name: usage.name,
      confidence: usage.confidence,
      candidateGroup: null,
      ordinal: null,
      provenance: {
        producer: usage.provenance.annotator,
        fileId: usage.provenance.fileId,
        evidence: usage.provenance.evidence,
      },
      location: usage.location,
    });
  }

  return {
    nodes: [
      ...materialise(routes, 'Route', 'registration'),
      ...materialise(variables, 'EnvironmentVariable', 'read'),
    ],
    edges,
    unresolved,
    roles: input.annotations.roles.map((role) => ({
      nodeId: role.declarationId,
      role: role.role,
      confidence: role.confidence,
      evidence: role.provenance.evidence,
    })),
  };
}

function translateRoute(input: {
  readonly route: RouteAnnotation;
  readonly routes: Map<NodeId, MergedNode>;
  readonly edges: GraphEdge[];
  readonly unresolved: GraphUnresolvedReference[];
}): void {
  const { route } = input;
  const id = routeId(route.method, route.path);

  merge(input.routes, id, {
    name: `${route.method} ${route.path}`,
    fileId: route.provenance.fileId,
    confidence: route.confidence,
    location: route.location,
    recordFile: true,
  });

  const seen = new Set<NodeId>();

  for (const handler of route.handlers) {
    if (handler.declarationId === null) {
      // A member expression or an inline function. The Framework Extractor could not
      // link it without resolving, so there is no node to point at.
      input.unresolved.push({
        id: `unresolved|HANDLED_BY|${id}|${handler.text}|${route.location.startLine}:${route.location.startColumn}`,
        type: 'HANDLED_BY',
        sourceId: id,
        name: handler.text,
        reason: 'handler-not-linked',
        text: handler.text,
        provenance: {
          producer: route.provenance.annotator,
          fileId: route.provenance.fileId,
          evidence: `handler '${handler.text}' is not a bare identifier naming a declaration in this file, so it cannot be linked without resolution`,
        },
        location: route.location,
      });

      continue;
    }

    // The same declaration listed twice would produce one identity twice. It is one
    // fact — this route is handled by that declaration — recorded at its first position.
    if (seen.has(handler.declarationId)) {
      continue;
    }

    seen.add(handler.declarationId);

    input.edges.push({
      id: edgeIdentity(
        'HANDLED_BY',
        id,
        handler.declarationId,
        handler.text,
        route.provenance.fileId,
        route.location,
      ),
      type: 'HANDLED_BY',
      sourceId: id,
      targetId: handler.declarationId,
      name: handler.text,
      confidence: route.confidence,
      candidateGroup: null,
      // The reserved ordinal column, finally used: it is what preserves middleware order.
      ordinal: handler.ordinal,
      provenance: {
        producer: route.provenance.annotator,
        fileId: route.provenance.fileId,
        evidence: route.provenance.evidence,
      },
      location: route.location,
    });
  }
}

function merge(
  target: Map<NodeId, MergedNode>,
  id: NodeId,
  input: {
    readonly name: string;
    readonly fileId: NodeId | null;
    readonly confidence: ConfidenceLevel;
    readonly location: SourceRange;
    readonly recordFile: boolean;
  },
): void {
  const existing = target.get(id);

  if (existing === undefined) {
    target.set(id, {
      name: input.name,
      fileId: input.recordFile ? input.fileId : null,
      fileIdSettled: input.recordFile,
      confidence: input.confidence,
      references: 1,
      locations: [input.location],
    });

    return;
  }

  existing.references += 1;
  existing.locations.push(input.location);
  existing.confidence = strongerConfidence(existing.confidence, input.confidence);

  // A node reached from two files belongs to neither. Without prefix composition this
  // is common for routes: `GET /` occurs in every router.
  if (existing.fileIdSettled && existing.fileId !== input.fileId) {
    existing.fileId = null;
  }
}

function materialise(
  merged: ReadonlyMap<NodeId, MergedNode>,
  kind: 'Route' | 'EnvironmentVariable',
  unit: string,
): readonly GraphNode[] {
  // Sorted by identity, so output does not depend on the order annotations arrived in.
  return [...merged.keys()].sort().flatMap((id) => {
    const node = merged.get(id);

    if (node === undefined) {
      return [];
    }

    return [
      {
        id,
        kind,
        name: node.name,
        fileId: node.fileId,
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
        confidence: node.confidence,
        provenance: {
          producer: PRODUCER,
          fileId: node.fileId,
          evidence: `materialised from ${node.references} framework ${unit}(s)`,
        },
        locations: [...node.locations].sort(
          (left, right) => left.startLine - right.startLine || left.startColumn - right.startColumn,
        ),
      },
    ];
  });
}
