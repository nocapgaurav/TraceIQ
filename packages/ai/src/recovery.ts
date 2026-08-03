import { licencesFor, type ClaimFinding } from './entailment.js';
import { IDENTIFIER_PREFIXES, type Predicate } from './facts.js';
import type { GroundingReport } from './grounding.js';

/**
 * What a failed answer needed and did not have, expressed as fact parts to go back for.
 *
 * **This is the file that replaces rewriting.** The corrective pass used to hand the model its own
 * rejected answer, the list of sentences that failed, and *the same facts it had already been given* — and
 * asked for a better answer. That is a request to say something different about an unchanged evidence set,
 * which for a sentence rejected as unsupported has exactly two honest outcomes: say less, or say the same
 * thing in words the guard does not recognise. Both were observed. The UI reported an answer as
 * "rewritten once" and still ungrounded, which is the pipeline telling a user that it tried twice and
 * failed twice for the same reason.
 *
 * The reason is not the model's. A sentence is rejected as `execution-order` because **no fact of an
 * ordering kind is in the projection** — and whether the graph holds one is a separate question from
 * whether the budget reached it. On TraceIQ the compose file's declared order is four `artifact-ordering`
 * facts that a component-heavy allocation had priced out; the model asserted an order it could not cite,
 * and the evidence for it was sitting one retrieval away. Rewriting cannot find that. Retrieving can.
 *
 * So a recovery plan is a **deterministic translation of a verification failure into a retrieval
 * request**, and it is derived from the same tables the guard adjudicates with:
 *
 * - a rejected *claim* names its kind; the kind names the predicates that would license it; a predicate
 *   names the parts that emit it.
 * - a rejected *identifier* names its own prefix; a prefix names the parts that carry identifiers of that
 *   kind.
 * - a rejected *term* is a name, so the parts that carry names are asked for.
 *
 * **Bounded three ways.** At most `PART_LIMIT` parts are requested, the recovery projection is built at
 * the same tier and against the same budget as the first, and `RepositoryAnswerer` runs it at most once.
 * There is no loop and no traversal: this function reads a report and returns a list of strings.
 */

/**
 * Which fact parts emit each predicate.
 *
 * **The inverse of what the extractors do, and it has to live beside them in spirit even though it lives
 * here.** A predicate is what the guard reasons about; a part is what the projection can be asked for. One
 * predicate may come from several parts — `declares` from `key-artifacts`, `references` from three
 * different extractors — and asking for all of them is correct: the recovery pass takes what fits.
 *
 * A predicate absent from this table yields no request, which is the honest outcome for one that no
 * extractor produces on this context.
 */
const PARTS_FOR_PREDICATE: Readonly<Record<string, readonly string[]>> = {
  // Ordering, and where a repository states one.
  'artifact-ordering': ['key-artifacts'],
  workflow: ['identity', 'request-flow'],
  'request-flow': ['request-flow'],
  'handles-route': ['routes'],
  'route-middleware': ['routes'],
  calls: ['incomingCalls', 'outgoingCalls', 'related'],
  // What a thing is and what it is for.
  'has-role': ['architecture'],
  capability: ['architecture-summary', 'identity'],
  'entry-point': ['onboarding', 'identity'],
  onboarding: ['onboarding'],
  documents: ['key-artifacts', 'onboarding'],
  declares: ['key-artifacts'],
  configures: ['key-artifacts', 'technologies'],
  runs: ['key-artifacts'],
  'runs-on': ['architecture-summary', 'technologies'],
  'has-package': ['packages'],
  'reads-env': ['environmentVariables'],
  'exists-to': ['purpose'],
  'built-with': ['technologies'],
  'depends-on': ['externalPackages', 'dependencyClosure'],
  references: ['key-artifacts', 'references', 'related'],
};

/**
 * Which parts carry identifiers of each prefix.
 *
 * A fabricated identifier is usually a real thing written at the wrong granularity or a real thing the
 * budget never reached; both are answered by projecting more of the part that carries that kind of name.
 * A genuinely invented identifier is answered by nothing, and the pass costs one projection to establish
 * that — which is the same cost the rewrite used to pay for establishing nothing.
 */
