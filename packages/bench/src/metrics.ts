import { meetsDepth, type GraphEdge, type GraphUnresolvedReference, type RepositoryGraphApi } from '@traceiq/graph-api';
import {
  CONFIDENCE_LEVELS,
  RELATIONSHIP_TYPES,
  type ConfidenceLevel,
  type NodeId,
  type RelationshipType,
} from '@traceiq/types';

import type {
  QualityReport,
  ReasonCount,
  RelationshipQuality,
  TargetReach,
  UniversalMeasurement,
} from './types.js';

/** The sentinel every unnameable external collapses to. Mirrors `externalIdentityOf`. */
const OPAQUE_EXTERNAL_ID = 'ext:outside-analysis';

const EXTERNAL_PREFIX = 'ext:';

export interface ScanFacts {
  readonly repository: string;
  readonly repositoryPath: string;
  readonly files: number;
  readonly nodes: number;
  readonly scanMillis: number;
}

/**
 * Counts resolution quality out of a stored graph.
 *
 * Reads through `RepositoryGraphApi` and nothing else: no SQL, no storage type and no
 * analysis package appears here, so the benchmark measures the graph a consumer would
 * actually see rather than intermediate state only the pipeline can reach.
 *
 * **It computes no verdict.** There is no score, no threshold and no pass or fail. Every
 * number is a count or a ratio of counts, because what counts as "good enough" depends on
 * the repository and belongs to whoever reads the report.
 */
export function measureQuality(api: RepositoryGraphApi, facts: ScanFacts): QualityReport {
  const unresolved = api.getUnresolved();
  const unresolvedByType = groupByType(unresolved);

  const relationships: RelationshipQuality[] = [];
  let edgeTotal = 0;

  for (const type of RELATIONSHIP_TYPES) {
    const edges = api.getEdges(type);
    const failures = unresolvedByType.get(type) ?? [];

    edgeTotal += edges.length;

    // A type that never occurred is omitted rather than reported as a zero: eleven
    // empty rows would bury the four that carry the repository.
    if (edges.length === 0 && failures.length === 0) {
      continue;
    }

    relationships.push(qualityOf(type, edges, failures));
  }

  const callReach = reachOf(api.getEdges('CALLS'));
  const unboundCalls = (unresolvedByType.get('CALLS') ?? []).length;
  const attemptedInternal = callReach.internal + unboundCalls;

  return {
    repository: facts.repository,
    repositoryPath: facts.repositoryPath,
    files: facts.files,
    nodes: facts.nodes,
    edges: edgeTotal,
    unresolved: unresolved.length,
    scanMillis: facts.scanMillis,
    relationships,
    importReach: reachOf(api.getEdges('IMPORTS')),
    callReach,
    internalCallBindRate: attemptedInternal === 0 ? null : callReach.internal / attemptedInternal,
    universal: measureUniversal(api),
  };
}

/**
 * Counts the facts that exist for every repository.
 *
 * Read through the same API as everything else. `Manifest` and `Dependency` node counts
 * rather than a separate accessor, because they are ordinary nodes and a benchmark should
 * measure what a consumer can actually see.
 */
function measureUniversal(api: RepositoryGraphApi): UniversalMeasurement {
  const capabilities = api.getCapabilities();

  return {
    languages: capabilities.languages,
    regions: capabilities.regions.length,
    semanticRegions: capabilities.regions.filter((region) => meetsDepth(region.depth, 'semantic'))
      .length,
    manifests: api.getNodes('Manifest').length,
    declaredDependencies: api.getNodes('Dependency').length,
    depth: capabilities.depth,
    isPolyglot: capabilities.isPolyglot,
  };
}

function qualityOf(
  type: RelationshipType,
  edges: readonly GraphEdge[],
  failures: readonly GraphUnresolvedReference[],
): RelationshipQuality {
  const attempted = edges.length + failures.length;

  return {
    type,
    resolved: edges.length,
    unresolved: failures.length,
    bindRate: attempted === 0 ? null : edges.length / attempted,
    byConfidence: countConfidence(edges),
    byReason: countReasons(failures),
  };
}

function countConfidence(edges: readonly GraphEdge[]): Readonly<Record<ConfidenceLevel, number>> {
  const counts = Object.fromEntries(CONFIDENCE_LEVELS.map((level) => [level, 0])) as Record<
    ConfidenceLevel,
    number
  >;

  for (const edge of edges) {
    counts[edge.confidence] += 1;
  }

  return counts;
}

/** Most frequent first; ties broken alphabetically so the ordering is total. */
function countReasons(failures: readonly GraphUnresolvedReference[]): readonly ReasonCount[] {
  const counts = new Map<string, number>();

  for (const failure of failures) {
    counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1);
  }

  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * Partitions edges by what their target *is*, judged from the identifier alone.
 *
 * The identifier scheme is the authority: `ext:` prefixes an external, and the bare
 * sentinel is the one external carrying no name. Reading the target node instead would
 * cost a lookup per edge and answer the same question.
 */
function reachOf(edges: readonly GraphEdge[]): TargetReach {
  let internal = 0;
  let named = 0;
  let opaque = 0;

  for (const edge of edges) {
    if (edge.targetId === OPAQUE_EXTERNAL_ID) {
      opaque += 1;
    } else if (isExternal(edge.targetId)) {
      named += 1;
    } else {
      internal += 1;
    }
  }

  return { internal, named, opaque };
}

function isExternal(id: NodeId): boolean {
  return id.startsWith(EXTERNAL_PREFIX);
}

function groupByType(
  unresolved: readonly GraphUnresolvedReference[],
): ReadonlyMap<RelationshipType, readonly GraphUnresolvedReference[]> {
  const byType = new Map<RelationshipType, GraphUnresolvedReference[]>();

  for (const reference of unresolved) {
    const bucket = byType.get(reference.type);

    if (bucket === undefined) {
      byType.set(reference.type, [reference]);
    } else {
      bucket.push(reference);
    }
  }

  return byType;
}
