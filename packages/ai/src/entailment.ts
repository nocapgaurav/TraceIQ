import { factLine, type ContextProjection, type Fact, type Predicate } from './facts.js';

/**
 * Whether the facts an answer was given actually establish what it said.
 *
 * **Existence is weaker than entailment, and the gap between them is where the remaining failures live.**
 * The grounding guard adjudicates *naming*: every identifier and every package an answer mentions must be
 * one the projection carried, decided against a closed set with no model involved. That is exactly the
 * right check and it caught real fabrications. What it cannot see is an answer built entirely from real
 * names that says something the facts do not support:
 *
 * - `set_secret.py manages secrets` became **"authentication works through set_secret.py"**. Every name is
 *   real. Secret storage is not an authentication flow.
 * - `aml_creation.py references another script` became **"the deployment workflow begins with
 *   aml_creation.py"**. A recorded reference is not a temporal order.
 * - `Redis is declared` became **"Redis caches the redirect lookup"**. A dependency is not a behaviour.
 *
 * Each of those is one sentence with a subject the facts carry and a verb they do not. This file checks
 * the verb.
 *
 * **It is not a theorem prover and does not attempt to be one.** It knows eight transformations, each
 * observed in a real answer, and for each it asks a single question: is there a fact of the *kind* that
 * would license this? A claim of execution order needs a fact that records order. A claim about
 * authentication needs a fact about authentication rather than about secrets. A claim that something is the
 * *core* of a repository needs a fact about the repository, not a fan-in count. Anything it cannot classify
 * it leaves alone, because a validator that fires on prose it does not understand is a validator someone
 * turns off.
 *
 * **Rule order is load-bearing and the ordering is by what the sentence is *doing*.** A denial is
 * adjudicated as a denial before anything it names is considered; a quality verdict and a recommendation
 * are adjudicated before the ordering rule, because "you should start with `routes.ts`" shares a verb with
 * "the flow starts with `routes.ts`" and says something entirely different. Getting this wrong produces
 * the right verdict for the wrong reason and a misleading diagnostic — which happened once already, when
 * "there is no authentication" was reported as a secrets claim.
 *
 * **Hedged language is accepted, and that is the design rather than a loophole.** "The evidence suggests
 * the deployment begins with `aml_creation.py`" is an honest sentence about an inference, and the pipeline
 * asks for exactly that wording where an inference is allowed. What is rejected is the same sentence
 * asserted flatly. The hedge has to be attached to the claim, so a paragraph opening "this may be
 * approximate" does not license six unhedged sentences after it.
 */

export const CLAIM_STRENGTHS = [
  /** The facts directly establish it. */
  'supported',
  /** The facts make it plausible; the sentence says so. */
  'inferred',
  /** The facts do not license it, however real the names in it are. */
  'unsupported',
] as const;

export type ClaimStrength = (typeof CLAIM_STRENGTHS)[number];

export interface ClaimFinding {
  /** The sentence, trimmed. */
  readonly sentence: string;
  /** Which transformation it performed. */
  readonly kind: ClaimKind;
  readonly strength: ClaimStrength;
  /** What would have licensed it, and whether the projection carried any. */
  readonly detail: string;
}

export const CLAIM_KINDS = [
  /** A reference or dependency edge stated as runtime sequence. */
  'execution-order',
  /** Secret or credential storage stated as an authentication mechanism. */
  'secrets-as-authentication',
  /** A declared or detected technology stated as performing a behaviour. */
  'presence-as-behaviour',
  /** Nothing detected, stated as nothing existing. */
  'absence-as-nonexistence',
  /** A configuration file stated as confirmed runtime behaviour. */
  'configuration-as-runtime',
  /** A structural measurement stated as architectural centrality. */
  'prominence-as-importance',
  /** The presence of files stated as a judgement about quality or practice. */
  'presence-as-quality',
  /** A place to start reading, recommended with nothing behind the recommendation. */
  'recommendation-without-evidence',
] as const;

