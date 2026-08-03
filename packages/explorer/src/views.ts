import { NODE_KINDS, type GraphEdge, type GraphNode } from '@traceiq/graph-api';
import { metricOf, stronglyConnectedComponents, type RepositoryHealthReport } from '@traceiq/health';
import { ROLES, SYSTEM_ARTIFACT_KINDS } from '@traceiq/types';
import type { NodeId, RelationshipType, Role } from '@traceiq/types';

import { artifactDigestsOf, artifactSummariesOf, artifactViewOf } from './artifacts.js';
import type { ExplorerContext } from './explorer-context.js';
import { packageOfNode } from './explorer-context.js';
import { LIMITATION_DETAIL } from './limitations.js';
import { byDependencyFirst, byId, listing, reachableFrom, reachedNodes } from './listing.js';
import {
  CYCLE_KINDS,
  type ArchitectureSummary,
  type TechnologySummary,
  type ArchitectureView,
  type Cycle,
  type CycleKind,
  type CycleReport,
  type DependencyView,
  type FileView,
  type GraphSummary,
  type HealthSummary,
  type HotspotReport,
  type Limitation,
  type LimitationCode,
  type Listing,
  type PackageEdge,
  type PackageSummary,
  type PackageView,
  type RepositoryOverview,
  type SymbolView,
} from './types.js';

/** Which relationships each cycle kind is asked over. */
const CYCLE_RELATIONSHIPS: Readonly<Record<CycleKind, readonly RelationshipType[]>> = {
  // Import cycles use the module dependency projection, not raw IMPORTS — see `importCycles`.
  import: ['IMPORTS'],
  call: ['CALLS'],
  reference: ['REFERENCES_TYPE'],
  inheritance: ['EXTENDS', 'IMPLEMENTS'],
};

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export function overviewOf(context: ExplorerContext): RepositoryOverview {
  // Every section here is a projection of the health report, which the context builds once. The
  // explorer adds the package view; it recomputes nothing the report already states.
  const health = context.health();

  return {
    repository: health.summary,
    technologies: technologySummariesOf(context),
    artifacts: artifactSummariesOf(context),
    keyArtifacts: listing(artifactDigestsOf(context, SYSTEM_ARTIFACT_KINDS)),
    capabilities: context.graph.getCapabilities(),
    architecture: architectureSummaryOf(health),
    packages: listing(packageSummariesOf(context)),
    graph: graphSummaryOf(health),
    health: healthSummaryOf(health),
    metrics: health.metrics,
    limitations: limitationsOf(context, [
      'package-boundary-is-derived-from-paths',
      'cross-package-imports-resolve-outside-analysis',
      'capped-lists',
    ]),
  };
}

/**
 * The explorer's own limitations, selected by code.
 *
 * `affected` is a count where one is meaningful and `null` where the limitation simply holds. A
 * limitation whose count is zero does not apply and is omitted.
 */
function limitationsOf(context: ExplorerContext, codes: readonly LimitationCode[]): readonly Limitation[] {
  const index = context.index();
  const outsideAnalysis = (index.edgesByType.get('IMPORTS') ?? []).filter(
    (edge) => index.nodeById.get(edge.targetId)?.externalKind === 'outside-analysis',
  ).length;

  const affected: Readonly<Record<LimitationCode, number | null>> = {
    'package-boundary-is-derived-from-paths': null,
    'cross-package-imports-resolve-outside-analysis': outsideAnalysis,
    'call-cycles-may-include-false-self-recursion': context
      .derived()
      .callCycles.filter((component) => component.length === 1).length,
    'connected-component-spans-the-repository': null,
    'capped-lists': null,
  };

  return codes.flatMap((code) => {
    const count = affected[code];

    return count === 0 ? [] : [{ code, detail: LIMITATION_DETAIL[code], affected: count }];
  });
}

function graphSummaryOf(health: RepositoryHealthReport): GraphSummary {
  return {
    nodes: health.summary.graph.nodes,
    edges: health.summary.graph.edges,
    unresolvedReferences: health.summary.graph.unresolvedReferences,
    relationshipCounts: health.architecture.relationshipCounts,
    nodesByKind: health.summary.nodesByKind,
  };
}

/**
 * The technologies, read back out of the graph rather than recomputed.
 *
 * The graph is the record. Recomputing from the inventory here would be a second derivation of the
 * same fact, free to disagree with what search returns for the same query — and a reader who finds
 * "Next.js" on the Overview and not in search has been shown a product with two answers.
 */
