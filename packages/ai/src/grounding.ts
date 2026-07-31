import {
  CITATION_PATTERN,
  IDENTIFIER_PATTERN,
  citationIds,
  trimIdentifier,
  type Citation,
  type ContextProjection,
} from './facts.js';

/**
 * Whether an answer stayed inside the facts it was given.
 *
 * `grounded` — at least one valid citation and nothing fabricated.
 * `ungrounded` — the answer named an identifier or a fact id that does not exist.
 * `unverifiable` — nothing fabricated, but nothing cited either, so there is nothing to check against.
 */
export type GroundingVerdict = 'grounded' | 'ungrounded' | 'unverifiable';

export interface GroundingReport {
  readonly verdict: GroundingVerdict;
  readonly citations: readonly Citation[];
  /** Identifiers the answer named that were not in the projection. */
  readonly fabricatedIdentifiers: readonly string[];
  /** Fact ids the answer cited that the projection did not contain. */
  readonly unknownCitations: readonly string[];
}

/**
 * Checks an answer against the closed set of facts that grounded it.
 *
 * This is the one place "grounded only in `RepositoryContext`" becomes **checkable** rather than
 * aspirational. Every identifier in the graph carries a fixed prefix, and for a given projection the
 * permitted set is closed and known — so any identifier-shaped token in the answer that is not in that
 * set is a fabrication, decided deterministically with no model involved.
 *
 * What it cannot do: catch a wrong *claim* about a real identifier. Saying "f12 proves X" when f12 proves
 * Y passes this check. The guard catches invented symbols, which is the failure that destroys trust
 * fastest, and it does not pretend to be more than that.
 */
export function checkGrounding(answer: string, projection: ContextProjection): GroundingReport {
  const byId = new Map(projection.facts.map((fact) => [fact.id, fact]));

  const citations: Citation[] = [];
  const unknownCitations: string[] = [];
  const seenCitation = new Set<string>();

  for (const match of answer.matchAll(CITATION_PATTERN)) {
    // One bracket may carry several ids — `[f8, f10]` — and every one of them counts.
    for (const id of citationIds(match[1] ?? '')) {
      if (seenCitation.has(id)) {
        continue;
      }

      seenCitation.add(id);
      const fact = byId.get(id);

      if (fact === undefined) {
        unknownCitations.push(id);
      } else {
        citations.push({ factId: id, fact });
      }
    }
  }

  const fabricated: string[] = [];
  const seenIdentifier = new Set<string>();

  for (const match of answer.matchAll(IDENTIFIER_PATTERN)) {
    const identifier = trimIdentifier(match[0]);

    if (seenIdentifier.has(identifier)) {
      continue;
    }

    seenIdentifier.add(identifier);

    if (!projection.identifiers.has(identifier)) {
      fabricated.push(identifier);
    }
  }

  const verdict: GroundingVerdict =
    fabricated.length > 0 || unknownCitations.length > 0 ? 'ungrounded' : citations.length > 0 ? 'grounded' : 'unverifiable';

  return {
    verdict,
    citations,
    fabricatedIdentifiers: fabricated,
    unknownCitations,
  };
}
