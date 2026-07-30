import { NODE_KINDS, type GraphEdge, type GraphNode } from '@traceiq/graph-api';
import { parseRouteId } from '@traceiq/query';
import { RELATIONSHIP_TYPES, ROLES } from '@traceiq/types';
import type { NodeId, RelationshipType } from '@traceiq/types';

import type { Derived } from './derived.js';
import { connectedComponents } from './graph-algorithms.js';
import type { GraphIndex } from './graph-index.js';
import { distributionOf, ratio } from './statistics.js';
import type {
  ArchitectureReport,
  CallGraphHealthReport,
  CountedNodes,
  Cycle,
  DependencyHealthReport,
  DuplicateRegistration,
  EnvironmentReport,
  HandlerReuse,
  NodeMetric,
  RepositorySummary,
  RoutingReport,
  VariableUsage,
} from './types.js';

/**
 * How many entries a "most connected" or "never referenced" list carries.
 *
 * Every capped list reports its true `count` alongside and sets `truncated`, so a cap is never
 * silent. The number is a presentation choice, not a threshold: nothing is classified by it.
 */
export const MOST_CONNECTED_LIMIT = 20;
export const SAMPLE_LIMIT = 50;

/** Relationship types that express a dependency between modules. */
const DEPENDENCY_TYPES: readonly RelationshipType[] = ['IMPORTS', 'EXPORTS'];

export function summaryOf(index: GraphIndex): RepositorySummary {
  const nodesByKind = Object.fromEntries(
    NODE_KINDS.map((kind) => [kind, (index.nodesByKind.get(kind) ?? []).length]),
  ) as RepositorySummary['nodesByKind'];

  const externals = index.nodesByKind.get('External') ?? [];
  const externalsByKind: Record<string, number> = {};

  for (const external of externals) {
    const kind = external.externalKind ?? 'unknown';

    externalsByKind[kind] = (externalsByKind[kind] ?? 0) + 1;
  }

  return {
    files: index.files.length,
    declarations: index.declarations.length,
    classes: nodesByKind.Class,
    interfaces: nodesByKind.Interface,
    methods: nodesByKind.Method,
    functions: nodesByKind.Function,
    routes: nodesByKind.Route,
    environmentVariables: nodesByKind.EnvironmentVariable,
    externalPackages: externalsByKind['npm'] ?? 0,
    nodesByKind,
    externalsByKind,
    graph: {
      nodes: index.nodeById.size,
      edges: index.edgeCount,
      unresolvedReferences: index.unresolved.length,
      roleAnnotations: index.roleAnnotationCount,
    },
  };
}

export function architectureOf(index: GraphIndex): ArchitectureReport {
  const byRole = Object.fromEntries(
    ROLES.map((role) => [role, index.nodesByRole.get(role) ?? []]),
  ) as ArchitectureReport['byRole'];

  const roleCounts = Object.fromEntries(
    ROLES.map((role) => [role, (index.nodesByRole.get(role) ?? []).length]),
  ) as ArchitectureReport['roleCounts'];

  const relationshipCounts = Object.fromEntries(
    RELATIONSHIP_TYPES.map((type) => [type, (index.edgesByType.get(type) ?? []).length]),
  ) as ArchitectureReport['relationshipCounts'];

  const dependencyEdges = DEPENDENCY_TYPES.flatMap((type) => index.edgesByType.get(type) ?? []);
  const callEdges = index.edgesByType.get('CALLS') ?? [];

  return {
    roleCounts,
    byRole,
    relationshipCounts,
    dependencyGraph: { nodes: endpointCount(dependencyEdges), edges: dependencyEdges.length },
    callGraph: { nodes: endpointCount(callEdges), edges: callEdges.length },
    routes: (index.nodesByKind.get('Route') ?? []).length,
  };
}

export function dependencyHealthOf(index: GraphIndex, derived: Derived): DependencyHealthReport {
  const metrics = derived.declarationMetrics;

  const withoutIncoming = metrics.filter((entry) => entry.fanIn === 0);
  const withoutOutgoing = metrics.filter((entry) => entry.fanOut === 0);
  const isolated = metrics.filter((entry) => entry.fanIn === 0 && entry.fanOut === 0);

  const fileMetrics = derived.fileMetrics;

  return {
    mostReferenced: topBy(metrics, (entry) => entry.fanIn),
    mostDepending: topBy(metrics, (entry) => entry.fanOut),
    mostCoupledFiles: topBy(fileMetrics, (entry) => entry.fanIn + entry.fanOut),
    isolated: counted(isolated.map((entry) => entry.node)),
    withoutIncoming: counted(withoutIncoming.map((entry) => entry.node)),
    withoutOutgoing: counted(withoutOutgoing.map((entry) => entry.node)),
    externalUsage: externalUsageOf(index),
  };
}

