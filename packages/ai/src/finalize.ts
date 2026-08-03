import { sentences } from './entailment.js';
import { CITATION_PATTERN, IDENTIFIER_PATTERN, citationIds, trimIdentifier, type ContextProjection } from './facts.js';
import { checkGrounding, type GroundingReport } from './grounding.js';

/**
 * What to return when verification has failed twice.
 *
 * **The rule this file exists to enforce: never present prose the pipeline knows is unsupported.** Until
 * now a second failure returned the whole answer with an `ungrounded` badge and left the reader to work
 * out which sentences were the problem — from a diagnostics list that names the *rejected strings*, not
 * the paragraphs they sit in. That is a system asking its user to do its verification for it, and the
 * badge makes it worse rather than better: a reader who has been told the answer is unsound and given no
 * way to find the unsound part will either discard a mostly-correct answer or, far more often, read it
 * anyway.
 *
 * **Deterministic, and specifically not another generation.** A third model call to "remove the bad
 * parts" would be a third thing to verify, and the whole reason the answer is here is that the model has
 * now been wrong twice about what its evidence supports. What survives is decided by the verifier that
 * rejected it, sentence by sentence, in code:
 *
 * - a sentence the entailment guard rejected is **removed**;
 * - a sentence naming an identifier or a term no fact carried is **removed**;
 * - a sentence whose only fault is a citation that does not resolve keeps the sentence and **loses the
 *   citation** — the claim may be fine and the id a miscount, and dropping a true sentence for a typo
 *   would be the over-correction this file is otherwise guarding against.
 *
 * Removal is monotone: taking a sentence out cannot make another sentence unsupported, because every rule
 * in `entailment.ts` reads one sentence and the closed identifier set does not change. So the retained
 * text verifies, and the result is re-checked rather than assumed.
 *
 * **Readability is preserved as far as removal allows, and no further.** Paragraph breaks survive, a
 * paragraph emptied of every sentence disappears rather than leaving a gap, and nothing is rewritten,
 * re-ordered or stitched. Where that leaves a short answer, a short answer is the honest outcome: "the
 * repository graph establishes X and Y, and does not establish how Y reaches Z" is a better answer than a
 * page that says how Y reaches Z on no evidence.
 */

export interface Finalisation {
  /** The answer as it should be shown. Never contains a claim the report rejected. */
  readonly text: string;
  /** The report for `text`, re-derived rather than inherited. */
  readonly report: GroundingReport;
  /** How many sentences were dropped, and how many citations were stripped from surviving ones. */
  readonly removedSentences: number;
  readonly strippedCitations: number;
  /** Whether anything was removed at all. `false` means the answer verified as written. */
  readonly reduced: boolean;
}

/**
 * The sentence used when nothing survives.
 *
 * **Reachable, and the case it is reachable in is the one that matters most.** An answer every sentence of
 * which made an unsupported claim leaves nothing to keep, and the alternatives are to return the original
 * — which is the failure this file exists to prevent — or to return an empty string, which reads as a
 * crash. What it says is true by construction: the pipeline verified the answer, none of it held, and the
 * evidence list beside it is what was available.
 */
const NOTHING_HELD =
  'This answer could not be given from the evidence available. Every statement the model produced made a claim the repository graph does not establish, so none of them are shown. The facts that were available are listed below.';

/**
 * Reduces an answer to the part of it the report supports.
 *
 * The projection is needed to re-verify: a report describes one text, and the text this returns is a
 * different one.
 */