const PARTS_FOR_PREFIX: Readonly<Record<string, readonly string[]>> = {
  'sym:': ['architecture', 'hotspots', 'packages'],
  'file:': ['key-artifacts', 'onboarding', 'regions', 'tests'],
  'route:': ['routes'],
  'env:': ['environmentVariables'],
  'ext:': ['externalPackages'],
  'art:': ['key-artifacts'],
};

/** Parts that carry repository *names* — what an unsupported term is most likely to have been. */
const PARTS_FOR_TERM: readonly string[] = ['packages', 'areas', 'technologies', 'externalPackages', 'key-artifacts'];

/**
 * How many parts one recovery pass may ask for.
 *
 * **A bound on the request, not on the budget** — the budget is bounded already, because the recovery
 * projection is built at the same tier as the first. What this bounds is *dilution*: a report with nine
 * distinct failures would otherwise ask for every part in the projection, which is not a targeted
 * expansion but the unallocated projection with extra steps. Six is the largest priority policy in
 * `EVIDENCE_POLICY`, so a recovery request can be at most as broad as an intent's own lead.
 */
const PART_LIMIT = 6;

export interface RecoveryPlan {
  /** Fact parts to bring forward and deepen, most directly implicated first. Empty means do not retry. */
  readonly parts: readonly string[];
  /**
   * Why each part was asked for, in the verifier's own words.
   *
   * Carried into the diagnostics rather than into the prompt: the model is told which sentences failed and
   * why, and telling it which extractor was re-run as well would be describing this pipeline to it.
   */
  readonly reasons: readonly string[];
  /** The sentences the recovered answer must either establish or withdraw. */
  readonly claims: readonly ClaimFinding[];
}

/** A plan that asks for nothing, so a caller can compare against a constant rather than a length. */
export const NO_RECOVERY: RecoveryPlan = { parts: [], reasons: [], claims: [] };

/**
 * Turns one verification failure into one bounded retrieval request.
 *
 * Returns `NO_RECOVERY` where nothing could be fetched that would change the verdict. Two failures are
 * like that by construction — a quality verdict and a claim of nonexistence are licensed by no fact of any
 * kind — and a caller that recovers anyway would spend a whole generation re-establishing that.
 */
export function recoveryFor(report: GroundingReport): RecoveryPlan {
  const parts: string[] = [];
  const reasons: string[] = [];

  const want = (candidates: readonly string[], reason: string): void => {
    const fresh = candidates.filter((part) => !parts.includes(part));

    if (fresh.length === 0) {
      return;
    }

    parts.push(...fresh);
    reasons.push(reason);
  };

  for (const finding of report.unsupportedClaims) {
    const predicates = licencesFor(finding.kind);

    if (predicates.length === 0) {
      // Nothing licenses this claim in any projection: see `presence-as-quality` and
      // `absence-as-nonexistence`. The answer has to withdraw it, and retrieval cannot help.
      continue;
    }

    want(
      predicates.flatMap((predicate: Predicate) => PARTS_FOR_PREDICATE[predicate] ?? []),
      `${finding.kind}: the projection carried no fact that could license it`,
    );
  }

  for (const identifier of report.fabricatedIdentifiers) {
    const prefix = IDENTIFIER_PREFIXES.find((candidate) => identifier.startsWith(candidate));

    if (prefix === undefined) {
      continue;
    }

    want(PARTS_FOR_PREFIX[prefix] ?? [], `${identifier}: no fact carried this identifier`);
  }

  if (report.unsupportedTerms.length > 0) {
    want(PARTS_FOR_TERM, `${report.unsupportedTerms.join(', ')}: no fact carried these names`);
  }

  /*
   * An unknown citation is the one failure retrieval cannot touch, and it is deliberately not here.
   *
   * `[f97]` in a projection of forty facts is a model miscounting, not a missing fact. Asking the graph
   * for more evidence would change which forty facts exist and change nothing about the habit. It is
   * handled where it can be — safe finalisation strips the citation and keeps the sentence if the rest of
   * it verifies.
   */

  return parts.length === 0
    ? NO_RECOVERY
    : { parts: parts.slice(0, PART_LIMIT), reasons, claims: report.unsupportedClaims };
}