export function callGraphHealthOf(index: GraphIndex, derived: Derived): CallGraphHealthReport {
  const callEdges = index.edgesByType.get('CALLS') ?? [];
  const unresolvedCalls = index.unresolvedByType.get('CALLS') ?? [];

  const unresolvedByReason: Record<string, number> = {};

  for (const reference of unresolvedCalls) {
    unresolvedByReason[reference.reason] = (unresolvedByReason[reference.reason] ?? 0) + 1;
  }

  // Only nodes that take part in a call are considered, so the many declarations with no call at
  // all do not each register as a cluster or a root. Components and roots come from `derived`,
  // computed once for both this section and the cycle findings.
  const components = derived.callCycles;

  const recursive = callEdges
    .filter((edge) => edge.sourceId === edge.targetId)
    .map((edge) => index.nodeById.get(edge.sourceId))
    .filter((node): node is GraphNode => node !== undefined);

  const cycles: Cycle[] = components.map((component) => ({
    relationshipType: 'CALLS',
    nodes: component
      .map((id) => index.nodeById.get(id))
      .filter((node): node is GraphNode => node !== undefined),
  }));

  return {
    callEdges: callEdges.length,
    unresolvedCalls: unresolvedCalls.length,
    coverage: ratio(callEdges.length, callEdges.length + unresolvedCalls.length),
    unresolvedByReason,
    recursive: counted(dedupeById(recursive)),
    cycles,
    declarationsInCycles: components.reduce((sum, component) => sum + component.length, 0),
    clusters: connectedComponents(derived.callAdjacency, derived.callParticipants),
    entryPoints: derived.callRoots.length,
    maxCallDepth: derived.maxCallDepth,
  };
}

export function routingOf(index: GraphIndex): RoutingReport {
  const routes = index.nodesByKind.get('Route') ?? [];
  const handledBy = index.edgesByType.get('HANDLED_BY') ?? [];

  const byRoute = new Map<NodeId, GraphEdge[]>();

  for (const edge of handledBy) {
    const bucket = byRoute.get(edge.sourceId);

    if (bucket === undefined) {
      byRoute.set(edge.sourceId, [edge]);
    } else {
      bucket.push(edge);
    }
  }

  const byMethod: Record<string, number> = {};

  for (const route of routes) {
    const identity = parseRouteId(route.id);
    const method = identity?.method ?? 'UNKNOWN';

    byMethod[method] = (byMethod[method] ?? 0) + 1;
  }

  const duplicateRegistrations: DuplicateRegistration[] = [];

  for (const route of routes) {
    const edges = byRoute.get(route.id) ?? [];
    const byOrdinal = new Map<number | null, GraphEdge[]>();

    for (const edge of edges) {
      const bucket = byOrdinal.get(edge.ordinal);

      if (bucket === undefined) {
        byOrdinal.set(edge.ordinal, [edge]);
      } else {
        bucket.push(edge);
      }
    }

    for (const [ordinal, group] of byOrdinal) {
      if (group.length > 1) {
        duplicateRegistrations.push({ route, ordinal, edges: group });
      }
    }
  }

  // One declaration handling several routes. Reported as a fact: a shared middleware is normal,
  // and the report does not decide which case this is.
  const routesByHandler = new Map<NodeId, GraphNode[]>();

  for (const edge of handledBy) {
    const route = index.nodeById.get(edge.sourceId);

    if (route === undefined) {
      continue;
    }

    const bucket = routesByHandler.get(edge.targetId);

    if (bucket === undefined) {
      routesByHandler.set(edge.targetId, [route]);
    } else if (!bucket.some((entry) => entry.id === route.id)) {
      bucket.push(route);
    }
  }

  const reusedHandlers: HandlerReuse[] = [];

  for (const [handlerId, handled] of routesByHandler) {
    const declaration = index.nodeById.get(handlerId);

    if (declaration !== undefined && handled.length > 1) {
      reusedHandlers.push({ declaration, routes: handled });
    }
  }

  return {
    routes: routes.length,
    byMethod,
    orphanRoutes: routes.filter((route) => (byRoute.get(route.id) ?? []).length === 0),
    duplicateRegistrations,
    reusedHandlers: reusedHandlers.sort((left, right) =>
      left.declaration.id.localeCompare(right.declaration.id),
    ),
    unresolvedHandlers: (index.unresolvedByType.get('HANDLED_BY') ?? []).length,
    handlersPerRoute: distributionOf(routes.map((route) => (byRoute.get(route.id) ?? []).length)),
  };
}