export type ClaimKind = (typeof CLAIM_KINDS)[number];

/**
 * Wording that turns an assertion into a statement about an inference.
 *
 * Kept deliberately short. Every entry is a phrase that a reader unambiguously understands as "this is not
 * established", and the list is not a place to add words that merely soften — "essentially", "effectively"
 * and "basically" assert just as hard as a bare verb and are not here.
 */
const HEDGE =
  /\b(may|might|could|appears? (to|that)|seems? (to|that)|suggests?|likely|probably|conventional|conventionally|not observed|not recorded|inferred|by convention|would|presumably|apparently|possibly|perhaps)\b/i;

/**
 * A sentence explicitly reporting what the analysis did *not* establish is never a claim to adjudicate.
 *
 * **Widened after a live run, where it was too narrow and punished the honest wording.** Asked how
 * authentication works on a repository that has none, the model answered "no route or middleware for
 * authentication was found during analysis" — precisely the sentence the pipeline asks for — and the
 * secrets rule rejected it, because the sentence names authentication and no fact licenses an
 * authentication claim. A guard that fails the answer it requested is worse than no guard: it teaches a
 * reader that the verdict means nothing.
 *
 * The forms below are the ways a report says "we looked and did not find it", including the passive
 * ("was not found", "were not detected") and the negated-noun form ("no route ... was found") that the
 * first version missed.
 */
const DISCLAIMING =
  /\b(not (established|observed|recorded|detected|determined|confirmed|found|identified)|(was|were|is|are) not (established|observed|recorded|detected|determined|confirmed|found|identified)|does not (establish|record|show)|cannot (say|tell|establish|determine|be confirmed)|could not (be )?(determined?|established?|confirmed?|found)|no (evidence|fact|record)|no [\w\s]{1,40}(was|were) (found|detected|identified|established)|did not (identify|detect|find|establish|cover)|limitation of the analysis)\b/i;

interface Rule {
  readonly kind: ClaimKind;
  /** What the sentence is doing. */
  readonly claim: RegExp;
  /** Predicates that would license it outright. */
  readonly licensedBy: readonly Predicate[];
  /** What the answer would have needed, for the finding's detail line. */
  readonly needs: string;
  /**
   * Predicates that license the claim **only when a fact of that kind also mentions `concept`**.
   *
   * Separate from `licensedBy`, whose members license on presence alone, because one predicate needed the
   * stricter treatment and conflating the two would have quietly loosened the other rules. A `declares`
   * fact exists for *every* artefact the repository holds, so its mere presence says nothing about when
   * anything runs; a `declares` fact that names a trigger says exactly that.
   */
  readonly licensedByConcept?: readonly Predicate[];
  /**
   * A concept that must appear **inside a fact of a licensing kind** for the licence to hold.
   *
   * The mechanism exists because two rules cannot be decided by predicate kind alone, and it is
   * deliberately restrictive: the concept is looked for only within facts whose predicate already
   * licenses the claim, never across the whole projection. Without that restriction the check is
   * circular — the profile derives an `authentication` domain from a secret-shaped variable name, emits
   * it as a `characterised-as` fact, and a search over all facts then finds the derivation and uses it
   * to license the very sentence the derivation was too weak to support.
   */
  readonly concept?: RegExp;
}