function technologySummariesOf(context: ExplorerContext): readonly TechnologySummary[] {
  return context.graph
    .getNodes('Technology')
    .map((node) => ({
      id: node.externalName ?? node.name,
      name: node.name,
      category: node.category ?? 'unknown',
      regionPath: node.containerChain ?? '',
      confidence: node.confidence,
      evidence: node.provenance.evidence,
    }))
    .sort((a, b) => a.regionPath.localeCompare(b.regionPath) || a.name.localeCompare(b.name));
}

function architectureSummaryOf(health: RepositoryHealthReport): ArchitectureSummary {
  return {
    roleCounts: health.architecture.roleCounts,
    routes: health.routing.routes,
    environmentVariables: health.environment.variables,
    externalPackages: health.summary.externalPackages,
    dependencyGraph: health.architecture.dependencyGraph,
    callGraph: health.architecture.callGraph,
  };
}

function healthSummaryOf(health: RepositoryHealthReport): HealthSummary {
  const findingCounts: Record<string, number> = {};

  for (const finding of health.findings) {
    findingCounts[finding.code] = (findingCounts[finding.code] ?? 0) + finding.nodeCount;
  }

  return {
    callGraphCoverage: health.metrics.callGraphCoverage,
    referenceCoverage: health.metrics.referenceCoverage,
    maxCallDepth: health.metrics.maxCallDepth,
    declarationsInCycles: health.callGraphHealth.declarationsInCycles,
    isolatedDeclarations: health.dependencyHealth.isolated.count,
    findingCounts,
    limitationCodes: health.limitations.map((entry) => entry.code),
  };
}

