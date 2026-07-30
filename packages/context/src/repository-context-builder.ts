import type { GraphNode } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import {
  EXPLAIN_LIMIT,
  NO_DEPENDENCIES,
  NO_HEALTH,
  NO_IMPACT,
  NO_REFERENCES,
  fileHealth,
  findingsNaming,
  mergeLimitations,
  relatedNodes,
  routesOf,
} from './builders.js';
import { CountingCapabilities, type ContextCapabilities } from './capabilities.js';
import type {
  ContextPart,
  ContextRequest,
  RelatedNode,
  RepositoryContext,
  RouteResult,
} from './types.js';

/** A request naming something the graph does not hold. */
export class ContextNotFoundError extends Error {
  readonly kind: string;
  readonly subject: string;

  constructor(kind: string, subject: string) {
    super(`no ${kind} named '${subject}'`);
    this.name = 'ContextNotFoundError';
    this.kind = kind;
    this.subject = subject;
  }
}

/**
 * Deterministic repository context, assembled from existing capabilities.
 *
 * The final composition layer. Everything below already knows **how** to analyse; this decides **what
 * belongs together** for a given question, and nothing more.
 *
 * **It cannot traverse, query or read anything.** The constructor takes the capabilities; there is no
 * `RepositoryGraphApi`, no store, no compiler and no filesystem anywhere in this package's surface, so
 * the boundary is enforced by the type rather than by discipline. Every value in a context was produced
 * by a capability and is carried **unchanged**.
 *
 * **Nothing is generated.** No prose, no markdown, no prompt, no summary written in words, no ranking
 * and no score. A list is in the order the capability returned it; a cap takes the first entries of that
 * order rather than choosing which matter.
 *
 * Stateless: one `build` holds no state and caches nothing, so two builds cannot interfere. Whatever
 * caching exists belongs to the capabilities that were passed in.
 */
export class RepositoryContextBuilder {
  readonly #capabilities: ContextCapabilities;

  constructor(capabilities: ContextCapabilities) {
    this.#capabilities = capabilities;
  }

