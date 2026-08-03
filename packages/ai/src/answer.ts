import type { ContextRequest } from '@traceiq/context';

import { TIER_TOKENS, estimatingCounter, smallerTier, tierForWindow, type BudgetTier } from './budget.js';
import { acquire, type ContextSource } from './context-source.js';
import { AiError } from './errors.js';
import type { Citation, ContextProjection, Omission } from './facts.js';
import { checkGrounding, type GroundingDiagnostic, type GroundingReport, type GroundingVerdict } from './grounding.js';
import type { LanguageModel, TokenUsage } from './model.js';
import { focusOf, intentOf, scopeOf } from './intent.js';
import {
  assemble,
  fixedReservedTokens,
  promptBreakdown,
  recoveryInstruction,
  reservedTokens,
  type PromptBreakdown,
} from './prompt.js';
import { finalise } from './finalize.js';
import { NO_RECOVERY, recoveryFor, type RecoveryPlan } from './recovery.js';
import { project, subjectOf } from './projection.js';
import { deriveProfile, subsystemsOf } from './profile.js';
import { deriveIdentity, type RepositoryIdentity } from './identity.js';
import { planFor, type AnswerPlan } from './plan.js';
import { questionGuidance, repositoryGuidance, strategyFor, type ExplanationStrategy } from './strategy.js';
import type { RepositoryContext } from '@traceiq/context';
import type { AnswerEvent, GroundingSummary } from './stream.js';
import { type ConversationHistory } from './conversation.js';
import { NO_STATE, deriveState, renderState, type ConversationState } from './memory.js';

/**
 * The one public entry point.
 *
 * **Constructor injection, nothing else.** A `ContextSource` and a `LanguageModel`. There is no registry,
 * no provider name, no configuration that selects a vendor — the application composition root instantiates
 * a provider, takes a model from it, and passes that model here. Which is why this file, and this package,
 * name no vendor at all.
 *
 * ```ts
 * const answerer = new RepositoryAnswerer(contextBuilder, model);
 *
 * for await (const event of answerer.answer({ question, subject })) { … }
 * ```
 */
export interface AnswerRequest {
  readonly question: string;
  /**
   * What to answer about, already resolved.
   *
   * **This layer does not find subjects.** Turning free text into a subject is repository search, which
   * belongs to the Explorer and reaches this layer only as a `ContextRequest` a caller already chose.
   * Accepting a resolved subject is what keeps repository intelligence out of the AI layer entirely.
   */
  readonly subject: ContextRequest;
  readonly history?: ConversationHistory;
  /** Defaults to the largest tier the model's window can hold with room to answer. */
  readonly tier?: BudgetTier;
  readonly maxOutputTokens?: number;
}

/**
 * What a reader is being shown, in one word.
 *
 * **Four values rather than the guard's three, and the difference is what the pipeline now guarantees.**
 * `GroundingVerdict` describes a *text*: whether these words are supported by these facts. It has an
 * `ungrounded` value because a text can be unsupported. An `AnswerStatus` describes what is *returned*,
 * and unsupported prose is no longer returned — safe finalisation removes it — so there is no
 * `ungrounded` here and its absence is the guarantee rather than an omission.
 */
export const ANSWER_STATUSES = [
  /** Verified on the first attempt. Everything shown is supported and cited. */
  'grounded',
  /**
   * The first attempt made a claim its evidence did not license; targeted retrieval found the evidence,
   * and the second attempt verified.
   *
   * Reported separately from `grounded` because it is the same guarantee reached at twice the cost, and a
   * reader watching a slow answer is owed the reason. It is not a warning about the text.
   */
  'grounded-after-recovery',
  /**
   * Verification still failed after recovery, so the unsupported statements were removed.
   *
   * What is shown is what survived, and it verifies. What is *not* shown is reported in the diagnostics.
   * This is the honest outcome for a question the graph half-answers, and it is a first-class result
   * rather than a failure: a shorter true answer is the product working.
   */
  'limited-evidence',
  /** Nothing was fabricated and nothing was cited either, so no claim could be checked. */
  'unverifiable',
] as const;