/**
 * The transformations, each with the predicate that would license it.
 *
 * **Every rule here was written against an answer that was actually produced**, which is why there are
 * five rather than fifty. A rule for a transformation nobody has made is a rule with no evidence behind
 * its threshold, and this file is only safe while every pattern in it is narrow enough to be defended.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'absence-as-nonexistence',
    /*
     * First, because a sentence denying something is making *that* claim rather than the one it names.
     *
     * "There is no authentication in this repository" mentions authentication and is not an authentication
     * claim; ordered after the secrets rule it was caught as one, which is the right verdict for the wrong
     * reason and would have reported a misleading diagnostic.
     *
     * This rule is the mirror of everything else in the file, and it became reachable *because* of this
     * milestone: teaching the pipeline to answer "no caching was identified" invites the stronger form,
     * which is a claim about the repository that no absence of evidence supports.
     */
    claim:
      /\b(there (is|are) no|has no|have no|does not (have|use|contain|implement)|do not (have|use|contain|implement)|lacks|no \w+ (exists?|is present)|without any)\b/i,
    licensedBy: [],
    needs: 'the wording "not identified" or "not detected", which is what an absence of evidence supports',
  },
  {
    kind: 'presence-as-quality',
    /*
     * The presence of files stated as a judgement about quality or practice.
     *
     * A README and a `.gitignore` establish that a README and a `.gitignore` exist. Nothing in this
     * pipeline reads prose, measures coverage, or evaluates a convention, so "well documented", "well
     * tested" and "follows best practices" are claims no fact in any projection can support — which is why
     * `licensedBy` is empty rather than narrow. This is the mirror of `absence-as-nonexistence`: both turn
     * a file listing into a verdict, in opposite directions.
     *
     * A *comparative* claim is caught by the same pattern and is worse: "better documented than most" adds
     * a corpus nothing here has.
     */
    claim:
      /\b(well[- ](documented|tested|structured|organised|organized|maintained|architected|factored)|(follows?|adheres? to|uses?) (industry )?(best[- ]practices?|standard conventions|modern conventions)|(high|good|excellent|poor|low)[- ](quality|test coverage|code quality)|clean architecture|idiomatic (code|structure)|production[- ]ready|thoroughly (tested|documented))\b/i,
    licensedBy: [],
    needs:
      'a measurement of quality, coverage or convention — this analysis makes none, so no wording of this claim is supportable',
  },
  {
    kind: 'recommendation-without-evidence',
    /*
     * A place to start reading, recommended with nothing behind the recommendation.
     *
     * **The failure §4 of the milestone names, and it is a retrieval failure wearing prose.** Asked what to
     * read first, the pipeline recommended the most-referenced declaration — which is the worst possible
     * first file, since it is referenced by everything precisely because it assumes everything. The
     * recommendation was correctly cited, so no naming check could touch it.
     *
     * What licenses a recommendation is evidence about *approaching* the repository: documentation it
     * ships, a `documents` link, an entry point, a package boundary, or a route. Ranking is absent from the
     * list on purpose. Where none of those exists the honest answer says what is known and what remains
     * undetermined, which is what the planner's `undetermined` verdict already asks for.
     *
     * The imperative is deliberately included here, unlike in `execution-order` where it is exempted: "read
     * `routes.ts` first" is a recommendation whether or not it has a subject, and the mood is what
     * distinguishes it from an ordering claim rather than what excuses it.
     *
     * **Every alternative below requires a reader-directed cue, and the first version did not.** It matched
     * a bare "begin with", which is ordinary ordering prose — so "the deployment appears to begin with
     * `aml_creation.py`" was adjudicated as a recommendation, and the ordering rule that should have caught
     * it never ran. A recommendation addresses somebody: it has an imperative mood, a second person, a
     * reader as its subject, or the words "place to start".
     */
    claim:
      /(^\s*(start|begin|read|open|look at)\b|\b(you|your|readers?|a newcomer|a new (developer|engineer|contributor|reader)|someone new|anyone new)\s+\w*\s*(should|could|can|would want to|will want to)?\s*(start|begin|read|look at|open)\b|\bi (would )?recommend (starting|beginning|reading)\b|\bthe (best|right|natural|obvious) place to start\b|\ba good (starting point|place to start|first file)\b|\bstart (here|by reading)\b|\bread [^.]{1,60} first\b|\borient yourself\b|\byour first stop\b|\bentry point for a (new|newcomer)\b)/i,
    // `exists-to` is absent for the reason it is absent above: the repository's purpose is not a statement
    // about where a reader should begin.
    licensedBy: ['onboarding', 'documents', 'entry-point', 'has-package', 'handles-route'],
    needs:
      'onboarding evidence — documentation the repository ships, a documented file, an established entry point, a package boundary or a route',
  },
  {
    kind: 'prominence-as-importance',
    /*
     * A structural measurement stated as architectural centrality.
     *
     * **The transformation this milestone is named for.** `set_secret.py` genuinely has the highest fan-in
     * in an umbrella repository whose only analysable code is four CI scripts, so it was reported as the
     * repository's core, its architecture, and the answer to every question asked of it. Every number was
     * right. The word "core" was wrong, and no count can tell the difference.
     *
     * What licenses a centrality claim is a **repository-level** fact: something the repository is for
     * (`exists-to`), a capability two role layers agree on, a request flow, a workflow, a route it serves,
     * or an entry point. A fan-in count is not on that list and cannot be, because it is the measurement
     * being conflated. Where none of those facts exists, the supportable wording is that the declaration
     * is structurally prominent in the graph — which is what the projection actually measured.
     */
    claim:
      /\b(the (core|centre|center|heart|hub|nucleus|linchpin|architectural (centre|center|core))|(is|as) the (core|centre|center|heart) of|the most important (part|piece|component|module|file|declaration|class|function)|the central (component|module|piece|abstraction)|the main (component|abstraction)|architecturally central|the primary abstraction)\b/i,
    /*
     * `exists-to` is deliberately **not** a licence here, and removing it was a correction.
     *
     * It says what the *repository* is for, which is a different subject from which component is central to
     * it — so a repository with any derivable purpose licensed a centrality claim about any declaration in
     * it, which is nearly every repository and therefore no check at all. What licenses this claim has to be
     * a fact that puts *this thing* at the middle of something: a capability that names it as a member, a
     * flow it participates in, a route it serves, an entry point it is.
     */
    licensedBy: ['capability', 'request-flow', 'workflow', 'handles-route', 'entry-point', 'onboarding'],
    needs:
      'a fact placing this thing at the centre of something — a capability naming it, a request flow, a workflow, a route it serves or an established entry point',
  },
  {
    kind: 'execution-order',
    /*
     * Sequence words about a named thing.
     *
     * The graph records that one declaration references another. It records nothing about when either
     * runs — Python resolves names at runtime, and even a recorded call edge is a call site rather than
     * an ordering. Only a route-to-handler edge or an extracted workflow establishes sequence.
     */
    claim:
      /\b(begins? (with|at|from)|starts? (with|at|by|from)|then (calls?|invokes?|runs?|passes|hands)|first (calls?|runs?|invokes?)|followed by|next,? (it|the)|the (flow|pipeline|workflow|process|sequence) (begins?|starts?|proceeds?|moves?)|triggers?|kicks off|orchestrates?|before|after|precedes?)\b/i,
    /*
     * `artifact-ordering` joins this list, and it is the one addition that *widens* what an answer may
     * say rather than narrowing it.
     *
     * A workflow's `needs: build` is the repository stating that one job precedes another. Before artefact
     * analysis there was no fact of that kind anywhere, so "the release job runs after the build job" —
     * true, written in the repository's own YAML, and exactly what a deployment question asks for — was
     * unsupported and made the answer ungrounded. The guard was right to reject it, because nothing it
     * could see established it; the fix was to establish it.
     */
    licensedBy: ['workflow', 'handles-route', 'route-middleware', 'request-flow', 'calls', 'artifact-ordering'],
    needs:
      'a workflow, a route-to-handler edge, a recorded call, or a prerequisite an artefact declares between its own parts',
  },
  {
    kind: 'secrets-as-authentication',
    /*
     * The transformation the milestone names first, and the most dangerous one observed.
     *
     * A repository can store credentials and have no authentication anywhere: the two are different
     * mechanisms and a name cannot tell them apart. `identity.securityOf` already refuses to report
     * secret-shaped variables as a guard; this catches the model doing it in prose regardless.
     */
    claim:
      /\b(authenticat\w+|authoris\w+|authoriz\w+|log(s|ged)? in|login flow|sign[- ]in|access control|permission\w*|identity provider)\b/i,
    licensedBy: ['route-middleware', 'has-role', 'handles-route'],
    concept: /(auth|login|logout|session|oauth|permission|rbac|guard)/i,
    needs: 'access-control middleware or an authentication route',
  },
  {
    kind: 'presence-as-behaviour',
    /*
     * A declared technology stated as doing a specific job in this repository.
     *
     * `built-with Redis` says the manifest declares it. That it caches *this* lookup, or stores *that*
     * state, is a claim about behaviour the graph never observed — and it is the sentence a reader is
     * most likely to act on.
     */
    claim:
      /\b(is used to|used for|handles the|manages the|is responsible for|powers the|backs the|stores the|caches the|serves the)\b/i,
    /*
     * The artefact predicates license a responsibility claim, and that is the point of having them.
     *
     * "`docker-compose.yml` is responsible for starting postgres" is a statement about what a file
     * declares, which `declares` establishes; "Redis caches the redirect lookup" is a statement about
     * behaviour that no artefact states, and it still fails. The difference is whether a fact of one of
     * these kinds exists at all, which is the same test every other rule here applies.
     */
    licensedBy: [
      'workflow',
      'handles-route',
      'has-role',
      'runs-on',
      'request-flow',
      'reads-env',
      'declares',
      'runs',
      'configures',
      'documents',
    ],
    needs: 'a role annotation, a workflow, a responsibility the detector recorded, or an artefact that declares it',
  },
  {
    kind: 'configuration-as-runtime',
    /*
     * A configuration file read as confirmed behaviour.
     *
     * A workflow file says what CI is configured to do, not what ran. A compose file says what would be
     * started. The distinction survives in the fact's own words and is routinely lost in the sentence.
     */
    claim: /\b(runs? (on|in|every|nightly|daily)|is deployed to|deploys? to|executes? (on|when)|is scheduled)\b/i,
    /*
     * A `declares` fact licenses this **only when it names a trigger**, and the restriction is the whole
     * correctness of the widening.
     *
     * A workflow that declares `on: push` has stated what it runs on, and an answer saying so is reading
     * the repository rather than guessing. A compose file that declares three services has stated nothing
     * about when anything runs, and licensing the claim from its mere existence would let "the api service
     * is deployed to production nightly" through on a file that says neither word.
     */
    licensedBy: ['workflow', 'handles-route', 'artifact-ordering'],
    licensedByConcept: ['declares'],
    /*
     * `workflow` is deliberately **not** in this concept.
     *
     * It matched the word inside `.github/workflows/ci.yml` — a *path* — so every repository holding a
     * workflow file licensed every claim about what runs nightly. The tokens that survived are the ones a
     * trigger element is actually named with, and the battery holds that path as a negative control.
     */
    concept: /(trigger|schedule|cron|on push)/i,
    needs: 'a recorded workflow, or an artefact that declares the trigger it runs on',
  },
];

