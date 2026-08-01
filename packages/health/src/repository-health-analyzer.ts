import type { NodeId } from '@traceiq/types';

import { deriveFrom, type Derived } from './derived.js';
import { buildGraphIndex, type GraphIndex } from './graph-index.js';
import { LIMITATION_DETAIL } from './limitations.js';
import { findingsOf } from './findings.js';
import {
  MOST_CONNECTED_LIMIT,
  architectureOf,
  callGraphHealthOf,
  declarationsPerFile,
  dependencyHealthOf,
  environmentOf,
  routingOf,
  summaryOf,
} from './sections.js';
import { distributionOf, ratio, round } from './statistics.js';
import {
  LIMITATION_CODES,
  type AnalysisStatistics,
  type HealthFinding,
  type HealthGraph,
  type Limitation,
  type LimitationCode,
  type RepositoryHealthReport,
  type RepositoryMetrics,
} from './types.js';

/**
 * A structured architectural health report for an indexed repository.
 *
 * **One pass over the graph.** `analyze` builds a single index — every node kind, every
 * relationship type, the roles and the unresolved references — and every section is then a
 * function of that index plus a bundle of shared derived values. Nothing touches the graph after
 * the index is built, so no section can re-traverse and every section sees one snapshot.
 *
 * **Nothing is invented.** Every number is a count, a ratio or a percentile of edges and nodes
 * that already exist. There is no AI, no score, no grade, no severity and no recommendation — and
 * deliberately no overall health number, which would be a judgement dressed as a measurement.
 *
 * **No storage and no compiler.** The constructor takes `HealthGraph`, four read operations with
 * no connection, statement or path among them.
 */
export class RepositoryHealthAnalyzer {
  readonly #graph: HealthGraph;

  /**
   * The report, computed at most once.
   *
   * An analyser holds one immutable revision, so a second `analyze()` can only produce what the first
   * did — and it cost 631 ms of it on `facebook/react`, on every question, for a report that had not
   * changed. Construct a new analyser to read a new revision, which is what the graph holder already
   * does when a scan replaces the graph.
   */
  #report: RepositoryHealthReport | null = null;

  constructor(graph: HealthGraph) {
    this.#graph = graph;
  }

  analyze(): RepositoryHealthReport {
    this.#report ??= this.#compute();

    return this.#report;
  }

  #compute(): RepositoryHealthReport {
    const index = buildGraphIndex(this.#graph);
    const derived = deriveFrom(index);

    const summary = summaryOf(index);
    const architecture = architectureOf(index);
    const dependencyHealth = dependencyHealthOf(index, derived);
    const callGraphHealth = callGraphHealthOf(index, derived);
    const routing = routingOf(index);
    const environment = environmentOf(index);
    const findings = findingsOf({ index, derived, routing });
    const metrics = metricsOf(index, derived, callGraphHealth.coverage);

    return {
      summary,
      architecture,
      dependencyHealth,
      callGraphHealth,
      routing,
      environment,
      findings,
      metrics,
      limitations: limitationsFor(index, findings),
      statistics: statisticsOf(index, derived, findings),
    };
  }
}

function metricsOf(index: GraphIndex, derived: Derived, callGraphCoverage: number): RepositoryMetrics {
  const perFile = declarationsPerFile(index);
  const references = derived.declarationMetrics.map((entry) => entry.incomingEdges);
  const nodes = index.nodeById.size;

  return {
    averageDeclarationsPerFile: ratio(index.declarations.length, index.files.length),
    averageReferencesPerDeclaration: ratio(
      references.reduce((sum, value) => sum + value, 0),
      index.declarations.length,
    ),
    // Directed density: edges over the number of ordered pairs. Tiny for any real codebase, which
    // is the point — it says how far the graph is from everything referring to everything.
    graphDensity: nodes < 2 ? 0 : round(index.edgeCount / (nodes * (nodes - 1))),
    callGraphCoverage,
    referenceCoverage: ratio(index.edgeCount, index.edgeCount + index.unresolved.length),
    maxCallDepth: derived.maxCallDepth,
    fanIn: distributionOf(derived.declarationMetrics.map((entry) => entry.fanIn)),
    fanOut: distributionOf(derived.declarationMetrics.map((entry) => entry.fanOut)),
    declarationsPerFile: distributionOf(perFile),
  };
}

