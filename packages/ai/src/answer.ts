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
  correctionFor,
  fixedReservedTokens,
  promptBreakdown,
  reservedTokens,
  type PromptBreakdown,
} from './prompt.js';
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

export interface Answer {
  readonly question: string;
  readonly subject: ContextRequest;
  readonly text: string;
  /** The facts the answer referred to, resolved, so a consumer can display the evidence. */
  readonly citations: readonly Citation[];
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
   * Why a correction ran, in the diagnostics' own words. Empty where none did.
   *
   * Kept even when the correction *succeeded*, because "this answer was rewritten once, for these reasons"
   * is information about the model's first instinct that a reader of a repository assistant should have. It
   * is not a warning: `verdict` says whether the answer that was returned is sound.
   */
  readonly corrections: readonly string[];
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
     * The correction instruction, present only on the one rewrite an answer may receive.
     *
     * Its being a single mutable variable rather than a list is the bound: the loop below sets it exactly
     * once, in a branch guarded by `attempts === 1`, so there is no state in which a third generation can
     * be reached. That is deliberately stronger than a counter compared against a constant — a loop whose
     * termination depends on arithmetic is a loop somebody can widen by changing the arithmetic.
     */
    let correction: string | undefined;
    let attempts = 0;
    let corrections: readonly string[] = [];
    /** The first attempt, kept so the better of the two can be returned. See `saferOf`. */
    let first: { readonly text: string; readonly report: GroundingReport } | null = null;
    let report: GroundingReport;

    /*
     * retrieval → generation → verification → (one bounded correction) → verification → return.
     *
     * **The outer loop runs at most twice and the second pass is not a retry.** A retry sends the same
     * prompt again and hopes; this sends the same *facts* with the failed sentences named and the reason
     * each failed, which is a different request. The distinction matters because the failure being
     * corrected is not randomness — a model that wrote "authentication works through `set_secret.py`" will
     * write it again from the same prompt, and will not write it again from a prompt that says that sentence
     * was rejected because no fact records an authentication mechanism.
     *
     * **It is not an agent loop, and the shape is what guarantees that.** There is no evaluation of whether
     * another pass would help, no budget of attempts to spend, and no recursion: one correction, then the
     * safer of the two answers, with the grounding warning intact if it is still unsound.
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
          ...(correction === undefined ? {} : { correction }),
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
          });
        }
      }

      yield { type: 'status', phase: 'verifying' };

      report = checkGrounding(text, projection);

      // A sound answer returns immediately: a supported first pass must cost nothing extra, or the
      // correction has made every answer slower to fix the ones that were wrong.
      if (attempts > 1 || !worthCorrecting(report)) {
        break;
      }

      first = { text, report };
      corrections = reasonsFor(report);

      // The first answer has already been streamed, so a consumer holding those deltas is holding prose
      // the pipeline has rejected. Telling it to discard is the only honest option.
      yield { type: 'restart', reasons: corrections };
      yield { type: 'status', phase: 'correcting' };

      correction = correctionFor({
        answer: text,
        fabricated: report.fabricatedIdentifiers,
        unsupportedTerms: report.unsupportedTerms,
        unknownCitations: report.unknownCitations,
        claims: report.unsupportedClaims.map((finding) => ({
          sentence: finding.sentence,
          kind: finding.kind,
          detail: finding.detail,
        })),
      });
    }

    /*
     * The safer of the two, where two exist.
     *
     * A rewrite that still fails is not automatically an improvement, and a reader is owed whichever answer
     * makes fewer unsupported claims. Where the original wins, it is re-streamed after a second `restart`
     * so a consumer's screen and the returned answer agree — a `complete` carrying text a consumer never
     * received would be a silent disagreement between the two.
     */
    if (first !== null) {
      const safer = saferOf(first, { text, report });

      if (safer.text !== text) {
        yield {
          type: 'restart',
          reasons: ['the rewrite made no fewer unsupported claims, so the original answer is returned'],
        };
        yield { type: 'delta', text: safer.text };
      }

      text = safer.text;
      report = safer.report;
    }

    // The answer is returned even when the guard rejects it, carrying the verdict and the fabrications.
    // Withholding it would hide the evidence of the failure, and a caller that wants to suppress an
    // ungrounded answer can — it has the verdict.
    yield {
      type: 'complete',
      answer: {
        question: request.question,
        subject: request.subject,
        text,
        citations: report.citations,
        verdict: report.verdict,
        fabricatedIdentifiers: report.fabricatedIdentifiers,
        unsupportedTerms: report.unsupportedTerms,
        unknownCitations: report.unknownCitations,
        diagnostics: report.diagnostics,
        grounding: summarise(projection, lastBreakdown, plan, state),
        attempts,
        corrections,
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
 * Whether a rejected answer is worth one rewrite.
 *
 * **Only a failure the model can act on.** A fabricated identifier, a name no fact carries, a citation that
 * does not resolve and a sentence whose claim the facts do not license are all things the model wrote and
 * can write differently from the same evidence — so each is worth naming and asking again. `unverifiable` is
 * not: it means the answer cited nothing, which the reminder already asks for on every attempt, and
 * spending a whole second generation on a formatting habit would double the latency of every uncited answer
 * for no gain in what it claims.
 */
function worthCorrecting(report: GroundingReport): boolean {
  return (
    report.fabricatedIdentifiers.length > 0 ||
    report.unsupportedTerms.length > 0 ||
    report.unknownCitations.length > 0 ||
    report.unsupportedClaims.length > 0
  );
}

/** The failures a correction is being asked to fix, in the diagnostics' own words. */
function reasonsFor(report: GroundingReport): readonly string[] {
  return report.diagnostics
    .filter((entry) => entry.kind !== 'no-citations')
    .map((entry) => (entry.subject === '' ? entry.detail : `${entry.subject}: ${entry.detail}`));
}

/**
 * How much of the original an acceptable rewrite must keep.
 *
 * **The bound that stops a correction from becoming a truncation.** A rewrite has a trivially available way
 * to make zero unsupported claims: say almost nothing. That answer scores perfectly on every check in this
 * file and is worse for a reader than the flawed one it replaced — which is the failure §10 of the milestone
 * forbids in as many words. Two fifths is generous: a genuine correction of three sentences in a page loses
 * a few percent, and only a collapse into a summary trips it.
 */
const DETAIL_FLOOR = 0.4;

/**
 * Which of two answers is the safer thing to return.
 *
 * Two conditions, and the order matters. A rewrite that collapsed into a summary is rejected whatever it
 * scores, because a shorter answer is not a correction; among answers that kept their substance, the one
 * making fewer unsupported claims wins.
 *
 * Failures are counted rather than judged, over the four categories the guard adjudicates. Ties go to the
 * **corrected** answer, because it was written knowing what had failed and the first was not.
 */
function saferOf<T extends { readonly text: string; readonly report: GroundingReport }>(first: T, second: T): T {
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
