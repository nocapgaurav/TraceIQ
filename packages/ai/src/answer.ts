import type { ContextRequest } from '@traceiq/context';

import { TIER_TOKENS, estimatingCounter, smallerTier, tierForWindow, type BudgetTier } from './budget.js';
import { acquire, type ContextSource } from './context-source.js';
import { AiError } from './errors.js';
import type { Citation, ContextProjection, Omission } from './facts.js';
import { checkGrounding, type GroundingVerdict } from './grounding.js';
import type { LanguageModel, TokenUsage } from './model.js';
import { intentOf } from './intent.js';
import { assemble, reservedTokens } from './prompt.js';
import { project } from './projection.js';
import type { AnswerEvent, GroundingSummary } from './stream.js';
import { NO_HISTORY, type ConversationHistory } from './conversation.js';

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
  readonly grounding: GroundingSummary;
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
    const history = request.history ?? NO_HISTORY;

    yield { type: 'status', phase: 'projecting' };

    const reserved = reservedTokens({
      question: request.question,
      ...(request.history === undefined ? {} : { history }),
      count: (text) => counter.count(text),
    });

    let tier = request.tier ?? tierForWindow(description.contextWindow);

    // What the question is about, decided from the question alone and used only to order the
    // supplement. The core the answer rests on is the same whichever way this lands.
    const intent = intentOf(request.question);

    if (reserved >= TIER_TOKENS[tier]) {
      throw new AiError(
        'budget-not-satisfiable',
        `the question and conversation already need ${reserved} tokens, which leaves no room for facts at the '${tier}' tier`,
      );
    }

    let projection = project(context, { tier, reserved, counter, intent });

    if (projection.facts.length === 0) {
      throw new AiError(
        'budget-not-satisfiable',
        `no fact fits the '${tier}' tier after reserving ${reserved} tokens for the question`,
      );
    }

    yield { type: 'grounding', grounding: summarise(projection) };

    let text = '';
    let stopReason = 'complete';
    let usage: TokenUsage = { promptTokens: null, outputTokens: null };

    // A provider may reject a prompt this layer estimated as fitting. Stepping down a named tier and
    // re-projecting is deterministic, and the estimator's error is the reason it is needed: the default
    // counter is a measured ratio, not an exact tokeniser.
    for (;;) {
      const messages = assemble({
        question: request.question,
        projection,
        ...(request.history === undefined ? {} : { history }),
        model: description,
      });

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
        projection = project(context, { tier, reserved, counter, intent });
        yield { type: 'grounding', grounding: summarise(projection) };
      }
    }

    yield { type: 'status', phase: 'verifying' };

    const report = checkGrounding(text, projection);

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
        grounding: summarise(projection),
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
    const history = request.history ?? NO_HISTORY;

    return project(context, {
      intent: intentOf(request.question),
      tier: request.tier ?? tierForWindow(this.#model.describe().contextWindow),
      reserved: reservedTokens({
        question: request.question,
        ...(request.history === undefined ? {} : { history }),
        count: (text) => counter.count(text),
      }),
      counter,
    });
  }
}

function summarise(projection: ContextProjection): GroundingSummary {
  const omissions: readonly Omission[] = projection.omissions;

  return {
    kind: projection.kind,
    subject: projection.subject,
    factCount: projection.facts.length,
    coreCount: projection.coreCount,
    intent: projection.intent,
    omissions,
    tier: projection.tier,
    tokens: projection.tokens,
    digest: projection.digest,
  };
}
