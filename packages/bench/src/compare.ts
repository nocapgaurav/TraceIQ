import type { RelationshipType } from '@traceiq/types';

import type { QualityReport } from './types.js';

/** One relationship type's movement between two reports. */
export interface RelationshipDelta {
  readonly type: RelationshipType;
  readonly baselineBindRate: number | null;
  readonly currentBindRate: number | null;
  /** Percentage points, or `null` when either side never saw the type. */
  readonly bindRatePoints: number | null;
  readonly resolvedDelta: number;
  readonly unresolvedDelta: number;
}

export interface QualityComparison {
  readonly repository: string;
  readonly relationships: readonly RelationshipDelta[];
  /** Percentage points, and the number to watch: external edges cannot inflate it. */
  readonly internalCallBindRatePoints: number | null;
  readonly opaqueImportsDelta: number;
  readonly opaqueCallsDelta: number;
  readonly scanMillisDelta: number;
}

/**
 * Diffs two reports of the same repository.
 *
 * Reports of *different* repositories are rejected rather than diffed: the numbers would
 * subtract cleanly and mean nothing, and a benchmark that silently compares unrelated
 * scans is worse than one that refuses.
 *
 * A relationship absent from one side is still reported, with `null` for the missing bind
 * rate. Losing a relationship type entirely is exactly the regression worth seeing.
 */
export function compareQuality(
  baseline: QualityReport,
  current: QualityReport,
): QualityComparison {
  if (baseline.repository !== current.repository) {
    throw new Error(
      `Cannot compare reports for different repositories: '${baseline.repository}' and '${current.repository}'`,
    );
  }

  const types = new Set<RelationshipType>([
    ...baseline.relationships.map((relationship) => relationship.type),
    ...current.relationships.map((relationship) => relationship.type),
  ]);

  const relationships = [...types].sort().map((type): RelationshipDelta => {
    const before = baseline.relationships.find((relationship) => relationship.type === type);
    const after = current.relationships.find((relationship) => relationship.type === type);

    const baselineBindRate = before?.bindRate ?? null;
    const currentBindRate = after?.bindRate ?? null;

    return {
      type,
      baselineBindRate,
      currentBindRate,
      bindRatePoints:
        baselineBindRate === null || currentBindRate === null
          ? null
          : (currentBindRate - baselineBindRate) * 100,
      resolvedDelta: (after?.resolved ?? 0) - (before?.resolved ?? 0),
      unresolvedDelta: (after?.unresolved ?? 0) - (before?.unresolved ?? 0),
    };
  });

  return {
    repository: baseline.repository,
    relationships,
    internalCallBindRatePoints:
      baseline.internalCallBindRate === null || current.internalCallBindRate === null
        ? null
        : (current.internalCallBindRate - baseline.internalCallBindRate) * 100,
    opaqueImportsDelta: current.importReach.opaque - baseline.importReach.opaque,
    opaqueCallsDelta: current.callReach.opaque - baseline.callReach.opaque,
    scanMillisDelta: current.scanMillis - baseline.scanMillis,
  };
}