export function environmentOf(index: GraphIndex): EnvironmentReport {
  const variables = index.nodesByKind.get('EnvironmentVariable') ?? [];
  const reads = index.edgesByType.get('READS') ?? [];

  const readsByVariable = new Map<NodeId, GraphEdge[]>();

  for (const edge of reads) {
    const bucket = readsByVariable.get(edge.targetId);

    if (bucket === undefined) {
      readsByVariable.set(edge.targetId, [edge]);
    } else {
      bucket.push(edge);
    }
  }

  const usage: VariableUsage[] = variables.map((node) => {
    const edges = readsByVariable.get(node.id) ?? [];

    return {
      node,
      reads: edges.length,
      readingDeclarations: new Set(edges.map((edge) => edge.sourceId)).size,
    };
  });

  return {
    variables: variables.length,
    used: [...usage]
      .filter((entry) => entry.reads > 0)
      .sort((left, right) => right.reads - left.reads || left.node.id.localeCompare(right.node.id)),
    neverRead: usage.filter((entry) => entry.reads === 0).map((entry) => entry.node),
    readRepeatedly: usage
      .filter((entry) => entry.reads > 1)
      .sort((left, right) => right.reads - left.reads || left.node.id.localeCompare(right.node.id)),
  };
}

/** Declaration counts per file, used by the metrics section. */
export function declarationsPerFile(index: GraphIndex): readonly number[] {
  const counts = new Map<NodeId, number>(index.files.map((file) => [file.id, 0]));

  for (const declaration of index.declarations) {
    if (declaration.fileId === null) {
      continue;
    }

    counts.set(declaration.fileId, (counts.get(declaration.fileId) ?? 0) + 1);
  }

  return [...counts.values()];
}

/**
 * The `MOST_CONNECTED_LIMIT` highest by one measure.
 *
 * Ordered by the measured count descending, then by identifier ascending so ties never depend on
 * input order. This is ordering by a fact, not ranking by a score: no weighting is applied and
 * nothing is labelled unusual.
 */
function topBy(metrics: readonly NodeMetric[], measure: (entry: NodeMetric) => number): readonly NodeMetric[] {
  return [...metrics]
    .filter((entry) => measure(entry) > 0)
    .sort((left, right) => measure(right) - measure(left) || left.node.id.localeCompare(right.node.id))
    .slice(0, MOST_CONNECTED_LIMIT);
}

function counted(nodes: readonly GraphNode[]): CountedNodes {
  return {
    count: nodes.length,
    nodes: nodes.slice(0, SAMPLE_LIMIT),
    truncated: nodes.length > SAMPLE_LIMIT,
  };
}

function externalUsageOf(index: GraphIndex): readonly import('./types.js').ExternalUsage[] {
  const imports = index.edgesByType.get('IMPORTS') ?? [];
  const byExternal = new Map<NodeId, GraphEdge[]>();

  for (const edge of imports) {
    const target = index.nodeById.get(edge.targetId);

    if (target?.kind !== 'External') {
      continue;
    }

    const bucket = byExternal.get(edge.targetId);

    if (bucket === undefined) {
      byExternal.set(edge.targetId, [edge]);
    } else {
      bucket.push(edge);
    }
  }

  return (index.nodesByKind.get('External') ?? [])
    .map((node) => {
      const edges = byExternal.get(node.id) ?? [];

      return {
        node,
        importingFiles: new Set(edges.map((edge) => edge.sourceId)).size,
        importEdges: edges.length,
      };
    })
    .sort(
      (left, right) =>
        right.importingFiles - left.importingFiles || left.node.id.localeCompare(right.node.id),
    );
}

function endpointCount(edges: readonly GraphEdge[]): number {
  const endpoints = new Set<NodeId>();

  for (const edge of edges) {
    endpoints.add(edge.sourceId);
    endpoints.add(edge.targetId);
  }

  return endpoints.size;
}

function dedupeById(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const seen = new Set<NodeId>();

  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }

    seen.add(node.id);

    return true;
  });
}