  /**
   * Assembles the context for one request.
   *
   * Throws `ContextNotFoundError` when the request names something the graph does not hold, rather than
   * returning a hollow context — an empty context would read as "nothing is recorded about this" when
   * the truth is "this does not exist".
   */
  build(request: ContextRequest): RepositoryContext {
    // Counted per build, so the statistics report this request's calls rather than a running total.
    const counted = new CountingCapabilities(this.#capabilities);
    const context = this.#assemble(counted, request);

    return {
      ...context,
      statistics: {
        capabilityCalls: counted.snapshot(),
        totalCapabilityCalls: counted.total(),
        relatedNodes: context.related.length,
        explainedNodes: context.related.filter((entry) => entry.explain !== null).length,
        referenceEdges:
          context.references.incomingCalls.length +
          context.references.outgoingCalls.length +
          context.references.references.length +
          context.references.typeReferences.length,
      },
    };
  }

  #assemble(
    capabilities: ContextCapabilities,
    request: ContextRequest,
  ): Omit<RepositoryContext, 'statistics'> {
    switch (request.kind) {
      case 'symbol':
        return symbolContext(capabilities, request.id);

      case 'impact':
        return impactContext(capabilities, request.id);

      case 'file':
        return fileContext(capabilities, request.path);

      case 'package':
        return packageContext(capabilities, request.name);

      case 'route':
        return routeContext(capabilities, request.method, request.path);

      case 'repository':
        return repositoryContext(capabilities);

      case 'search':
        return searchContext(capabilities, request.query);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------------------------

/**
 * Everything about one declaration, plus how it sits in the repository.
 *
 * `browseSymbol` already composes Explain Symbol, an impact summary and a health summary, so calling it
 * once is what makes this two capability calls rather than five. **Impact is carried as counts here on
 * purpose**: `browseSymbol` runs the analyser internally, so asking for the full analysis as well would
 * run it twice for one request. The `impact` kind exists for the whole analysis.
 */
function symbolContext(
  capabilities: ContextCapabilities,
  id: NodeId,
): Omit<RepositoryContext, 'statistics'> {
  const view = capabilities.explorer.browseSymbol(id);

  if (view === null) {
    throw new ContextNotFoundError('declaration', id);
  }

  const explain = view.explain;
  const dependencies = capabilities.explorer.dependencies(id);

  const related = relatedNodes([
    ...enclosingOf(explain),
    ...view.children.entries.map((node) => ({ node, relation: 'child' as const })),
    ...sources(explain.incomingCalls, 'caller'),
    ...targets(explain.outgoingCalls, 'callee'),
    ...sources(explain.typeReferences, 'type-reference'),
  ]);

  return {
    kind: 'symbol',
    primary: { type: 'symbol', value: view },
    related,
    references: {
      incomingCalls: explain.incomingCalls,
      outgoingCalls: explain.outgoingCalls,
      references: explain.references,
      typeReferences: explain.typeReferences,
    },
    dependencies: {
      view: dependencies,
      externalPackages: explain.externalDependencies.map((entry) => entry.node),
      environmentVariables: explain.environmentVariables.map((entry) => entry.node),
      cycles: null,
    },
    impact: { analysis: null, summary: view.impact },
    routes: routesOf(explain.routes.map((entry) => ({ route: entry.explanation.route }))),
    health: { report: null, subject: view.health },
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['impact-summary-only', null],
        ['capped-lists', null],
      ],
      [explain.limitations, dependencies?.limitations ?? []],
    ),
    provenance: {
      producer: 'context',
      parts: [
        part('primary', 'explorer', 'browseSymbol'),
        part('references', 'explain', 'explain (via browseSymbol)'),
        part('impact', 'impact', 'analyze (via browseSymbol)'),
        part('health', 'health', 'analyze (via browseSymbol)'),
        part('dependencies', 'explorer', 'dependencies'),
      ],
      subject: explain.declaration.node.provenance,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------------------------

/**
 * What a change to one declaration could affect, with the affected declarations explained.
 *
 * The first `EXPLAIN_LIMIT` affected nodes are explained, in the depth-major order the analyser already
 * produced. Every affected node is listed; only the explanations are capped, and the count that went
 * unexplained is reported as a limitation rather than left implicit.
 */
function impactContext(
  capabilities: ContextCapabilities,
  id: NodeId,
): Omit<RepositoryContext, 'statistics'> {
  const analysis = capabilities.impact.analyze(id);

  if (analysis === null) {
    throw new ContextNotFoundError('declaration', id);
  }

  const affected = [...analysis.directlyAffected, ...analysis.indirectlyAffected];
  const related = relatedNodes(
    affected.map((entry) => ({ node: entry.node, relation: 'affected' as const, depth: entry.depth })),
    (nodeId) => capabilities.explain.explain(nodeId),
  );

  return {
    kind: 'impact',
    primary: { type: 'impact', value: analysis },
    related,
    references: {
      incomingCalls: analysis.callers,
      outgoingCalls: analysis.callees,
      // Everything referring to the target: the analyser reports calls, type positions and imports
      // separately, and their union is what Explain Symbol calls references.
      references: [...analysis.callers, ...analysis.typeReferences, ...analysis.imports],
      typeReferences: analysis.typeReferences,
    },
    dependencies: {
      view: null,
      externalPackages: analysis.externalDependencies.map((entry) => entry.node),
      environmentVariables: analysis.environmentVariables.map((entry) => entry.node),
      cycles: null,
    },
    impact: {
      analysis,
      summary: {
        directlyAffected: analysis.directlyAffected.length,
        indirectlyAffected: analysis.indirectlyAffected.length,
        unknown: analysis.unknown.length,
        maxDepth: analysis.statistics.maxDepth,
        routesAffected: analysis.routesAffected.length,
      },
    },
    routes: routesOf(analysis.routesAffected),
    health: NO_HEALTH,
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['related-nodes-are-not-all-explained', Math.max(0, affected.length - EXPLAIN_LIMIT)],
        ['capped-lists', null],
      ],
      [analysis.limitations, ...related.flatMap((entry) => (entry.explain === null ? [] : [entry.explain.limitations]))],
    ),
    provenance: {
      producer: 'context',
      parts: [
        part('primary', 'impact', 'analyze'),
        part('related', 'explain', 'explain'),
        part('routes', 'impact', 'analyze'),
      ],
      subject: analysis.target.node.provenance,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------------

function fileContext(
  capabilities: ContextCapabilities,
  path: string,
): Omit<RepositoryContext, 'statistics'> {
  const id = (path.startsWith('file:') ? path : `file:${path}`) as NodeId;
  const view = capabilities.explorer.browseFile(id);

  if (view === null) {
    throw new ContextNotFoundError('file', path);
  }

  const dependencies = capabilities.explorer.dependencies(id);
  const report = capabilities.health.analyze();

  return {
    kind: 'file',
    primary: { type: 'file', value: view },
    related: relatedNodes(
      view.declarations.entries.map((node) => ({ node, relation: 'declaration' as const })),
    ),
    references: {
      incomingCalls: dependencies?.direct.callers.entries ?? [],
      outgoingCalls: dependencies?.direct.callees.entries ?? [],
      references: dependencies?.direct.references.entries ?? [],
      typeReferences: [],
    },
    dependencies: {
      view: dependencies,
      externalPackages: view.externalPackages.entries,
      environmentVariables: view.environmentVariables.entries,
      cycles: null,
    },
    impact: NO_IMPACT,
    routes: view.routes.entries,
    health: {
      report: null,
      subject: fileHealth({
        fanIn: view.statistics.fanIn,
        fanOut: view.statistics.fanOut,
        inCycle: (dependencies?.indirect.cycles.length ?? 0) > 0,
        findings: findingsNaming(report, id),
      }),
    },
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['capped-lists', null],
      ],
      [dependencies?.limitations ?? [], report.limitations],
    ),
    provenance: {
      producer: 'context',
      parts: [
        part('primary', 'explorer', 'browseFile'),
        part('dependencies', 'explorer', 'dependencies'),
        part('health', 'health', 'analyze'),
      ],
      subject: view.file.provenance,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------------------------

function packageContext(
  capabilities: ContextCapabilities,
  name: string,
): Omit<RepositoryContext, 'statistics'> {
  const view = capabilities.explorer.browsePackage(name);

  if (view === null) {
    throw new ContextNotFoundError('package', name);
  }

  const report = capabilities.health.analyze();

  return {
    kind: 'package',
    primary: { type: 'package', value: view },
    related: relatedNodes(view.files.entries.map((node) => ({ node, relation: 'package-file' as const }))),
    // A package is a grouping rather than a node, so it has no calls or references of its own. Its
    // imports and exports are relationships of its files and stay on the package view where they belong.
    references: NO_REFERENCES,
    dependencies: {
      // A package is a derived grouping rather than a node, so it has no single dependency view; its
      // cross-boundary dependencies and dependents are on the package view itself.
      view: null,
      externalPackages: view.externalPackages.entries,
      environmentVariables: [],
      cycles: null,
    },
    impact: NO_IMPACT,
    routes: [],
    health: { report, subject: null },
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['capped-lists', null],
      ],
      [view.limitations, report.limitations],
    ),
    provenance: {
      producer: 'context',
      parts: [part('primary', 'explorer', 'browsePackage'), part('health', 'health', 'analyze')],
      subject: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------------------------

/**
 * One route, its handlers explained, and the impact of changing the handler.
 *
 * `impact.analysis` is the **final handler's**, because that is the route's endpoint; `impact.summary`
 * sums every linked handler, so a chain of three shows all three. Middleware is explained the same way
 * as the handler — both are declarations the route runs.
 */
function routeContext(
  capabilities: ContextCapabilities,
  method: string,
  path: string,
): Omit<RepositoryContext, 'statistics'> {
  const routeId = `route:${method}:${path}` as NodeId;
  const explanation = capabilities.queries.explainRoute(routeId);

  if (explanation === null) {
    throw new ContextNotFoundError('route', `${method} ${path}`);
  }

  const handlers = explanation.route.handlers.flatMap((entry) =>
    entry.declaration === null ? [] : [entry.declaration],
  );

  const related = relatedNodes(
    [
      ...explanation.middleware.flatMap((entry) =>
        entry.declaration === null ? [] : [{ node: entry.declaration, relation: 'middleware' as const }],
      ),
      ...(explanation.handler?.declaration === null || explanation.handler === null
        ? []
        : [{ node: explanation.handler.declaration, relation: 'handler' as const }]),
    ],
    (nodeId) => capabilities.explain.explain(nodeId),
  );

  const analyses = handlers.map((handler) => capabilities.impact.analyze(handler.id));
  const final = explanation.handler?.declaration ?? null;
  const analysis = final === null ? null : (analyses[handlers.findIndex((entry) => entry.id === final.id)] ?? null);

  const explained = related.flatMap((entry) => (entry.explain === null ? [] : [entry.explain]));

  return {
    kind: 'route',
    primary: { type: 'route', value: explanation },
    related,
    references: {
      incomingCalls: explained.flatMap((entry) => entry.incomingCalls),
      outgoingCalls: explained.flatMap((entry) => entry.outgoingCalls),
      references: explained.flatMap((entry) => entry.references),
      typeReferences: explained.flatMap((entry) => entry.typeReferences),
    },
    dependencies: {
      view: null,
      externalPackages: dedupe(explained.flatMap((entry) => entry.externalDependencies.map((item) => item.node))),
      environmentVariables: dedupe(explained.flatMap((entry) => entry.environmentVariables.map((item) => item.node))),
      cycles: null,
    },
    impact: {
      analysis,
      summary: {
        directlyAffected: sum(analyses, (entry) => entry?.directlyAffected.length ?? 0),
        indirectlyAffected: sum(analyses, (entry) => entry?.indirectlyAffected.length ?? 0),
        unknown: sum(analyses, (entry) => entry?.unknown.length ?? 0),
        maxDepth: analyses.reduce((deepest, entry) => Math.max(deepest, entry?.statistics.maxDepth ?? 0), 0),
        routesAffected: dedupe(analyses.flatMap((entry) => entry?.routesAffected.map((item) => item.route.node) ?? []))
          .length,
      },
    },
    routes: [explanation.route],
    health: NO_HEALTH,
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['related-nodes-are-not-all-explained', Math.max(0, related.length - EXPLAIN_LIMIT)],
        ['capped-lists', null],
      ],
      [
        ...explained.map((entry) => entry.limitations),
        ...analyses.flatMap((entry) => (entry === null ? [] : [entry.limitations])),
      ],
    ),
    provenance: {
      producer: 'context',
      parts: [
        part('primary', 'queries', 'explainRoute'),
        part('related', 'explain', 'explain'),
        part('impact', 'impact', 'analyze'),
      ],
      subject: explanation.route.node.provenance,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------

/**
 * The repository as a whole.
 *
 * Four capability results: the overview, the architecture, the hotspots and the health report. The
 * overview internally computes a health summary of its own, so the report is computed twice for this
 * kind — reported as `repository-health-computed-independently` rather than hidden, and harmless because
 * the graph is one immutable revision so both agree.
 */
function repositoryContext(capabilities: ContextCapabilities): Omit<RepositoryContext, 'statistics'> {
  const overview = capabilities.explorer.overview();
  const architecture = capabilities.explorer.architecture();
  const hotspots = capabilities.explorer.hotspots();
  const cycles = capabilities.explorer.cycles();
  const report = capabilities.health.analyze();

  return {
    kind: 'repository',
    primary: { type: 'repository', value: { overview, architecture, hotspots } },
    related: [],
    references: NO_REFERENCES,
    dependencies: {
      view: null,
      externalPackages: architecture.externalPackages.entries,
      environmentVariables: architecture.environmentVariables.entries,
      cycles,
    },
    impact: NO_IMPACT,
    routes: architecture.routes.entries,
    health: { report, subject: null },
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['repository-health-computed-independently', null],
        ['capped-lists', null],
      ],
      [overview.limitations, cycles.limitations, report.limitations],
    ),
    provenance: {
      producer: 'context',
      parts: [
        part('primary.overview', 'explorer', 'overview'),
        part('primary.architecture', 'explorer', 'architecture'),
        part('primary.hotspots', 'explorer', 'hotspots'),
        part('dependencies.cycles', 'explorer', 'cycles'),
        part('health', 'health', 'analyze'),
      ],
      subject: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/**
 * Search results, with the first `EXPLAIN_LIMIT` declarations explained.
 *
 * "First" is alphabetical by identifier — the order the explorer already returned, which is not a
 * ranking. Nothing here scores a result or decides which matters.
 */
function searchContext(
  capabilities: ContextCapabilities,
  query: Parameters<ContextCapabilities['explorer']['search']>[0],
): Omit<RepositoryContext, 'statistics'> {
  const results = capabilities.explorer.search(query);

  const related = relatedNodes(
    [
      ...results.declarations.entries.map((node) => ({ node, relation: 'search-result' as const })),
      ...results.files.entries.map((node) => ({ node, relation: 'search-result' as const })),
    ],
    (nodeId) => capabilities.explain.explain(nodeId),
  );

  const explained = related.flatMap((entry) => (entry.explain === null ? [] : [entry.explain]));

  return {
    kind: 'search',
    primary: { type: 'search', value: results },
    related,
    references: NO_REFERENCES,
    dependencies: NO_DEPENDENCIES,
    impact: NO_IMPACT,
    routes: routesOf(explained.flatMap((entry) => entry.routes.map((item) => ({ route: item.explanation.route })))),
    health: NO_HEALTH,
    limitations: mergeLimitations(
      [
        ['context-is-a-composition', null],
        ['related-nodes-are-not-all-explained', Math.max(0, results.total - EXPLAIN_LIMIT)],
        ['capped-lists', null],
      ],
      explained.map((entry) => entry.limitations),
    ),
    provenance: {
      producer: 'context',
      parts: [part('primary', 'explorer', 'search'), part('related', 'explain', 'explain')],
      subject: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

function part(name: string, capability: string, operation: string): ContextPart {
  return { part: name, capability: `@traceiq/${capability === 'queries' ? 'query' : capability}`, operation };
}

function enclosingOf(explain: {
  readonly enclosingDeclaration: { readonly declaration: GraphNode | null } | null;
}): readonly { readonly node: GraphNode; readonly relation: RelatedNode['relation'] }[] {
  const node = explain.enclosingDeclaration?.declaration ?? null;

  return node === null ? [] : [{ node, relation: 'enclosing' }];
}

function sources(
  entries: readonly { readonly source: GraphNode | null }[],
  relation: RelatedNode['relation'],
): readonly { readonly node: GraphNode; readonly relation: RelatedNode['relation'] }[] {
  return entries.flatMap((entry) => (entry.source === null ? [] : [{ node: entry.source, relation }]));
}

function targets(
  entries: readonly { readonly target: GraphNode | null }[],
  relation: RelatedNode['relation'],
): readonly { readonly node: GraphNode; readonly relation: RelatedNode['relation'] }[] {
  return entries.flatMap((entry) => (entry.target === null ? [] : [{ node: entry.target, relation }]));
}

function dedupe(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const seen = new Map<NodeId, GraphNode>();

  for (const node of nodes) {
    seen.set(node.id, node);
  }

  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sum<T>(entries: readonly T[], measure: (entry: T) => number): number {
  return entries.reduce((total, entry) => total + measure(entry), 0);
}

export type { RouteResult };
