import {
  BACKTICK_PATTERN,
  CITATION_PATTERN,
  COORDINATE_PATTERN,
  IDENTIFIER_PATTERN,
  citationIds,
  isArtefactShaped,
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
  /**
   * Repository names the answer claimed that no fact carried.
   *
   * Packages, frameworks, technologies and dependencies — the things an answer about a repository is
   * mostly made of, and which carry no `sym:` prefix to check them by. Kept apart from
   * `fabricatedIdentifiers` because the two differ in how certain they are: an invented identifier is
   * a fabrication with no defence, while an unsupported term may be a real thing the projection's
   * budget simply did not reach. Both make an answer `ungrounded`; only one of them is the model's
   * fault, and a reader deserves to be able to tell.
   */
  readonly unsupportedTerms: readonly string[];
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

  const unsupportedTerms = checkTerms(answer, projection);

  const verdict: GroundingVerdict =
    fabricated.length > 0 || unknownCitations.length > 0 || unsupportedTerms.length > 0
      ? 'ungrounded'
      : citations.length > 0
        ? 'grounded'
        : 'unverifiable';

  return {
    verdict,
    citations,
    fabricatedIdentifiers: fabricated,
    unsupportedTerms,
    unknownCitations,
  };
}

/**
 * Names the answer claimed that the projection never carried.
 *
 * **Extends grounding past identifiers without extending it past what is decidable.** The guard's whole
 * value is that it is deterministic and never wrong, so the candidate set is restricted to two shapes a
 * model only writes when it means an artefact — a backtick span and a bare coordinate — and each
 * candidate must additionally *look* like something a manifest or a filesystem produced before it is
 * adjudicated. See `isArtefactShaped`.
 *
 * The failure this prevents is the characteristic one for a repository assistant: an answer that names
 * plausible dependencies. A model told a repository is a JavaScript project will volunteer `express`
 * and `lodash` because JavaScript projects have them, and before this nothing in the pipeline could
 * contradict it — the claim carried no `ext:` prefix, so the identifier guard never looked at it.
 *
 * Deliberately *not* checked: prose claims about architecture and design. "The architecture is layered"
 * is not adjudicable against a closed set, and reporting it would make the guard noise — which is the
 * failure mode that gets a guard switched off.
 */
function checkTerms(answer: string, projection: ContextProjection): readonly string[] {
  const unsupported: string[] = [];
  const seen = new Set<string>();

  const consider = (raw: string): void => {
    const term = trimIdentifier(raw.trim());
    const key = term.toLowerCase();

    if (term === '' || seen.has(key) || !isArtefactShaped(term)) {
      return;
    }

    seen.add(key);

    // An identifier is the identifier guard's business, and reporting it twice would double-count one
    // mistake across two fields.
    if (IDENTIFIER_PATTERN.test(term)) {
      IDENTIFIER_PATTERN.lastIndex = 0;

      return;
    }

    IDENTIFIER_PATTERN.lastIndex = 0;

    if (projection.terms.has(key)) {
      return;
    }

    // A scoped or coordinate name may be written by its last segment — `@babel/core` as `core`. The
    // projection records both forms, so a miss on the whole is checked against the part before it is
    // called unsupported.
    const tail = key.split(/[/:]/).at(-1);

    if (tail !== undefined && tail !== key && projection.terms.has(tail)) {
      return;
    }

    unsupported.push(term);
  };

  for (const match of answer.matchAll(BACKTICK_PATTERN)) {
    consider(match[1] ?? '');
  }

  for (const match of answer.matchAll(COORDINATE_PATTERN)) {
    consider(match[1] ?? '');
  }

  return unsupported;
}
