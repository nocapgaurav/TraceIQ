/**
 * How much TraceIQ trusts a relationship it inferred.
 *
 * These four values are fixed by the engineering contract. Numeric confidence
 * scores are not permitted: they invite false precision that cannot be
 * calibrated, and they are not comparable across extractors.
 *
 * CERTAIN    Syntactically proven. A class declares a method; a class extends
 *            a class. No inference took place.
 * RESOLVED   The TypeScript type checker bound the reference unambiguously.
 * INFERRED   A heuristic produced exactly one plausible candidate.
 * AMBIGUOUS  Several candidates are plausible and all of them are recorded.
 */
export const CONFIDENCE_LEVELS = ['CERTAIN', 'RESOLVED', 'INFERRED', 'AMBIGUOUS'] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