export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/** What one bounded evidence-recovery pass did, where one ran. */
export interface RecoveryReport {
  /** Fact parts the retrieval was widened to. */
  readonly parts: readonly string[];
  /** Why each was asked for, in the verifier's own words. */
  readonly reasons: readonly string[];
  /** How many facts and prompt tokens the second projection carried that the first did not. */
  readonly addedFacts: number;
  readonly addedTokens: number;
  /** Statements removed by safe finalisation because they still had no evidence. */
  readonly removedStatements: number;
}

export interface Answer {
  readonly question: string;
  readonly subject: ContextRequest;
  readonly text: string;
  /** The facts the answer referred to, resolved, so a consumer can display the evidence. */
  readonly citations: readonly Citation[];
  /**
   * What is being shown, and how it got here. The field a consumer renders.
   *
   * Never `ungrounded`: an answer that could not be supported has had the unsupported part removed before
   * it reaches here. See `ANSWER_STATUSES` and `finalise`.
   */
  readonly status: AnswerStatus;
  /** The guard's verdict on the text as returned. `grounded` or `unverifiable` by construction. */
  readonly verdict: GroundingVerdict;
  /** Identifiers the answer named that no fact contained. Empty unless the verdict is `ungrounded`. */
  readonly fabricatedIdentifiers: readonly string[];
  /** Package, framework and dependency names the answer claimed that no fact carried. */
  readonly unsupportedTerms: readonly string[];
  readonly unknownCitations: readonly string[];
  /** Why the verdict is what it is, in words a reader can act on. */
  readonly diagnostics: readonly GroundingDiagnostic[];
  readonly grounding: GroundingSummary;
  /**
   * How many generations produced this answer: `1` normally, `2` where one correction ran.
   *
   * **Reported because a correction is the most expensive thing this pipeline can do and it must be
   * visible.** It doubles latency on a slow provider, so an operator looking at a three-minute answer needs
   * to know whether the model was slow or the answer was wrong. It is also the field a test asserts to hold
   * the bound: an answer that verified must never be worth `2`.
   */
  readonly attempts: number;
  /**
   * What the first attempt got wrong, in the diagnostics' own words. Empty where it got nothing wrong.
   *
   * Kept even when the second attempt succeeded, because "the model's first instinct did not verify, for
   * these reasons" is information about this answer. It is not a warning: `status` says what is being
   * shown.
   */
  readonly corrections: readonly string[];
  /** What the one bounded recovery pass retrieved and what it cost. `null` where none ran. */
  readonly recovery: RecoveryReport | null;
  readonly model: string;
  readonly stopReason: string;
  /**
   * What the provider charged, where it reports it.
   *
   * Carried through unchanged rather than recomputed from the estimator: a provider that counts exactly
   * is the only authority on its own usage, and a figure this layer derived would quietly disagree with
   * the one a user is billed for. Either field is `null` where the provider said nothing.
   */
  readonly usage: TokenUsage;
}

export class RepositoryAnswerer {
  readonly #source: ContextSource;
  readonly #model: LanguageModel;

  constructor(source: ContextSource, model: LanguageModel) {
    this.#source = source;
    this.#model = model;
  }

