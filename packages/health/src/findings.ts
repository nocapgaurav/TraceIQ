import type { GraphEdge, GraphNode } from '@traceiq/graph-api';
import type { NodeId, RelationshipType } from '@traceiq/types';

import type { Derived } from './derived.js';
import { REFERENCE_TYPES, type GraphIndex } from './graph-index.js';
import { MOST_CONNECTED_LIMIT, SAMPLE_LIMIT } from './sections.js';
import { distributionOf } from './statistics.js';
import {
  FINDING_CODES,
  type FindingCategory,
  type FindingCode,
  type HealthFinding,
  type NodeMetric,
  type RoutingReport,
} from './types.js';

/**
 * What each finding code means and what it rests on.
 *
 * `category` groups it, `rests` lists the relationship types whose confidence bounds it — a
 * finding about calls can be no stronger than the call graph — and `evidence` is the fixed
 * provenance sentence. Nothing is composed at runtime.
 */
const FINDING_SPEC: Readonly<
  Record<
    FindingCode,
    {
      readonly category: FindingCategory;
      readonly rests: readonly RelationshipType[];
      readonly evidence: string;
    }
  >
> = {
  'declaration-never-referenced': {
    category: 'DEPENDENCY',
    rests: REFERENCE_TYPES,
    evidence: 'no edge in the graph targets this declaration',
  },
  'exported-declaration-never-imported': {
    category: 'DEPENDENCY',
    rests: ['EXPORTS', 'IMPORTS'],
    evidence: 'the declaration is exported from its file and no IMPORTS edge targets it',
  },
  'declaration-isolated': {
    category: 'DEPENDENCY',
    rests: REFERENCE_TYPES,
    evidence: 'no edge in the graph targets this declaration and none leaves it',
  },
  'file-high-fan-in': {
    category: 'DEPENDENCY',
    rests: REFERENCE_TYPES,
    evidence: 'the file has more distinct dependents than the ninetieth percentile of files in this repository',
  },
  'file-high-fan-out': {
    category: 'DEPENDENCY',
    rests: REFERENCE_TYPES,
    evidence: 'the file depends on more distinct nodes than the ninetieth percentile of files in this repository',
  },
  'declaration-in-dependency-cycle': {
    category: 'CALL_GRAPH',
    rests: ['CALLS'],
    evidence: 'the declarations form a strongly connected component of the call graph',
  },
  'file-in-import-cycle': {
    category: 'DEPENDENCY',
    rests: ['IMPORTS'],
    evidence: 'the files form a strongly connected component of the module dependency graph',
  },
  'route-without-handler': {
    category: 'ROUTING',
    rests: ['HANDLED_BY'],
    evidence: 'the route node has no HANDLED_BY edge',
  },
  'route-registered-twice': {
    category: 'ROUTING',
    rests: ['HANDLED_BY'],
    evidence: 'the route has more than one handler edge at the same position in its chain',
  },
  'environment-variable-never-read': {
    category: 'ENVIRONMENT',
    rests: ['READS'],
    evidence: 'the environment variable node has no READS edge',
  },
  'unresolved-relationships-limit-analysis': {
    category: 'ANALYSIS_QUALITY',
    rests: [],
    evidence: 'references the pipeline could not resolve are absent from the graph, so counts here are lower bounds',
  },
};

export interface FindingInput {
  readonly index: GraphIndex;
  readonly derived: Derived;
  readonly routing: RoutingReport;
}

/**
 * Every fact worth reporting, emitted in the order of `FINDING_CODES`.
 *
 * A code that applies to one node at a time — a cycle, a route, a coupled file — emits one finding
 * per occurrence. A code that applies to many comparable nodes emits **one** finding carrying them
 * all, because five hundred separate "never referenced" findings would bury the rest of the report
 * without saying anything more.
 */
export function findingsOf(input: FindingInput): readonly HealthFinding[] {
  const groups = new Map<FindingCode, HealthFinding[]>();

  for (const code of FINDING_CODES) {
    groups.set(code, []);
  }

  const add = (finding: HealthFinding): void => {
    groups.get(finding.code)?.push(finding);
  };

  for (const finding of unreferencedFindings(input.index)) {
    add(finding);
  }

  for (const finding of coupledFileFindings(input.index, input.derived)) {
    add(finding);
  }

  for (const finding of cycleFindings(input)) {
    add(finding);
  }

  for (const finding of routingFindings(input)) {
    add(finding);
  }

  for (const finding of environmentFindings(input.index)) {
    add(finding);
  }

  const unresolvedCount = input.index.unresolved.length;

  if (unresolvedCount > 0) {
    add(
      finding('unresolved-relationships-limit-analysis', input.index, [], {
        metric: 'unresolvedReferences',
        value: unresolvedCount,
        edges: [],
      }),
    );
  }

  return FINDING_CODES.flatMap((code) => groups.get(code) ?? []);
}

function unreferencedFindings(index: GraphIndex): readonly HealthFinding[] {
  const results: HealthFinding[] = [];

  const unreferenced: GraphNode[] = [];
  const isolated: GraphNode[] = [];
  const exportedNeverImported: GraphNode[] = [];

  const importTargets = new Set<NodeId>(
    (index.edgesByType.get('IMPORTS') ?? []).map((edge) => edge.targetId),
  );

  for (const node of index.declarations) {
    const fanIn = (index.coupling.in.get(node.id) ?? []).length;
    const fanOut = (index.coupling.out.get(node.id) ?? []).length;

    if (fanIn === 0) {
      unreferenced.push(node);
    }

    if (fanIn === 0 && fanOut === 0) {
      isolated.push(node);
    }

    if (node.isExported && !importTargets.has(node.id)) {
      exportedNeverImported.push(node);
    }
  }

  if (unreferenced.length > 0) {
    results.push(
      finding('declaration-never-referenced', index, unreferenced, {
        metric: 'fanIn',
        value: 0,
        edges: [],
      }),
    );
  }

  if (exportedNeverImported.length > 0) {
    results.push(
      finding('exported-declaration-never-imported', index, exportedNeverImported, {
        metric: 'incomingImports',
        value: 0,
        edges: [],
      }),
    );
  }

  if (isolated.length > 0) {
    results.push(
      finding('declaration-isolated', index, isolated, { metric: 'fanIn+fanOut', value: 0, edges: [] }),
    );
  }

  return results;
}