export function finalise(answer: string, report: GroundingReport, projection: ContextProjection): Finalisation {
  if (!isUnsound(report)) {
    return { text: answer, report, removedSentences: 0, strippedCitations: 0, reduced: false };
  }

  const rejected = new Set(report.unsupportedClaims.map((finding) => finding.sentence.trim()));
  const fabricated = report.fabricatedIdentifiers.map((value) => value.toLowerCase());
  const terms = report.unsupportedTerms.map((value) => value.toLowerCase());
  const unknown = new Set(report.unknownCitations);

  let removedSentences = 0;
  let strippedCitations = 0;

  const paragraphs: string[] = [];

  for (const paragraph of answer.split(/\n{2,}/)) {
    const kept: string[] = [];

    /*
     * Sentences are split the way `entailment.ts` splits them, which is what makes the match exact.
     *
     * A finding carries the sentence it rejected, verbatim and trimmed. Splitting differently here would
     * compare a sentence against a fragment of itself and keep the claim the guard rejected — a silent
     * failure of the one guarantee this file makes.
     */
    for (const sentence of sentences(paragraph)) {
      if (rejected.has(sentence.trim()) || namesRejected(sentence, fabricated, terms)) {
        removedSentences += 1;
        continue;
      }

      const { text, stripped } = withoutUnknownCitations(sentence, unknown);

      strippedCitations += stripped;
      kept.push(text);
    }

    /*
     * A run shorter than the sentence splitter's floor is kept whole or dropped whole.
     *
     * `sentences` discards anything under thirteen characters, which is right for a claim checker — "Yes."
     * makes no claim — and wrong here, where discarding it would silently delete text nobody adjudicated.
     * A paragraph that produced no sentences at all is therefore kept as it stands.
     */
    if (kept.length === 0 && sentences(paragraph).length === 0 && paragraph.trim() !== '') {
      paragraphs.push(paragraph.trim());
      continue;
    }

    if (kept.length > 0) {
      paragraphs.push(kept.join(' '));
    }
  }

  const text = paragraphs.join('\n\n').trim();
  const kept = text === '' ? NOTHING_HELD : text;
  // Re-derived rather than inherited: this is a different text, and a verdict carried over from the one
  // that failed would be an assertion about prose nobody checked.
  const rechecked = checkGrounding(kept, projection);

  /*
   * The guarantee, checked rather than argued.
   *
   * Removal is monotone — every rule in `entailment.ts` reads one sentence, and taking a sentence out
   * cannot make another one unsupported — so this branch should be unreachable. It is here because the
   * claim it rests on is about code in another file, and the cost of being wrong is the one thing this
   * module exists to prevent: unsupported prose returned as though it were established. If the retained
   * text somehow still fails, nothing of it is shown.
   */
  if (isUnsound(rechecked)) {
    return {
      text: NOTHING_HELD,
      report: checkGrounding(NOTHING_HELD, projection),
      removedSentences: removedSentences + sentences(kept).length,
      strippedCitations,
      reduced: true,
    };
  }

  return { text: kept, report: rechecked, removedSentences, strippedCitations, reduced: true };
}

/** Whether a report describes an answer that must not be shown as written. */
export function isUnsound(report: GroundingReport): boolean {
  return (
    report.unsupportedClaims.length > 0 ||
    report.fabricatedIdentifiers.length > 0 ||
    report.unsupportedTerms.length > 0 ||
    report.unknownCitations.length > 0
  );
}

/**
 * Whether a sentence names something the report rejected.
 *
 * Matched on the identifier and backtick-span tokens the guard itself extracts, never on a substring of
 * the prose. A term rejected as `packages/graph-api` must not delete a sentence about `packages` — the two
 * are different claims and only one of them failed.
 */
function namesRejected(sentence: string, fabricated: readonly string[], terms: readonly string[]): boolean {
  if (fabricated.length > 0) {
    for (const match of sentence.matchAll(IDENTIFIER_PATTERN)) {
      if (fabricated.includes(trimIdentifier(match[0]).toLowerCase())) {
        return true;
      }
    }
  }

  if (terms.length === 0) {
    return false;
  }

  // A rejected term reaches prose as a quoted span or as a bare coordinate; both are bounded by
  // non-word characters, so a whole-token comparison is exact.
  const tokens: readonly string[] = sentence.toLowerCase().match(/[\w@./:-]+/g) ?? [];

  return terms.some((term) => tokens.includes(term));
}

/** A sentence with the citations that do not resolve removed, and the ones that do left alone. */
function withoutUnknownCitations(
  sentence: string,
  unknown: ReadonlySet<string>,
): { readonly text: string; readonly stripped: number } {
  if (unknown.size === 0) {
    return { text: sentence, stripped: 0 };
  }

  let stripped = 0;

  const text = sentence.replace(CITATION_PATTERN, (whole, group: string) => {
    const ids = citationIds(group);
    const held = ids.filter((id) => !unknown.has(id));

    if (held.length === ids.length) {
      return whole;
    }

    stripped += ids.length - held.length;

    return held.length === 0 ? '' : `[${held.join(', ')}]`;
  });

  // Collapse the space a removed bracket leaves before a full stop, so the sentence still reads.
  return { text: text.replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim(), stripped };
}