  /**
   * Answers one question, streaming.
   *
   * The stages are fixed: acquire → project → assemble → generate → guard. Everything before `generate` is
   * deterministic, so an unexpected answer can be investigated by re-running the projection and comparing
   * its digest.
   */
  async *answer(request: AnswerRequest, signal?: AbortSignal): AsyncIterable<AnswerEvent> {
    const description = this.#model.describe();
    const counter = this.#model.tokens ?? estimatingCounter;

    // Emitted before the work rather than after it, so a consumer names the stage it is waiting on
    // rather than the stage that just finished. Acquiring a repository context on a large graph is
    // seconds of work, and it is the first thing a user waits through.
    yield { type: 'status', phase: 'acquiring-context' };

    const context = acquire(this.#source, request.subject);

    /*
     * The conversation, compressed before anything is budgeted against it.
     *
     * **This is the whole of the long-session fix, and its position in the method is the point.** The
     * turns used to be reserved for and replayed verbatim, so three detailed answers left no room for
     * the facts a fourth question needed and the answerer refused a question the graph could answer.
     * What reaches the prompt now is a bounded state: what the session covered, what it is about, what
     * it has not reached. The turns themselves go no further than this line.
     */
    const state = stateOf(context, request.history);
    const conversation = renderState(state);

    yield { type: 'status', phase: 'projecting' };

    // What the question is about, decided from the question alone and used only to order the
    // supplement. The core the answer rests on is the same whichever way this lands.
    const intent = intentOf(request.question);

    /*
     * How the repository should be explained, decided before the projection so its cost can be
     * reserved.
     *
     * The profile is derived here *and* inside `project`, from the same context by the same pure
     * function, so the two cannot disagree — and the alternative was to project first and then discover
     * that the guidance no longer fitted the budget the projection had already spent.
     */
    const plan = planOf(context, request.question, state);
    const { strategy } = plan;
    const repository = repositoryGuidance(deriveProfile(context), identityOrNull(context));
    const guidance = `${repository}\n${questionGuidance(strategy, plan)}`;

    // The half of the reservation that no question changes. The stable core is budgeted against this
    // alone, so two questions about one repository render the same prefix. See `coreReserved`.
    const coreReserved = fixedReservedTokens({ guidance: repository, count: (text) => counter.count(text) });

    const reserved = reservedTokens({
      question: request.question,
      // The state, never the turns. Bounded by construction, so this figure does not grow with the
      // session and the check below cannot start failing because the reader kept asking.
      ...(conversation === '' ? {} : { conversation }),
      count: (text) => counter.count(text),
      guidance,
    });

    let tier = request.tier ?? tierForWindow(description.contextWindow);

    if (reserved >= TIER_TOKENS[tier]) {
      throw new AiError(
        'budget-not-satisfiable',
        `the question and conversation already need ${reserved} tokens, which leaves no room for facts at the '${tier}' tier`,
      );
    }

    let projection = project(context, {
      tier,
      reserved,
      coreReserved,
      counter,
      intent,
      parts: plan.parts,
      allocation: plan.allocation,
      names: guidanceNames(plan),
    });

    if (projection.facts.length === 0) {
      throw new AiError(
        'budget-not-satisfiable',
        `no fact fits the '${tier}' tier after reserving ${reserved} tokens for the question`,
      );
    }

    let text = '';
    /** The accounting for the prompt actually sent, so `complete` reports the same figures. */
    let lastBreakdown: PromptBreakdown | null = null;
    let stopReason = 'complete';
    let usage: TokenUsage = { promptTokens: null, outputTokens: null };

    /**
     * The regeneration instruction, present only on the one second attempt an answer may receive.
     *
     * Its being a single mutable variable rather than a list is the bound: the loop below sets it exactly
     * once, in a branch guarded by the attempt count, so there is no state in which a third generation can
     * be reached. That is deliberately stronger than a counter compared against a constant — a loop whose
     * termination depends on arithmetic is a loop somebody can widen by changing the arithmetic.
     */
    let regeneration: string | undefined;
    let attempts = 0;
    let corrections: readonly string[] = [];
    let recovery: RecoveryPlan = NO_RECOVERY;
    /** What the second projection carried that the first did not. Zero where no recovery ran. */
    let addedFacts = 0;
    let addedTokens = 0;
    /** The first attempt, with the projection it was grounded against. See `saferOf`. */
    let first: Candidate | null = null;
    let report: GroundingReport;

    /*
     * intent → retrieve → generate → verify → (one bounded evidence recovery) → verify → finalise.
     *
     * **The second pass is a different retrieval, not a second try at the same one.** Its predecessor sent
     * the model its own rejected answer and the *same facts*, and asked for something better — which for a
     * sentence rejected as unsupported has two honest outcomes, both bad: say less, or say the same thing
     * in words the guard does not recognise. Both were observed in production, and the UI reported the
     * result as "rewritten once" and still ungrounded.
     *
     * The reason a claim is rejected is that **no fact of the licensing kind was in the projection**, and
     * whether the graph holds one is a separate question from whether the budget reached it. So the
     * failure is translated back into a retrieval request — see `recoveryFor` — the projection is rebuilt
     * with those families lifted, at the same tier and against the same budget, and the model answers
     * again from evidence it did not have. Where the failure is one retrieval cannot fix, no second pass
     * runs at all.
     *
     * **It is not an agent loop, and the shape is what guarantees that.** There is no evaluation of whether
     * another pass would help, no budget of attempts to spend, and no recursion: one recovery, then the
     * safer of the two answers, then deterministic removal of whatever still does not verify.
     */
    for (;;) {
      attempts += 1;
      // The second attempt is a fresh answer rather than a continuation. Keeping the first attempt's prose
      // in `text` would splice the two together into something neither pass wrote.
      text = '';

      // A provider may reject a prompt this layer estimated as fitting. Stepping down a named tier and
      // re-projecting is deterministic, and the estimator's error is the reason it is needed: the default
      // counter is a measured ratio, not an exact tokeniser.
      for (;;) {
        const shared = {
          question: request.question,
          projection,
          ...(state.turns === 0 ? {} : { state }),
          model: description,
          strategy,
          plan,
          ...(regeneration === undefined ? {} : { recovery: regeneration }),
        };

        const messages = assemble(shared);

        // Now that the messages exist, the prompt can be accounted for exactly rather than estimated.
        lastBreakdown = promptBreakdown(shared, counter);

        yield { type: 'grounding', grounding: summarise(projection, lastBreakdown, plan, state) };

        // The long silence starts here. Everything above is milliseconds of deterministic work; what
        // follows is the provider evaluating the whole prompt before it emits a single token, measured
        // at 89 seconds for a 4,087-token prompt on the reference stack.
        yield { type: 'status', phase: 'awaiting-model' };

        let announced = false;

        try {
          for await (const event of this.#model.generate(
            {
              messages,
              temperature: 0,
              ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
            },
            signal,
          )) {
            if (event.type === 'delta') {
              if (!announced) {
                announced = true;
                yield { type: 'status', phase: 'generating' };
              }

              text += event.text;
              yield { type: 'delta', text: event.text };
            } else if (event.type === 'end') {
              stopReason = event.stopReason;
              usage = event.usage;
            }
          }

          break;
        } catch (cause) {
          const smaller =
            cause instanceof AiError && cause.code === 'context-window-exceeded' && text === ''
              ? smallerTier(projection.tier as BudgetTier)
              : null;

          if (smaller === null) {
            throw cause instanceof AiError ? cause : new AiError('stream-interrupted', String(cause), { cause, partial: text });
          }

          tier = smaller;
          yield { type: 'status', phase: 're-projecting' };
          projection = project(context, {
            tier,
            reserved,
            coreReserved,
            counter,
            intent,
            parts: plan.parts,
            allocation: plan.allocation,
            names: guidanceNames(plan),
          });
        }
      }

      yield { type: 'status', phase: 'verifying' };

      report = checkGrounding(text, projection);

      /*
       * A sound answer returns immediately, and so does one nothing could be retrieved for.
       *
       * The first condition is the latency bound: a supported first pass must cost nothing extra, or
       * recovery has made every answer slower in order to fix the ones that were wrong. The second is the
       * one this milestone adds — a quality verdict and a claim of nonexistence are licensed by no fact in
       * any projection, so a second retrieval would fetch nothing that could change the verdict and the
       * whole generation would be spent proving that. Those answers go straight to finalisation, which
       * removes the offending sentence in microseconds.
       */
      const plan_ = attempts > 1 ? NO_RECOVERY : recoveryFor(report);

      if (attempts > 1 || plan_.parts.length === 0) {
        break;
      }

      first = { text, report, projection, breakdown: lastBreakdown };
      corrections = reasonsFor(report);
      recovery = plan_;

      // The first answer has already been streamed, so a consumer holding those deltas is holding prose
      // the pipeline has rejected. Telling it to discard is the only honest option.
      yield { type: 'restart', reasons: corrections };
      yield { type: 'status', phase: 'recovering' };

      /*
       * The second projection: same context, same tier, same budget — different composition.
       *
       * **Bounded by construction rather than by a check.** `recovery` lifts the named families to the
       * front of the priority floor and raises their per-family limit; it does not touch the tier, the
       * reservation or the caps, so the prompt this produces is the same size as the one that failed. What
       * changes is which facts are in it.
       */
      const before = new Set(projection.facts.map(tripleOf));
      const previousTokens = projection.tokens;

      projection = project(context, {
        tier,
        reserved,
        coreReserved,
        counter,
        intent,
        parts: plan.parts,
        allocation: plan.allocation,
        names: guidanceNames(plan),
        recovery: recovery.parts,
      });

      addedFacts = projection.facts.filter((fact) => !before.has(tripleOf(fact))).length;
      addedTokens = projection.tokens - previousTokens;

      regeneration = recoveryInstruction({
        fabricated: report.fabricatedIdentifiers,
        unsupportedTerms: report.unsupportedTerms,
        recovered: addedFacts > 0,
        claims: recovery.claims.map((finding) => ({
          sentence: finding.sentence,
          kind: finding.kind,
          detail: finding.detail,
        })),
      });
    }

    /*
     * The safer of the two, where two exist.
     *
     * A second attempt that still fails is not automatically an improvement, and a reader is owed whichever
     * answer makes fewer unsupported claims. Each candidate carries **its own projection**, because after
     * evidence recovery the two were grounded against different fact sets — returning the first attempt's
     * prose beside the second attempt's evidence list would show a reader citations for an answer that was
     * not written from them.
     *
     * Where the first wins it is re-streamed after a `restart`, so a consumer's screen and the returned
     * answer agree.
     */
    if (first !== null) {
      const safer = saferOf(first, { text, report, projection, breakdown: lastBreakdown });

      if (safer.text !== text) {
        yield {
          type: 'restart',
          reasons: ['the second attempt made no fewer unsupported claims, so the first answer is returned'],
        };
        yield { type: 'delta', text: safer.text };
      }

      text = safer.text;
      report = safer.report;
      projection = safer.projection;
      lastBreakdown = safer.breakdown;
    }

    /*
     * Safe finalisation: whatever still does not verify is removed, deterministically.
     *
     * **The rule this enforces is that unsupported prose is never returned.** Before it, a second failure
     * produced the whole answer with an `ungrounded` badge and a diagnostics list of rejected strings, and
     * left the reader to find the unsound sentences themselves. What survives here is decided by the
     * verifier that rejected it, sentence by sentence, with no third model call — the model has by this
     * point been wrong twice about what its evidence supports, and asking it a third time would produce a
     * third thing to verify.
     */
    yield { type: 'status', phase: 'finalising' };

    const finalised = finalise(text, report, projection);

    if (finalised.text !== text) {
      yield {
        type: 'restart',
        reasons: [
          `${finalised.removedSentences} statement${finalised.removedSentences === 1 ? '' : 's'} the facts do not establish ${
            finalised.removedSentences === 1 ? 'was' : 'were'
          } removed`,
        ],
      };
      yield { type: 'delta', text: finalised.text };
    }

    /*
     * The faults are reported from the answer that had them, and the citations from the one returned.
     *
     * **Two reports, deliberately, because they answer two different questions.** `finalised.report`
     * describes the text a reader is looking at: its citations, and the fact that nothing in it is
     * unsupported. But a `limited-evidence` answer is shorter than what the model wrote, and a reader
     * owed an explanation for that cannot get one from a report about the text that survived — it names
     * no fabrication, because the sentence naming it was removed. Reading the faults from the rejected
     * report is what keeps the removal visible instead of silent.
     */
    const rejected = report;

    text = finalised.text;
    report = finalised.report;

    yield {
      type: 'complete',
      answer: {
        question: request.question,
        subject: request.subject,
        text,
        citations: report.citations,
        status: statusOf(report.verdict, attempts, finalised.reduced),
        verdict: report.verdict,
        fabricatedIdentifiers: rejected.fabricatedIdentifiers,
        unsupportedTerms: rejected.unsupportedTerms,
        unknownCitations: rejected.unknownCitations,
        diagnostics: rejected.diagnostics,
        grounding: summarise(projection, lastBreakdown, plan, state),
        attempts,
        corrections,
        recovery:
          recovery.parts.length === 0
            ? null
            : {
                parts: recovery.parts,
                reasons: recovery.reasons,
                addedFacts,
                addedTokens,
                removedStatements: finalised.removedSentences,
              },
        model: description.id,
        stopReason,
        usage,
      },
    };
  }

