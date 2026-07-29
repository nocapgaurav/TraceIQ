import type { SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel } from '@traceiq/types';

/** Descending trust, spec §6. Used only where a shared node must pick one. */
const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = [
  'CERTAIN',
  'RESOLVED',
  'INFERRED',
  'AMBIGUOUS',
];

/**
 * Spec §5.4. Deterministic, so the same sources always produce the same identity.
 *
 * The reference site is part of it because two references from one source to one target
 * at different positions are two distinct facts. The target is part of it so that the
 * candidates of an ambiguous reference — which share everything else — do not collide.
 * No constituent field may contain the `|` separator.
 */
export function edgeIdentity(
  type: string,
  sourceId: string,
  targetId: string,
  name: string | null,
  provenanceFileId: string,
  location: SourceRange,
): string {
  return [
    `edge:${type}`,
    sourceId,
    targetId,
    name ?? '',
    provenanceFileId,
    `${location.startLine}:${location.startColumn}`,
  ].join('|');
}

/** The stronger of two levels under the ordering above. Order-independent. */
export function strongerConfidence(
  left: ConfidenceLevel,
  right: ConfidenceLevel,
): ConfidenceLevel {
  return CONFIDENCE_ORDER.indexOf(left) <= CONFIDENCE_ORDER.indexOf(right) ? left : right;
}