/**
 * Which limitations this report carries.
 *
 * `null` marks one that always applies; a number is how many parts of the report it bears on, and
 * zero means it does not apply. Iterating `LIMITATION_CODES` fixes the order, and the exhaustive
 * record means a new code cannot be added without deciding when it fires.
 */
function limitationsFor(index: GraphIndex, findings: readonly HealthFinding[]): readonly Limitation[] {
  const routes = (index.nodesByKind.get('Route') ?? []).length;
  const fileSourcedCalls = (index.edgesByType.get('CALLS') ?? []).filter((edge) =>
    isFile(index, edge.sourceId),
  ).length;

  const capped =
    findings.filter((entry) => entry.truncated).length +
    (index.files.length > MOST_CONNECTED_LIMIT ? 1 : 0);

  const affected: Readonly<Record<LimitationCode, number | null>> = {
    'call-coverage-partial': null,
    'calls-are-inferred': (index.edgesByType.get('CALLS') ?? []).length,
    'no-interface-or-dynamic-dispatch': null,
    'unresolved-relationships-limit-analysis': index.unresolved.length,
    'file-level-attribution': fileSourcedCalls,
    'reference-absence-is-not-proof': null,
    'property-references-not-recorded': (index.nodesByKind.get('Property') ?? []).filter(
      (node) => (index.coupling.in.get(node.id) ?? []).length === 0,
    ).length,
    'duplicate-route-identities-collapse': routes,
    'route-prefixes-not-composed': routes,
    'roles-are-judgements': index.roleAnnotationCount,
    'no-history': null,
    'capped-lists': capped,
  };

  return LIMITATION_CODES.flatMap((code) => {
    const count = affected[code];

    return count === 0 ? [] : [{ code, detail: LIMITATION_DETAIL[code], affected: count }];
  });
}

/**
 * What the analysis cost.
 *
 * `largestTraversal` and `largestCategory` name the biggest piece of work so a caller can see
 * where the time went without profiling. **No timing is recorded**: elapsed milliseconds differ
 * between runs and the report must be byte-identical for identical input.
 */
function statisticsOf(
  index: GraphIndex,
  derived: Derived,
  findings: readonly HealthFinding[],
): AnalysisStatistics {
  const traversals = [
    {
      name: 'call-graph-components',
      nodes: derived.callParticipants.length,
      edges: (index.edgesByType.get('CALLS') ?? []).length,
    },
    {
      name: 'module-dependency-components',
      nodes: [...derived.fileDependencies.out.keys()].length,
      edges: (index.edgesByType.get('IMPORTS') ?? []).length,
    },
    { name: 'coupling-index', nodes: index.nodeById.size, edges: index.edgeCount },
  ];

  const largestTraversal =
    [...traversals].sort(
      (left, right) => right.nodes + right.edges - (left.nodes + left.edges) || left.name.localeCompare(right.name),
    )[0] ?? traversals[0];

  const categories = new Map<string, number>();

  for (const entry of findings) {
    categories.set(entry.code, (categories.get(entry.code) ?? 0) + Math.max(1, entry.nodeCount));
  }

  const largestCategory =
    [...categories.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] ??
    (['none', 0] as const);

  return {
    graphApiCalls: index.graphApiCalls,
    nodesScanned: index.nodeById.size,
    edgesScanned: index.edgeCount,
    unresolvedScanned: index.unresolved.length,
    largestTraversal: largestTraversal ?? { name: 'none', nodes: 0, edges: 0 },
    largestCategory: { name: largestCategory[0], entries: largestCategory[1] },
  };
}

function isFile(index: GraphIndex, id: NodeId): boolean {
  return index.nodeById.get(id)?.kind === 'File';
}