export interface EntailmentReport {
  /** Sentences that made a claim the facts do not license. */
  readonly unsupported: readonly ClaimFinding[];
  /** Sentences that made an allowed inference and said so. Reported for observability, never a failure. */
  readonly inferred: readonly ClaimFinding[];
}

/**
 * Checks one answer's claims against the *kinds* of fact it was given.
 *
 * Returns findings rather than a verdict: whether an unsupported claim makes an answer ungrounded is
 * `checkGrounding`'s decision, and keeping that in one place means there is still exactly one function
 * that says what a verdict is.
 */
export function checkEntailment(answer: string, projection: ContextProjection): EntailmentReport {
  const predicates = new Set(projection.facts.map((fact) => fact.predicate));

  const unsupported: ClaimFinding[] = [];
  const inferred: ClaimFinding[] = [];

  for (const sentence of sentencesOf(answer)) {
    // A sentence reporting what was *not* established is the honest form, not a claim to adjudicate.
    if (DISCLAIMING.test(sentence)) {
      continue;
    }

    for (const rule of RULES) {
      if (!rule.claim.test(sentence)) {
        continue;
      }

      /*
       * An instruction to the reader is not a claim about the repository.
       *
       * "Start with `routes.ts`" and "the workflow starts with `routes.ts`" share a verb and say entirely
       * different things: the first is a recommendation and the second asserts an order. A live run
       * flagged the recommendation, which is a guard punishing an answer for being helpful. The mood is
       * the discriminator, and in English the imperative is the one with no subject in front of the verb.
       */
      if (rule.kind === 'execution-order' && /^(start|begin|read|open|look|try|see)\b/i.test(sentence)) {
        break;
      }

      const licensed =
        rule.kind === 'absence-as-nonexistence'
          ? false
          : rule.licensedBy.some((predicate) => predicates.has(predicate)) || mentionsLicence(rule, projection.facts);

      if (licensed) {
        break;
      }

      const finding: ClaimFinding = {
        sentence: sentence.trim(),
        kind: rule.kind,
        strength: HEDGE.test(sentence) ? 'inferred' : 'unsupported',
        detail: `the facts carry no ${rule.needs}`,
      };

      (finding.strength === 'inferred' ? inferred : unsupported).push(finding);

      break;
    }
  }

  return { unsupported, inferred };
}

