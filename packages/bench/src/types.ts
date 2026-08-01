import type { AnalysisDepth, LanguageFileCount } from '@traceiq/graph-api';
import type { ConfidenceLevel, RelationshipType } from '@traceiq/types';

/**
 * The benchmark's output vocabulary.
 *
 * Every number here is counted from a stored graph through `RepositoryGraphApi`.
 * Nothing is sampled, estimated or averaged across repositories: a report describes
 * one scan of one repository, and comparing two reports is the caller's business.
 */

/** How often one unresolved reason occurred, for one relationship type. */
export interface ReasonCount {
  readonly reason: string;
  readonly count: number;
}

/**
 * Resolution quality for a single relationship type.
 *
 * `resolved` and `unresolved` partition every *reference of that type the analysis
 * attempted*. A reference the engine never even tried to record appears in neither,
 * which is the one blind spot this measurement has and cannot close: it counts what
 * the engine reported, not what the source contained.
 */
export interface RelationshipQuality {
  readonly type: RelationshipType;
  readonly resolved: number;
  readonly unresolved: number;
  /** `resolved / (resolved + unresolved)`, or `null` when the type never occurred. */
  readonly bindRate: number | null;
  readonly byConfidence: Readonly<Record<ConfidenceLevel, number>>;
  /** Unresolved reasons, most frequent first, then alphabetical. */
  readonly byReason: readonly ReasonCount[];
}

/**
 * Where resolved edges of one relationship type actually landed.
 *
 * A bind rate alone cannot distinguish an edge that reached a declaration from one
 * that reached a nameless sentinel, yet only the first is useful to a reader. This
 * splits them so a scan that "resolves" everything into `ext:outside-analysis` is
 * visibly not the same as one that reaches source.
 */
export interface TargetReach {
  /** The target is a declaration or file in an analysed source file. */
  readonly internal: number;
  /** The target is a named external — an npm package, a Node builtin, a TS lib type. */
  readonly named: number;
  /**
   * The target is `ext:outside-analysis`: resolved to a file the analysis never read,
   * with no package name recoverable. High counts mean module resolution is landing
   * outside the source tree — built output, or a workspace package reached through
   * its published types rather than its sources.
   */
  readonly opaque: number;
}

/** One repository, one scan, one set of measurements. */
export interface QualityReport {
  readonly repository: string;
  readonly repositoryPath: string;
  readonly files: number;
  readonly nodes: number;
  readonly edges: number;
  readonly unresolved: number;
  /** Wall-clock milliseconds for the scan, rounded. Excludes report computation. */
  readonly scanMillis: number;
  /** Only relationship types that occurred, in `RELATIONSHIP_TYPES` order. */
  readonly relationships: readonly RelationshipQuality[];
  /** Target reach for IMPORTS, the relationship most sensitive to module resolution. */
  readonly importReach: TargetReach;
  /** Target reach for CALLS. */
  readonly callReach: TargetReach;
  /**
   * Calls reaching a declaration *in this repository*, over those plus every unbound call.
   *
   * Reported separately because a plain CALLS bind rate can be raised almost arbitrarily
   * by counting calls that leave the repository, and those answer a different question. A
   * dependency edge onto `ext:npm:express` is a real fact and worth having, but it says
   * nothing about how well the repository's own call graph was recovered — which is what
   * traversal, impact and architecture all actually rest on.
   *
   * `null` when the repository contains no calls at all.
   */
  readonly internalCallBindRate: number | null;
  /**
   * What the repository is made of, and how far analysis got.
   *
   * The universal half of the measurement. A benchmark that reported only bind rates
   * could not tell a Python repository that scanned correctly from one that failed —
   * both would show no edges.
   */
  readonly universal: UniversalMeasurement;
}

/** Structure and capability, which exist for every repository whatever its language. */
export interface UniversalMeasurement {
  readonly languages: readonly LanguageFileCount[];
  readonly regions: number;
  /** Regions that reached at least `semantic` depth. */
  readonly semanticRegions: number;
  readonly manifests: number;
  readonly declaredDependencies: number;
  readonly depth: AnalysisDepth;
  readonly isPolyglot: boolean;
}
