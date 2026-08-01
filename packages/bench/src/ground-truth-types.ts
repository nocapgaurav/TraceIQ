import type { RelationshipType } from '@traceiq/types';

/**
 * A hand-authored repository and every fact a correct analysis must find in it.
 *
 * **This is the only measurement in TraceIQ with a right answer.** Everything `measureQuality`
 * reports is a count of what the engine produced, which can tell a scan that got better from one
 * that got worse and cannot tell either from one that is wrong. A bind rate rises just as happily
 * when the analyser starts binding calls to the wrong declarations. Precision needs a truth to be
 * measured against, and the only place a truth can come from is a human writing it down.
 *
 * So each case is deliberately **small enough to enumerate exhaustively**. That is not a limitation
 * to be lifted later: precision is only meaningful when the expectation is complete, because a fact
 * the engine found and the author forgot is indistinguishable from one the engine invented. A
 * thousand-file corpus would have better coverage and no usable precision.
 *
 * The files are written to a temporary directory at run time rather than committed as a fixture
 * tree. A `.py`, `.java` and `.go` file living inside TraceIQ would be discovered by TraceIQ's own
 * scan, which is the repository every regression comparison in this project is measured on.
 */
export interface GroundTruthCase {
  /** Stable name, used to key a report and a baseline. */
  readonly name: string;
  /** What the case is for, shown in the report. */
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expected: ExpectedFacts;
}

/**
 * Every fact the case asserts, as identifiers.
 *
 * Identifiers rather than names, because an identifier is what the graph actually stores and what
 * a consumer traverses. Asserting on names would pass for an edge that reached the right *name* on
 * the wrong declaration, which is precisely the failure mode a name-based binder has.
 */
export interface ExpectedFacts {
  /** Every declaration identifier: `sym:<path>#<chain>`. */
  readonly declarations: readonly string[];
  /**
   * Edges as `<sourceId> -> <targetId>`, per relationship type.
   *
   * A type absent from this record is **not measured** for the case, rather than expected to be
   * empty. Go has no export statement and Python has no interface; requiring every case to state
   * every type would mean asserting the absence of constructs the language does not have.
   */
  readonly edges: Partial<Record<RelationshipType, readonly string[]>>;
}

/** How one relationship type, or declarations, scored against the truth. */
export interface FactScore {
  /** What the case says should exist. */
  readonly expected: number;
  /** What the scan produced, over the same fact kind. */
  readonly produced: number;
  /** Produced facts that the case also expects. */
  readonly matched: number;
  /** `matched / produced`, or `null` when nothing was produced. */
  readonly precision: number | null;
  /** `matched / expected`, or `null` when nothing was expected. */
  readonly recall: number | null;
  /** Expected and not produced, up to a readable limit. */
  readonly missing: readonly string[];
  /** Produced and not expected, up to a readable limit. */
  readonly spurious: readonly string[];
}

/** One ground-truth case, measured. */
export interface GroundTruthReport {
  readonly name: string;
  readonly description: string;
  readonly files: number;
  readonly declarations: FactScore;
  /** Only the types the case states an expectation for, in `RELATIONSHIP_TYPES` order. */
  readonly edges: readonly (FactScore & { readonly type: RelationshipType })[];
  /**
   * Precision and recall over every measured fact, weighted by fact count.
   *
   * Weighted rather than averaged across kinds: a case with one EXTENDS edge and four hundred CALLS
   * edges is overwhelmingly a test of the call graph, and an unweighted mean would let one
   * inheritance edge swing the headline number as far as a hundred calls.
   */
  readonly overall: FactScore;
  /** Unresolved references by reason, most frequent first. */
  readonly unresolvedByReason: readonly { readonly reason: string; readonly count: number }[];
  /** Every edge's confidence, counted, so a drift toward over-claiming is visible. */
  readonly byConfidence: Readonly<Record<string, number>>;
  readonly scanMillis: number;
  /** Peak resident memory growth over the scan, in bytes. `null` when not measurable. */
  readonly heapBytes: number | null;
}