/**
 * The rules that have to look at fact *content* rather than only at predicate kinds.
 *
 * A repository with real authentication names it in a route path, a role annotation or a middleware
 * member, and those reach the facts as text rather than as a distinct predicate. So the concept is looked
 * for — but **only inside facts of a licensing kind**, and that restriction is the whole correctness of
 * the mechanism.
 *
 * Without it the check is circular. The profile claims an `authentication` domain from a secret-shaped
 * environment variable name, and that claim is emitted as a `characterised-as` fact; searching all facts
 * for the word then found the derivation and used it to license the very sentence the derivation was too
 * weak to support. A `reads-env JWT_SECRET` is the credential; a `has-role Middleware: requireAuth` is the
 * flow; only the second may license the claim.
 *
 * Two rules use it. `secrets-as-authentication` needs the concept because authentication reaches the facts
 * as words rather than as a predicate; `configuration-as-runtime` needs it because a `declares` fact
 * exists for *every* artefact and only one that names a trigger says anything about when something runs.
 */
function mentionsLicence(rule: Rule, facts: readonly Fact[]): boolean {
  const { concept } = rule;

  if (concept === undefined) {
    return false;
  }

  const gated = rule.licensedByConcept ?? rule.licensedBy;

  return facts.some((fact) => gated.includes(fact.predicate) && concept.test(factLine(fact)));
}

/**
 * The answer as sentences.
 *
 * Split on terminal punctuation followed by a space and a capital, which keeps `v1.2` and `e.g.` inside
 * their sentence. A citation bracket at the end of a sentence stays attached to it, because the rules
 * never look at citations and removing them would cost a pass over the text.
 */
function sentencesOf(answer: string): readonly string[] {
  return answer
    .split(/(?<=[.!?])\s+(?=[A-Z`"'\[])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

/** One finding as the line a diagnostic carries. */
export function describeClaim(finding: ClaimFinding): string {
  return `${finding.kind}: ${finding.detail}`;
}

/** Every fact predicate the projection carried, for a caller reporting why a claim was rejected. */
export function predicatesOf(facts: readonly Fact[]): readonly string[] {
  return [...new Set(facts.map((fact) => fact.predicate))].sort();
}
