import { listing } from '@traceiq/explorer';
import type { Cycle, DependencyView, ReachedNode } from '@traceiq/explorer';
import type { GraphEdge, GraphNode } from '@traceiq/graph-api';
import type { NodeId, RelationshipType } from '@traceiq/types';

import { limitationsOf, treeRef, type NavigationContext } from './navigation-context.js';
import { routeIdOf } from './route-explanation.js';
import type {
  DependencyHealthSummary,
  DependencyNavigation,
  DependencySubject,
  DependencySubjectRef,
  ReachedRef,
  RelationshipGraph,
  SubjectKind,
  TreeRef,
} from './types.js';

/**
 * Dependency navigation for a package, a file, a declaration or a route.
 *
 * Repository Explorer's `dependencies` already answers this for **one node**: direct relationships,
 * both closures, cycles and the connected component. Navigation adds the two things it does not do —
 * accepting a subject that is not a single node, and separating the import, reference and call graphs
 * — and merges per-node answers rather than re-walking the graph.
 */
export function dependencyNavigationOf(
  context: NavigationContext,
  subject: DependencySubject,
): DependencyNavigation | null {
  const resolved = resolveSubject(context, subject);

  if (resolved === null) {
    return null;
  }

  const views = resolved.nodes.map((node) =>
    context.explore((explorer) => explorer.dependencies(node.id)),
  );

  const present = views.filter((view): view is DependencyView => view !== null);

  const closure = mergeReached(present.flatMap((view) => view.indirect.forward.entries));
  const reverseClosure = mergeReached(present.flatMap((view) => view.indirect.reverse.entries));

  const directDependencies = mergeRefs(
    present.flatMap((view) => [
      ...view.direct.imports.entries.flatMap((entry) => (entry.target === null ? [] : [entry.target])),
      ...view.direct.callees.entries.flatMap((entry) => (entry.target === null ? [] : [entry.target])),
    ]),
  );

  const reverseDependencies = mergeRefs(
    present.flatMap((view) => [
      ...view.direct.callers.entries.flatMap((entry) => (entry.source === null ? [] : [entry.source])),
      ...view.direct.references.entries.flatMap((entry) => (entry.source === null ? [] : [entry.source])),
    ]),
  );

  const cycles = dedupeCycles(present.flatMap((view) => view.indirect.cycles));
  const component = mergeNodes(present.flatMap((view) => view.indirect.connectedComponent.entries));

  const declarations = resolved.nodes.filter((node) => node.kind !== 'File' && node.kind !== 'Route');
  const symbolViews = declarations.map((node) =>
    context.explore((explorer) => explorer.browseSymbol(node.id)),
  );

  return {
    subject: resolved.ref,
    directDependencies: listing(directDependencies),
    reverseDependencies: listing(reverseDependencies),
    importGraph: relationshipGraph(context, resolved.nodes, 'IMPORTS'),
    referenceGraph: relationshipGraph(context, resolved.nodes, 'REFERENCES_TYPE'),
    callGraph: relationshipGraph(context, resolved.nodes, 'CALLS'),
    closure: listing(closure),
    reverseClosure: listing(reverseClosure),
    cycles,
    connectedComponent: listing(component),
    impact: {
      directlyAffected: sum(symbolViews, (view) => view?.impact.directlyAffected ?? 0),
      indirectlyAffected: sum(symbolViews, (view) => view?.impact.indirectlyAffected ?? 0),
      unknown: sum(symbolViews, (view) => view?.impact.unknown ?? 0),
      maxDepth: symbolViews.reduce((deepest, view) => Math.max(deepest, view?.impact.maxDepth ?? 0), 0),
    },
    health: healthOf(context, resolved.nodes, symbolViews),
    limitations: limitationsOf(
      [
        'call-coverage-partial',
        'package-boundary-is-derived-from-paths',
        'cross-package-imports-resolve-outside-analysis',
        'capped-lists',
      ],
      { 'package-boundary-is-derived-from-paths': resolved.ref.kind === 'package' ? null : 0 },
    ),
  };
}

interface ResolvedSubject {
  readonly ref: DependencySubjectRef;
  /** The nodes the subject covers: one for a node, its files for a package, its handlers for a route. */
  readonly nodes: readonly GraphNode[];
}

/**
 * What a subject covers.
 *
 * A **package** covers its files, since a package is a derived grouping rather than a node. A
 * **route** covers its linked handlers, because a route has no dependencies of its own — what it
 * depends on is what its chain depends on. A file and a declaration cover themselves.
 */
