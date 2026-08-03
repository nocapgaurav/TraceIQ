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
import { checkEntailment, describeClaim, predicatesOf, type ClaimFinding } from './entailment.js';

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
  /**
   * Why the verdict is what it is, in words a reader can act on.
   *
   * **Added because a bare list of rejected strings is not a diagnosis.** The guard once reported
   * `ModalDialog.js` as unsupported in an otherwise correct answer about React — the file's full path
   * was in the facts, and the model had simply used its name. Reading that report told nobody whether
   * the model had invented something or the verifier had been too strict, and the only way to find out
   * was to re-derive the projection by hand.
   *
   * Each line names the thing, what it was checked against, and how close it came. That is enough to
   * tell a fabrication from a gap in the permitted set without leaving the page.
   */
  readonly diagnostics: readonly GroundingDiagnostic[];
  /**
   * Sentences whose *claim* the facts do not license, however real every name in them is.
   *
   * **Existence is weaker than entailment, and this is the gap.** `set_secret.py manages secrets` becoming
   * "authentication works through set_secret.py" passes every check above: the identifier is real, the
   * citation resolves, no package was invented. The verb is what is wrong. See `checkEntailment`.
   */
  readonly unsupportedClaims: readonly ClaimFinding[];
  /** Claims the facts make plausible and the answer hedged. Reported for observability, never a failure. */
  readonly inferredClaims: readonly ClaimFinding[];
}

export interface GroundingDiagnostic {
  readonly kind: 'fabricated-identifier' | 'unsupported-term' | 'unknown-citation' | 'no-citations' | 'unsupported-claim';
  /** The exact text from the answer that triggered it. */
  readonly subject: string;
  /** What it was compared against, and what the comparison found. */
  readonly detail: string;
  /** The closest thing the projection did carry, where there is one. Empty when nothing is close. */
  readonly nearest: readonly string[];
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
  const entailment = checkEntailment(answer, projection);
  const diagnostics: GroundingDiagnostic[] = [];

  for (const identifier of fabricated) {
    diagnostics.push({
      kind: 'fabricated-identifier',
      subject: identifier,
      detail: `no fact carried this identifier; ${projection.identifiers.size} were available`,
      nearest: nearestTo(identifier, projection.identifiers),
    });
  }

  for (const term of unsupportedTerms) {
    diagnostics.push({
      kind: 'unsupported-term',
      subject: term,
      detail: `no fact named this package, framework, file or dependency; ${projection.terms.size} names were available`,
      nearest: nearestTo(term, projection.terms),
    });
  }

  for (const finding of entailment.unsupported) {
    diagnostics.push({
      kind: 'unsupported-claim',
      subject: finding.sentence,
      detail: `${describeClaim(finding)}; the projection carried ${predicatesOf(projection.facts).length} kinds of fact, none of them this one`,
      nearest: [],
    });
  }

  for (const id of unknownCitations) {
    diagnostics.push({
      kind: 'unknown-citation',
      subject: id,
      detail: `the answer cited ${id}, but this projection held f1 to f${projection.facts.length}`,
      nearest: [],
    });
  }

  if (diagnostics.length === 0 && citations.length === 0) {
    diagnostics.push({
      kind: 'no-citations',
      subject: '',
      detail: 'nothing was fabricated, but no fact id was cited either, so no claim could be checked',
      nearest: [],
    });
  }

  /*
   * An unsupported claim is ungrounded, on the same footing as an invented identifier.
   *
   * **Deliberately not a softer category.** The whole reason to check entailment is that a sentence made
   * of real names saying an unsupported thing is *more* misleading than one naming a file that does not
   * exist: the second is obviously wrong to anyone who looks, and the first reads as a finding. Reporting
   * it as a lesser problem would be reporting the more dangerous failure more quietly.
   *
   * A hedged claim is not counted. Where the facts make something plausible and the answer says so, the
   * pipeline asked for exactly that wording — see `EvidenceSufficiency` and the workflow confidences.
   */
  const verdict: GroundingVerdict =
    fabricated.length > 0 ||
    unknownCitations.length > 0 ||
    unsupportedTerms.length > 0 ||
    entailment.unsupported.length > 0
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
    diagnostics,
    unsupportedClaims: entailment.unsupported,
    inferredClaims: entailment.inferred,
  };
}

/**
 * The closest permitted names to something that was rejected.
 *
 * **A substring match, deliberately, and not an edit distance.** The failures worth diagnosing are not
 * typos — a model does not misspell `react-dom` — they are a name written at a different granularity
 * from the one the facts carry: a file by its basename, a package by its last segment, a scope without
 * its package. Every one of those shares a whole substring with the permitted form, and every one of
 * them is invisible to a distance metric that would rank `react-dom` and `react-dnd` as near
 * neighbours.
 */
function nearestTo(value: string, permitted: ReadonlySet<string>): readonly string[] {
  const needle = value.toLowerCase();
  const near: string[] = [];

  for (const candidate of permitted) {
    if (candidate.includes(needle) || needle.includes(candidate)) {
      near.push(candidate);
    }

    if (near.length === 3) {
      break;
    }
  }

  return near;
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