/**
 * Files more connected than this repository's own ninetieth percentile.
 *
 * The threshold is computed from the repository rather than fixed, so "high" is relative to the
 * codebase being analysed and no magic constant decides it. A repository whose files are uniformly
 * connected produces none of these findings, which is the correct answer.
 */
function coupledFileFindings(index: GraphIndex, derived: Derived): readonly HealthFinding[] {
  const metrics = derived.fileMetrics;

  if (metrics.length === 0) {
    return [];
  }

  const fanInThreshold = distributionOf(metrics.map((entry) => entry.fanIn)).p90;
  const fanOutThreshold = distributionOf(metrics.map((entry) => entry.fanOut)).p90;

  return [
    ...highest(index, metrics, 'file-high-fan-in', 'fanIn', fanInThreshold, (entry) => entry.fanIn),
    ...highest(index, metrics, 'file-high-fan-out', 'fanOut', fanOutThreshold, (entry) => entry.fanOut),
  ];
}

function highest(
  index: GraphIndex,
  metrics: readonly NodeMetric[],
  code: FindingCode,
  metric: string,
  threshold: number,
  measure: (entry: NodeMetric) => number,
): readonly HealthFinding[] {
  return [...metrics]
    .filter((entry) => measure(entry) > threshold)
    .sort((left, right) => measure(right) - measure(left) || left.node.id.localeCompare(right.node.id))
    .slice(0, MOST_CONNECTED_LIMIT)
    .map((entry) =>
      finding(code, index, [entry.node], { metric, value: measure(entry), edges: [] }),
    );
}

function cycleFindings(input: FindingInput): readonly HealthFinding[] {
  const { index, derived } = input;

  // Both component sets come from `derived`, so no traversal happens twice.
  const { callCycles, fileCycles } = derived;

  const callEdges = index.edgesByType.get('CALLS') ?? [];
  const importEdges = index.edgesByType.get('IMPORTS') ?? [];

  return [
    ...callCycles.map((component) =>
      finding('declaration-in-dependency-cycle', index, nodesOf(index, component), {
        metric: 'cycleLength',
        value: component.length,
        edges: edgesWithin(callEdges, component),
      }),
    ),
    ...fileCycles.map((component) =>
      finding('file-in-import-cycle', index, nodesOf(index, component), {
        metric: 'cycleLength',
        value: component.length,
        edges: importEdges.filter((edge) => component.includes(edge.sourceId)),
      }),
    ),
  ];
}

function routingFindings(input: FindingInput): readonly HealthFinding[] {
  const { index, routing } = input;

  return [
    ...routing.orphanRoutes.map((route) =>
      finding('route-without-handler', index, [route], { metric: 'handlers', value: 0, edges: [] }),
    ),
    ...routing.duplicateRegistrations.map((duplicate) =>
      finding('route-registered-twice', index, [duplicate.route], {
        metric: 'handlersAtOnePosition',
        value: duplicate.edges.length,
        edges: duplicate.edges,
      }),
    ),
  ];
}

function environmentFindings(index: GraphIndex): readonly HealthFinding[] {
  const readTargets = new Set<NodeId>((index.edgesByType.get('READS') ?? []).map((edge) => edge.targetId));
  const neverRead = (index.nodesByKind.get('EnvironmentVariable') ?? []).filter(
    (node) => !readTargets.has(node.id),
  );

  return neverRead.length === 0
    ? []
    : [finding('environment-variable-never-read', index, neverRead, { metric: 'reads', value: 0, edges: [] })];
}

function finding(
  code: FindingCode,
  index: GraphIndex,
  nodes: readonly GraphNode[],
  evidence: HealthFinding['evidence'],
): HealthFinding {
  const spec = FINDING_SPEC[code];

  return {
    code,
    category: spec.category,
    // A finding over a thousand declarations would otherwise make the report megabytes of node
    // objects. The count stays exact and `truncated` says the list is not the whole set.
    nodes: nodes.slice(0, SAMPLE_LIMIT),
    nodeCount: nodes.length,
    truncated: nodes.length > SAMPLE_LIMIT,
    evidence,
    confidence: index.weakestConfidenceOf(spec.rests),
    provenance: {
      producer: 'health',
      // A finding over many nodes belongs to no single file, so the field is null rather than
      // arbitrarily the first node's.
      fileId: nodes.length === 1 ? (nodes[0]?.fileId ?? null) : null,
      evidence: spec.evidence,
    },
  };
}

function nodesOf(index: GraphIndex, ids: readonly NodeId[]): readonly GraphNode[] {
  return ids.map((id) => index.nodeById.get(id)).filter((node): node is GraphNode => node !== undefined);
}

function edgesWithin(edges: readonly GraphEdge[], component: readonly NodeId[]): readonly GraphEdge[] {
  const members = new Set(component);

  return edges.filter((edge) => members.has(edge.sourceId) && members.has(edge.targetId));
}