function resolveSubject(context: NavigationContext, subject: DependencySubject): ResolvedSubject | null {
  if (typeof subject === 'object') {
    const view = context.explore((explorer) => explorer.browsePackage(subject.package));

    if (view === null) {
      return null;
    }

    return {
      ref: {
        kind: 'package',
        id: null,
        name: subject.package,
        files: listing(view.files.entries.map(treeRef)),
      },
      nodes: view.files.entries,
    };
  }

  const id = routeIdOf(subject);
  const node = context.node(id);

  if (node === null) {
    return null;
  }

  if (node.kind === 'Route') {
    const explanation = context.query((queries) => queries.explainRoute(node.id));
    const handlers = (explanation?.route.handlers ?? [])
      .map((entry) => entry.declaration)
      .filter((entry): entry is GraphNode => entry !== null);

    return {
      ref: {
        kind: 'route',
        id: node.id,
        name: node.name,
        files: listing(filesOf(context, handlers)),
      },
      nodes: handlers,
    };
  }

  const kind: SubjectKind = node.kind === 'File' ? 'file' : 'declaration';

  return {
    ref: { kind, id: node.id, name: node.name, files: listing(filesOf(context, [node])) },
    nodes: [node],
  };
}

/** Edges of one relationship type around the subject, in both directions. */
function relationshipGraph(
  context: NavigationContext,
  nodes: readonly GraphNode[],
  type: RelationshipType,
): RelationshipGraph {
  const outgoing = new Map<string, GraphEdge>();
  const incoming = new Map<string, GraphEdge>();

  for (const node of nodes) {
    for (const edge of context.graph.getOutgoing(node.id, type)) {
      outgoing.set(edge.id, edge);
    }

    for (const edge of context.graph.getIncoming(node.id, type)) {
      incoming.set(edge.id, edge);
    }
  }

  return {
    outgoing: listing(sortEdges(outgoing)),
    incoming: listing(sortEdges(incoming)),
  };
}

function healthOf(
  context: NavigationContext,
  nodes: readonly GraphNode[],
  views: readonly (ReturnType<NavigationContext['explorer']['browseSymbol']> | null)[],
): DependencyHealthSummary {
  const findings = new Set<string>();

  for (const view of views) {
    for (const code of view?.health.findings ?? []) {
      findings.add(code);
    }
  }

  // A file has no symbol view, so its coupling comes from the file view instead.
  const fileMetrics = nodes
    .filter((node) => node.kind === 'File')
    .map((node) => context.explore((explorer) => explorer.browseFile(node.id))?.statistics);

  const fanIn =
    sum(views, (view) => view?.health.fanIn ?? 0) + sum(fileMetrics, (entry) => entry?.fanIn ?? 0);
  const fanOut =
    sum(views, (view) => view?.health.fanOut ?? 0) + sum(fileMetrics, (entry) => entry?.fanOut ?? 0);

  return {
    fanIn,
    fanOut,
    isolated: fanIn === 0 && fanOut === 0,
    inCycle: views.some((view) => view?.health.inCycle === true),
    findings: [...findings].sort(),
  };
}

function filesOf(context: NavigationContext, nodes: readonly GraphNode[]): readonly TreeRef[] {
  const seen = new Map<NodeId, TreeRef>();

  for (const node of nodes) {
    const fileId = node.kind === 'File' ? node.id : node.fileId;
    const file = fileId === null ? null : context.node(fileId);

    if (file !== null) {
      seen.set(file.id, treeRef(file));
    }
  }

  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Shortest depth wins wherever two subjects reach the same node. */
function mergeReached(entries: readonly ReachedNode[]): readonly ReachedNode[] {
  const shortest = new Map<NodeId, ReachedNode>();

  for (const entry of entries) {
    const existing = shortest.get(entry.node.id);

    if (existing === undefined || entry.depth < existing.depth) {
      shortest.set(entry.node.id, entry);
    }
  }

  return [...shortest.values()].sort(
    (left, right) => left.depth - right.depth || left.node.id.localeCompare(right.node.id),
  );
}

function mergeRefs(nodes: readonly GraphNode[]): readonly ReachedRef[] {
  const seen = new Map<NodeId, ReachedRef>();

  for (const node of nodes) {
    seen.set(node.id, { ref: treeRef(node), depth: 1 });
  }

  return [...seen.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
}

function mergeNodes(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const seen = new Map<NodeId, GraphNode>();

  for (const node of nodes) {
    seen.set(node.id, node);
  }

  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** A cycle is identified by its members, so two subjects inside one cycle report it once. */
function dedupeCycles(cycles: readonly Cycle[]): readonly Cycle[] {
  const seen = new Map<string, Cycle>();

  for (const cycle of cycles) {
    seen.set(`${cycle.kind}|${cycle.nodes.map((node) => node.id).join(',')}`, cycle);
  }

  return [...seen.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([, cycle]) => cycle);
}

function sortEdges(edges: Map<string, GraphEdge>): readonly GraphEdge[] {
  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sum<T>(entries: readonly T[], measure: (entry: T) => number): number {
  return entries.reduce((total, entry) => total + measure(entry), 0);
}