  /** The projection alone, without generating. For inspecting exactly what a model would be shown. */
  projectionFor(request: AnswerRequest): ContextProjection {
    const counter = this.#model.tokens ?? estimatingCounter;
    const context = acquire(this.#source, request.subject);
    const state = stateOf(context, request.history);
    const conversation = renderState(state);
    const plan = planOf(context, request.question, state);

    return project(context, {
      intent: intentOf(request.question),
      parts: plan.parts,
      allocation: plan.allocation,
      names: guidanceNames(plan),
      tier: request.tier ?? tierForWindow(this.#model.describe().contextWindow),
      reserved: reservedTokens({
        question: request.question,
        ...(conversation === '' ? {} : { conversation }),
        count: (text) => counter.count(text),
        guidance: `${repositoryGuidance(deriveProfile(context), identityOrNull(context))}\n${questionGuidance(plan.strategy, plan)}`,
      }),
      counter,
    });
  }

  /** How this question would be answered, without projecting or generating. For inspection and tests. */
  strategyFor(request: AnswerRequest): ExplanationStrategy {
    return strategyOf(acquire(this.#source, request.subject), request.question);
  }

  /** What this question needs, without projecting or generating. For inspection and tests. */
  planFor(request: AnswerRequest): AnswerPlan {
    const context = acquire(this.#source, request.subject);

    return planOf(context, request.question, stateOf(context, request.history));
  }

  /** What the conversation has established, without projecting or generating. For inspection and tests. */
  stateFor(request: AnswerRequest): ConversationState {
    return stateOf(acquire(this.#source, request.subject), request.history);
  }
}

/**
 * The conversation, compressed against the repository it is about.
 *
 * **Derived rather than carried, which is what keeps a long session reproducible.** Nothing accumulates
 * between turns: the caller passes the transcript it has, and this reduces it the same way every time,
 * so replaying a forty-turn session produces the same forty prompts. A stored state would be a second
 * source of truth about a conversation whose first source of truth is the transcript.
 *
 * A context with no repository overview has no identity to match topic names against, so the state is
 * empty and the prompt carries no session block. That is the honest degradation: a topic list that
 * could not be checked against anything would be free text asserting what a conversation covered.
 */
function stateOf(context: RepositoryContext, history?: ConversationHistory): ConversationState {
  if (history === undefined || history.turns.length === 0) {
    return NO_STATE;
  }

  return deriveState(history, context.primary.type === 'repository' ? deriveIdentity(context) : null);
}

/**
 * The plan for one question about one context.
 *
 * **Everything the answer is shaped by, derived in one place.** The identity says what the repository
 * is for and what matters in it, the planner decides what this question needs from that, and the
 * strategy it carries decides how deep the answer may go. The projection, the prompt and the reported
 * shape all read this same object, so what the model is told and what it is shown cannot diverge.
 *
 * A context with no repository overview — a symbol, a file — has no identity to plan from, so the
 * strategy is derived directly and the plan is skipped. That is the honest degradation: the subject
 * *is* the answer there, and a repository-wide narrative would be the wrong frame for it.
 */
function planOf(context: RepositoryContext, question: string, state: ConversationState): AnswerPlan {
  const identity = deriveIdentity(context);

  return planFor({
    identity,
    question,
    kind: context.kind,
    // Omitted rather than passed empty, so a first turn and a turn whose session established nothing
    // produce the same cache key and the same plan.
    ...(state.turns === 0 ? {} : { state }),
  });
}

/** The identity where one could be derived, for the repository-wide half of the guidance. */
function identityOrNull(context: RepositoryContext): RepositoryIdentity | undefined {
  return context.primary.type === 'repository' ? deriveIdentity(context) : undefined;
}

function strategyOf(context: RepositoryContext, question: string): ExplanationStrategy {
  const profile = deriveProfile(context);
  const subsystems = subsystemsOf(profile);
  const input = { question, kind: context.kind, subsystems };
  const scope = scopeOf(input);

  /*
   * A resolved context focuses on its own subject, not on whatever word of the question happened to
   * match. The caller already turned this question into one declaration, one file or one route, and
   * that identifier is a better statement of what the answer is about than any keyword could be.
   */
  const focus = scope === 'entity' ? (subjectOf(context) ?? focusOf(input)) : focusOf(input);

  return { ...strategyFor({ profile, scope, intent: intentOf(question), focus }) };
}

/**
 * One generation's output, with everything needed to return it instead of the other one.
 *
 * The projection is part of the candidate because evidence recovery replaces it: two attempts at one
 * question are grounded against two different fact sets, and a returned answer must be reported beside the
 * evidence it was actually written from.
 */
interface Candidate {
  readonly text: string;
  readonly report: GroundingReport;
  readonly projection: ContextProjection;
  readonly breakdown: PromptBreakdown | null;
}

/**
 * What the reader is being shown, from what happened to get here.
 *
 * `ungrounded` is unreachable: `finalise` removed anything the report rejected, and the report here
 * describes the text after that removal. A reduction is reported as `limited-evidence` whatever the
 * surviving text verifies as — the fact that something was removed is the more important thing to say.
 */
function statusOf(verdict: GroundingVerdict, attempts: number, reduced: boolean): AnswerStatus {
  if (reduced) {
    return 'limited-evidence';
  }

  if (verdict === 'unverifiable') {
    return 'unverifiable';
  }

  return attempts > 1 ? 'grounded-after-recovery' : 'grounded';
}

/**
 * The names this plan's guidance will print, so the permitted set covers what the model is told to say.
 *
 * **The route and the ranking, and nothing else.** Both are the guidance naming specific things and
 * instructing the model to name them back; both come out of `RepositoryIdentity`, which is derived from
 * the graph, so neither can introduce a string the repository did not produce. Everything else the
 * guidance prints — a section title, a need line, a depth rule — is prose about the answer rather than a
 * name from the repository.
 */
function guidanceNames(plan: AnswerPlan): readonly string[] {
  return [
    ...plan.navigation.map((step) => step.target),
    ...plan.components.map((component) => component.name),
  ];
}

/**
 * A fact as the triple that identifies it, for counting what one projection holds and another does not.
 *
 * The separator is written as an escape rather than as a literal byte: a raw NUL makes a source file
 * binary to `grep`, which would silently defeat the boundary audits this package relies on — the same
 * reasoning `digest` states, and the same mistake, caught by the same test.
 */
const SEPARATOR = '\u0000';

function tripleOf(fact: { readonly subject: string; readonly predicate: string; readonly object: string }): string {
  return [fact.subject, fact.predicate, fact.object].join(SEPARATOR);
}

/** The failures the second attempt is being asked to fix, in the diagnostics' own words. */
function reasonsFor(report: GroundingReport): readonly string[] {
  return report.diagnostics
    .filter((entry) => entry.kind !== 'no-citations')
    .map((entry) => (entry.subject === '' ? entry.detail : `${entry.subject}: ${entry.detail}`));
}

/**
 * How much of the original an acceptable second attempt must keep.
 *
 * **The bound that stops recovery from becoming a truncation.** A second attempt has a trivially available
 * way to make zero unsupported claims: say almost nothing. That answer scores perfectly on every check in
 * this file and is worse for a reader than the flawed one it replaced. Two fifths is generous: a genuine
 * correction of three sentences in a page loses a few percent, and only a collapse into a summary trips it.
 */
const DETAIL_FLOOR = 0.4;

/**
 * Which of two answers is the safer thing to return.
 *
 * Two conditions, and the order matters. A second attempt that collapsed into a summary is rejected
 * whatever it scores, because a shorter answer is not a correction; among answers that kept their
 * substance, the one making fewer unsupported claims wins.
 *
 * Failures are counted rather than judged, over the four categories the guard adjudicates. Ties go to the
 * **second** answer, because it was written knowing what had failed and with the evidence recovery
 * retrieved, and the first was written with neither.
 */
function saferOf<T extends Candidate>(first: T, second: T): T {
  const failures = (candidate: T): number =>
    candidate.report.fabricatedIdentifiers.length +
    candidate.report.unsupportedTerms.length +
    candidate.report.unknownCitations.length +
    candidate.report.unsupportedClaims.length;

  if (second.text.trim().length < first.text.trim().length * DETAIL_FLOOR) {
    return first;
  }

  return failures(second) <= failures(first) ? second : first;
}

function summarise(
  projection: ContextProjection,
  breakdown: PromptBreakdown | null = null,
  plan: AnswerPlan | null = null,
  state: ConversationState = NO_STATE,
): GroundingSummary {
  const omissions: readonly Omission[] = projection.omissions;

  return {
    kind: projection.kind,
    subject: projection.subject,
    factCount: projection.facts.length,
    coreCount: projection.coreCount,
    intent: projection.intent,
    shape:
      plan === null
        ? null
        : {
            type: projection.profile.type.value,
            scale: projection.profile.scale.scale,
            traits: projection.profile.traits.map((claim) => claim.trait),
            depth: plan.depth,
            focus: plan.focus,
            lead: plan.lead,
            need: plan.need,
            workflows: plan.workflows.length,
            components: plan.components.length,
            audience: plan.audience,
            confidence: plan.confidence,
            // The titles rather than the sections: a consumer wants to show the shape the answer was
            // asked to take, and the evidence lists behind each one are the planner's working.
            sections: plan.sections.map((section) => section.title),
            exclusions: plan.exclusions,
            unknowns: plan.unknowns,
            covered: plan.covered,
            allocation: plan.allocation,
            category: projection.identity?.category ?? 'unknown',
            evidence: {
              verdict: plan.sufficiency.verdict,
              concept: plan.sufficiency.concept,
              detail: plan.sufficiency.detail,
            },
            roles: plan.roles,
          },
    conversation:
      state.turns === 0
        ? null
        : {
            turns: state.turns,
            compressed: state.compressed,
            covered: state.covered.map((topic) => topic.name),
            focus: state.focus,
            continued: plan?.continues ?? false,
            remaining: state.remaining,
            level: state.level,
          },
    omissions,
    tier: projection.tier,
    tokens: projection.tokens,
    promptTokens: breakdown,
    digest: projection.digest,
  };
}