export function packageSummariesOf(context: ExplorerContext): readonly PackageSummary[] {
  const packages = context.packages();

  return packages.names.map((name) => {
    const dependencies = new Set(packages.crossingEdges.get(name)?.keys() ?? []);
    const dependents = new Set<string>();

    for (const [from, outward] of packages.crossingEdges) {
      if (outward.has(name)) {
        dependents.add(from);
      }
    }

    return {
      name,
      files: (packages.filesByPackage.get(name) ?? []).length,
      declarations: (packages.declarationsByPackage.get(name) ?? []).length,
      dependencies: dependencies.size,
      dependents: dependents.size,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export function fileViewOf(context: ExplorerContext, id: NodeId): FileView | null {
  const file = context.node(id);

  if (file === null || file.kind !== 'File') {
    return null;
  }

  const index = context.index();

  const declarations = byId(index.declarations.filter((entry) => entry.fileId === id));
  const outgoing = context.graph.getOutgoing(id);
  const incoming = context.graph.getIncoming(id);

  const importEdges = outgoing.filter((edge) => edge.type === 'IMPORTS');
  const exportEdges = outgoing.filter((edge) => edge.type === 'EXPORTS');

  const externals = byId(
    dedupe(
      importEdges
        .map((edge) => index.nodeById.get(edge.targetId))
        .filter((node): node is GraphNode => node?.kind === 'External'),
    ),
  );

  // Routes whose chain reaches a declaration in this file, or which were registered here.
  const declarationIds = new Set(declarations.map((entry) => entry.id));
  const routes = context
    .query((queries) => queries.findRoutes())
    .filter(
      (route) =>
        route.node.fileId === id ||
        route.handlers.some((handler) => handler.declaration !== null && declarationIds.has(handler.declaration.id)),
    );

  const environmentVariables = byId(
    dedupe(
      (index.edgesByType.get('READS') ?? [])
        .filter((edge) => edge.sourceId === id || declarationIds.has(edge.sourceId))
        .map((edge) => index.nodeById.get(edge.targetId))
        .filter((node): node is GraphNode => node !== undefined),
    ),
  );

  const metric = metricOf(index, file);
  const declarationsByKind: Record<string, number> = {};

  for (const declaration of declarations) {
    declarationsByKind[declaration.kind] = (declarationsByKind[declaration.kind] ?? 0) + 1;
  }

  return {
    file,
    packageName: packageOfNode(file) ?? '',
    // Assembled before the declaration listing is rendered, so a file with no declarations still arrives
    // at a consumer with something to show. `null` for source, whose structure the analysers own.
    artifact: artifactViewOf(context, file),
    declarations: listing(declarations),
    imports: listing(importEdges.map((edge) => hydrateTarget(context, edge))),
    exports: listing(exportEdges.map((edge) => hydrateTarget(context, edge))),
    externalPackages: listing(byDependencyFirst(externals)),
    routes: listing(routes),
    environmentVariables: listing(environmentVariables),
    outgoingRelationships: listing(outgoing),
    incomingRelationships: listing(incoming),
    statistics: {
      declarations: declarations.length,
      imports: importEdges.length,
      exports: exportEdges.length,
      outgoingEdges: outgoing.length,
      incomingEdges: incoming.length,
      fanIn: metric.fanIn,
      fanOut: metric.fanOut,
      declarationsByKind,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------------------------

export function symbolViewOf(context: ExplorerContext, id: NodeId): SymbolView | null {
  // Explain Symbol owns the assembly. Nothing here re-derives what it already returns.
  const explain = context.explainer.explain(id);

  if (explain === null) {
    return null;
  }

  const impact = context.impact.analyze(id);
  const index = context.index();
  const derived = context.derived();
  const health = context.health();

  const children = byId(
    context.graph
      .getOutgoing(id, 'DECLARES')
      .map((edge) => index.nodeById.get(edge.targetId))
      .filter((node): node is GraphNode => node !== undefined),
  );

  const metric = metricOf(index, explain.declaration.node);
  const inCycle = derived.callCycles.some((component) => component.includes(id));
  const recursive = health.callGraphHealth.recursive.nodes.some((node) => node.id === id);

  return {
    explain,
    children: listing(children),
    impact: {
      directlyAffected: impact?.directlyAffected.length ?? 0,
      indirectlyAffected: impact?.indirectlyAffected.length ?? 0,
      unknown: impact?.unknown.length ?? 0,
      maxDepth: impact?.statistics.maxDepth ?? 0,
      routesAffected: impact?.routesAffected.length ?? 0,
    },
    health: {
      fanIn: metric.fanIn,
      fanOut: metric.fanOut,
      incomingEdges: metric.incomingEdges,
      outgoingEdges: metric.outgoingEdges,
      isolated: metric.fanIn === 0 && metric.fanOut === 0,
      inCycle,
      recursive,
      findings: health.findings
        .filter((finding) => finding.nodes.some((node) => node.id === id))
        .map((finding) => finding.code),
    },
    packageName: packageOfNode(explain.declaration.node),
  };
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

export function packageViewOf(context: ExplorerContext, name: string): PackageView | null {
  const packages = context.packages();
  const files = packages.filesByPackage.get(name);

  if (files === undefined) {
    return null;
  }

  const index = context.index();
  const declarations = packages.declarationsByPackage.get(name) ?? [];
  const fileIds = new Set(files.map((file) => file.id));

  const dependencies: PackageEdge[] = [...(packages.crossingEdges.get(name) ?? [])].map(
    ([to, edges]) => ({ name: to, edges: listing(edges) }),
  );
  const dependents: PackageEdge[] = [];

  for (const [from, outward] of packages.crossingEdges) {
    const edges = outward.get(name);

    if (edges !== undefined) {
      dependents.push({ name: from, edges: listing(edges) });
    }
  }

  const imports = (index.edgesByType.get('IMPORTS') ?? []).filter((edge) => fileIds.has(edge.sourceId));
  const exports = (index.edgesByType.get('EXPORTS') ?? []).filter((edge) => fileIds.has(edge.sourceId));

  const externals = byId(
    dedupe(
      imports
        .map((edge) => index.nodeById.get(edge.targetId))
        .filter((node): node is GraphNode => node?.kind === 'External'),
    ),
  );

  const roles = Object.fromEntries(
    ROLES.map((role) => [
      role,
      byId((index.nodesByRole.get(role) ?? []).filter((node) => node.fileId !== null && fileIds.has(node.fileId))),
    ]),
  ) as PackageView['roles'];

  const declarationsByKind: Record<string, number> = {};

  for (const declaration of declarations) {
    declarationsByKind[declaration.kind] = (declarationsByKind[declaration.kind] ?? 0) + 1;
  }

  return {
    name,
    files: listing(byId(files)),
    dependencies: listing(dependencies.sort((left, right) => left.name.localeCompare(right.name))),
    dependents: listing(dependents.sort((left, right) => left.name.localeCompare(right.name))),
    exports: listing(exports.map((edge) => hydrateTarget(context, edge))),
    imports: listing(imports.map((edge) => hydrateTarget(context, edge))),
    externalPackages: listing(byDependencyFirst(externals)),
    roles,
    statistics: { files: files.length, declarations: declarations.length, declarationsByKind },
    limitations: limitationsOf(context, [
      'package-boundary-is-derived-from-paths',
      'cross-package-imports-resolve-outside-analysis',
      'capped-lists',
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Dependency explorer
// ---------------------------------------------------------------------------------------------

export function dependencyViewOf(context: ExplorerContext, id: NodeId): DependencyView | null {
  const subject = context.node(id);

  if (subject === null) {
    return null;
  }

  const outgoing = context.graph.getOutgoing(id);
  const references = context.query((queries) => queries.findReferences(id));
  const callees = context.query((queries) => queries.findCallees(id));
  const callers = context.query((queries) => queries.findCallers(id));

  // Forward reach follows coupling in the direction the subject depends. Reverse reach is Impact
  // Analysis's dependents closure, reused rather than rewalked.
  const coupling = context.index().coupling;
  const forwardDepths = reachableFrom(coupling, id);
  const forward = reachedNodes(forwardDepths, (nodeId) => context.node(nodeId));

  const impact = context.impact.analyze(id);
  const reverse = impact === null
    ? reachedNodes(reachableFrom({ out: coupling.in, in: coupling.out }, id), (nodeId) => context.node(nodeId))
    : [...impact.directlyAffected, ...impact.indirectlyAffected]
        .map((entry) => ({ node: entry.node, depth: entry.depth }))
        .sort((left, right) => left.depth - right.depth || left.node.id.localeCompare(right.node.id));

  const cycles = cyclesContaining(context, id);
  const component = componentContaining(coupling, id, (nodeId) => context.node(nodeId));

  return {
    subject,
    direct: {
      imports: listing(outgoing.filter((edge) => edge.type === 'IMPORTS').map((edge) => hydrateTarget(context, edge))),
      exports: listing(outgoing.filter((edge) => edge.type === 'EXPORTS').map((edge) => hydrateTarget(context, edge))),
      references: listing(references),
      callees: listing(callees),
      callers: listing(callers),
    },
    indirect: {
      forward: listing(forward),
      reverse: listing(reverse),
      forwardDepth: forward.reduce((deepest, entry) => Math.max(deepest, entry.depth), 0),
      reverseDepth: reverse.reduce((deepest, entry) => Math.max(deepest, entry.depth), 0),
      cycles,
      connectedComponent: listing(component),
    },
    limitations: limitationsOf(context, [
      'connected-component-spans-the-repository',
      'call-cycles-may-include-false-self-recursion',
      'capped-lists',
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Architecture explorer
// ---------------------------------------------------------------------------------------------

export function architectureViewOf(context: ExplorerContext): ArchitectureView {
  const index = context.index();
  const byRole = (role: Role): Listing<GraphNode> => listing(byId(index.nodesByRole.get(role) ?? []));
  const byKind = (kind: (typeof NODE_KINDS)[number]): Listing<GraphNode> =>
    listing(index.nodesByKind.get(kind) ?? []);

  return {
    controllers: byRole('Controller'),
    services: byRole('Service'),
    repositories: byRole('Repository'),
    middleware: byRole('Middleware'),
    models: byRole('Model'),
    tests: byRole('Test'),
    routes: listing(context.query((queries) => queries.findRoutes())),
    environmentVariables: byKind('EnvironmentVariable'),
    externalPackages: listing(byDependencyFirst(index.nodesByKind.get('External') ?? [])),
    classes: byKind('Class'),
    interfaces: byKind('Interface'),
    functions: byKind('Function'),
    methods: byKind('Method'),
    variables: byKind('Variable'),
    namespaces: byKind('Namespace'),
  };
}

// ---------------------------------------------------------------------------------------------
// Cycle explorer
// ---------------------------------------------------------------------------------------------

export function cycleReportOf(context: ExplorerContext): CycleReport {
  const importCycles = cyclesOf(context, 'import');
  const callCycles = cyclesOf(context, 'call');
  const referenceCycles = cyclesOf(context, 'reference');
  const inheritanceCycles = cyclesOf(context, 'inheritance');

  const all = [...importCycles, ...callCycles, ...referenceCycles, ...inheritanceCycles];
  const largest =
    [...all].sort(
      (left, right) =>
        right.nodes.length - left.nodes.length ||
        (left.nodes[0]?.id ?? '').localeCompare(right.nodes[0]?.id ?? ''),
    )[0] ?? null;

  return {
    importCycles: listing(importCycles),
    callCycles: listing(callCycles),
    referenceCycles: listing(referenceCycles),
    inheritanceCycles: listing(inheritanceCycles),
    totals: Object.fromEntries(
      CYCLE_KINDS.map((kind) => [
        kind,
        { import: importCycles, call: callCycles, reference: referenceCycles, inheritance: inheritanceCycles }[kind]
          .length,
      ]),
    ) as CycleReport['totals'],
    largest,
    limitations: limitationsOf(context, ['call-cycles-may-include-false-self-recursion', 'capped-lists']),
  };
}

export function cyclesOf(context: ExplorerContext, kind: CycleKind): readonly Cycle[] {
  const types = CYCLE_RELATIONSHIPS[kind];
  const index = context.index();

  // Import cycles are asked over the module dependency projection, which Repository Health already
  // derives: IMPORTS targets a declaration far more often than a file, so a file-level cycle is
  // almost never a File → File edge.
  const adjacency = kind === 'import' ? context.derived().fileDependencies : context.adjacencyOf(types);
  const components =
    kind === 'call'
      ? context.derived().callCycles
      : stronglyConnectedComponents(adjacency, orderedParticipants(adjacency));

  const edges = types.flatMap((type) => index.edgesByType.get(type) ?? []);

  return components.map((component) => {
    const members = new Set(component);

    return {
      kind,
      relationshipTypes: types,
      nodes: component
        .map((id) => index.nodeById.get(id))
        .filter((node): node is GraphNode => node !== undefined),
      edges: listing(
        edges.filter((edge) => members.has(edge.sourceId) && withinComponent(index, members, edge)),
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------------------------

export function hotspotReportOf(context: ExplorerContext): HotspotReport {
  const health = context.health();
  const derived = context.derived();

  const declarationMetrics = derived.declarationMetrics;
  const fileMetrics = derived.fileMetrics;

  const largestComponent =
    [...cyclesOf(context, 'call'), ...cyclesOf(context, 'import'), ...cyclesOf(context, 'reference')].sort(
      (left, right) =>
        right.nodes.length - left.nodes.length ||
        (left.nodes[0]?.id ?? '').localeCompare(right.nodes[0]?.id ?? ''),
    )[0] ?? null;

  return {
    mostReferenced: listing(health.dependencyHealth.mostReferenced),
    mostCoupled: listing(topBy(declarationMetrics, (entry) => entry.fanIn + entry.fanOut)),
    largestFanIn: listing(topBy(declarationMetrics, (entry) => entry.fanIn)),
    largestFanOut: listing(topBy(declarationMetrics, (entry) => entry.fanOut)),
    mostConnectedFiles: listing(topBy(fileMetrics, (entry) => entry.incomingEdges + entry.outgoingEdges)),
    mostConnectedDeclarations: listing(
      topBy(declarationMetrics, (entry) => entry.incomingEdges + entry.outgoingEdges),
    ),
    largestStronglyConnectedComponent: largestComponent,
    fanIn: health.metrics.fanIn,
    fanOut: health.metrics.fanOut,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function cyclesContaining(context: ExplorerContext, id: NodeId): readonly Cycle[] {
  return CYCLE_KINDS.flatMap((kind) =>
    cyclesOf(context, kind).filter((cycle) => cycle.nodes.some((node) => node.id === id)),
  );
}

function componentContaining(
  adjacency: { out: ReadonlyMap<NodeId, readonly NodeId[]>; in: ReadonlyMap<NodeId, readonly NodeId[]> },
  id: NodeId,
  resolve: (id: NodeId) => GraphNode | null,
): readonly GraphNode[] {
  const seen = new Set<NodeId>([id]);
  const queue: NodeId[] = [id];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];

    if (current === undefined) {
      continue;
    }

    for (const neighbour of [...(adjacency.out.get(current) ?? []), ...(adjacency.in.get(current) ?? [])]) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
  }

  return byId(
    [...seen].map((member) => resolve(member)).filter((node): node is GraphNode => node !== null),
  );
}

function topBy<T>(entries: readonly T[], measure: (entry: T) => number): readonly T[] {
  return [...entries].filter((entry) => measure(entry) > 0).sort((left, right) => measure(right) - measure(left));
}

function hydrateTarget(context: ExplorerContext, edge: GraphEdge): { readonly edge: GraphEdge; readonly target: GraphNode | null } {
  return { edge, target: context.node(edge.targetId) };
}

function dedupe(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const seen = new Set<NodeId>();

  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }

    seen.add(node.id);

    return true;
  });
}

function orderedParticipants(adjacency: {
  out: ReadonlyMap<NodeId, readonly NodeId[]>;
  in: ReadonlyMap<NodeId, readonly NodeId[]>;
}): readonly NodeId[] {
  return [...new Set([...adjacency.out.keys(), ...adjacency.in.keys()])].sort();
}

/** Whether an edge's far end is inside the component, following the module projection for files. */
function withinComponent(
  index: ReturnType<ExplorerContext['index']>,
  members: ReadonlySet<NodeId>,
  edge: GraphEdge,
): boolean {
  if (members.has(edge.targetId)) {
    return true;
  }

  const target = index.nodeById.get(edge.targetId);
  const targetFile = target === undefined ? null : target.kind === 'File' ? target.id : target.fileId;

  return targetFile !== null && members.has(targetFile);
}
