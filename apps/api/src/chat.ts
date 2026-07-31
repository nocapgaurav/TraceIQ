import type { ContextRequest } from '@traceiq/context';
import { AiError, BUDGET_TIERS, type Answer, type BudgetTier, type GroundingSummary } from '@traceiq/ai';

import { ApiError, badRequest, missingParameter } from './errors.js';

/**
 * The chat wire format, and the validation that produces it.
 *
 * **Nothing internal to the AI layer crosses this boundary.** A client sees a question, prose, citations
 * with their evidence, a verdict, what was omitted, what it cost and which model answered. It never sees a
 * `ContextProjection`, a `Fact` object, a prompt, or the fence the facts were rendered inside — those are
 * how an answer was produced, not what it is.
 *
 * The shape is chosen so a consumer can display the supporting evidence without asking a second question.
 */
export interface WireCitation {
  readonly factId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: string;
  /** Which capability established the fact. */
  readonly provenance: string;
}

export interface WireOmission {
  readonly part: string;
  readonly kept: number;
  readonly total: number;
}

export interface WireGrounding {
  readonly kind: string;
  readonly subject: string | null;
  readonly factCount: number;
  readonly tier: string;
  /** Prompt tokens the facts cost, as the model's counter measured them. */
  readonly tokens: number;
  /** Identity of the facts that grounded this answer. Two equal digests ground identically. */
  readonly digest: string;
  readonly omissions: readonly WireOmission[];
}

export interface WireAnswer {
  readonly question: string;
  readonly subject: ContextRequest;
  readonly text: string;
  readonly verdict: string;
  readonly citations: readonly WireCitation[];
  /** Identifiers the answer named that no fact contained. Empty unless the verdict is `ungrounded`. */
  readonly fabricatedIdentifiers: readonly string[];
  readonly unknownCitations: readonly string[];
  readonly grounding: WireGrounding;
  readonly model: string;
  readonly stopReason: string;
  readonly usage: { readonly promptTokens: number | null; readonly outputTokens: number | null };
}

export function wireGrounding(grounding: GroundingSummary): WireGrounding {
  return {
    kind: grounding.kind,
    subject: grounding.subject,
    factCount: grounding.factCount,
    tier: grounding.tier,
    tokens: grounding.tokens,
    digest: grounding.digest,
    omissions: grounding.omissions.map((omission) => ({
      part: omission.part,
      kept: omission.kept,
      total: omission.total,
    })),
  };
}

/** Flattens a citation: the fact's fields, not the fact object. */
export function wireAnswer(answer: Answer): WireAnswer {
  return {
    question: answer.question,
    subject: answer.subject,
    text: answer.text,
    verdict: answer.verdict,
    citations: answer.citations.map((citation) => ({
      factId: citation.factId,
      subject: citation.fact.subject,
      predicate: citation.fact.predicate,
      object: citation.fact.object,
      confidence: citation.fact.confidence,
      provenance: citation.fact.provenance,
    })),
    fabricatedIdentifiers: answer.fabricatedIdentifiers,
    unknownCitations: answer.unknownCitations,
    grounding: wireGrounding(answer.grounding),
    model: answer.model,
    stopReason: answer.stopReason,
    usage: answer.usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------

export interface ChatRequest {
  readonly question: string;
  readonly subject: ContextRequest;
  readonly tier?: BudgetTier;
  readonly maxOutputTokens?: number;
  /** Prior turns, as questions and answers. Facts are never replayed; each turn grounds itself. */
  readonly history?: readonly { readonly question: string; readonly answer: string }[];
}

const CONTEXT_KINDS = ['symbol', 'impact', 'file', 'package', 'route', 'repository', 'search'] as const;

/**
 * Validates a chat body.
 *
 * **The subject must arrive already resolved.** This endpoint will not turn free text into a subject:
 * that is repository search, it belongs to `GET /search`, and doing it here would put repository
 * intelligence inside the AI path. A client searches first, then asks.
 */
export function parseChatRequest(body: unknown): ChatRequest {
  if (typeof body !== 'object' || body === null) {
    throw badRequest('the request body must be a JSON object', 'send { "question": …, "subject": … }');
  }

  const input = body as Record<string, unknown>;
  const question = input.question;

  if (typeof question !== 'string' || question.trim() === '') {
    throw missingParameter('question', 'body');
  }

  const subject = parseSubject(input.subject);
  const tier = parseTier(input.tier);
  const maxOutputTokens = parseMaxOutputTokens(input.maxOutputTokens);
  const history = parseHistory(input.history);

  return {
    question,
    subject,
    ...(tier === undefined ? {} : { tier }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(history === undefined ? {} : { history }),
  };
}

function parseSubject(value: unknown): ContextRequest {
  if (typeof value !== 'object' || value === null) {
    throw missingParameter('subject', 'body');
  }

  const subject = value as Record<string, unknown>;
  const kind = subject.kind;

  if (typeof kind !== 'string' || !CONTEXT_KINDS.includes(kind as (typeof CONTEXT_KINDS)[number])) {
    throw badRequest(
      `'${String(kind)}' is not a context kind`,
      `subject.kind must be one of ${CONTEXT_KINDS.join(', ')}`,
    );
  }

  const need = (name: string): string => {
    const held = subject[name];

    if (typeof held !== 'string' || held === '') {
      throw badRequest(`a '${kind}' subject needs a string '${name}'`, `add subject.${name}`);
    }

    return held;
  };

  switch (kind) {
    case 'symbol':
    case 'impact':
      return { kind, id: need('id') as ContextRequest extends { id: infer T } ? T : never };
    case 'file':
      return { kind, path: need('path') };
    case 'package':
      return { kind, name: need('name') };
    case 'route':
      return { kind, method: need('method'), path: need('path') };
    case 'repository':
      return { kind };
    default: {
      const query = subject.query;

      if (typeof query !== 'object' || query === null || typeof (query as { text?: unknown }).text !== 'string') {
        throw badRequest("a 'search' subject needs a query with a text", 'add subject.query.text');
      }

      return { kind: 'search', query: query as { text: string } };
    }
  }
}

function parseTier(value: unknown): BudgetTier | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !BUDGET_TIERS.includes(value as BudgetTier)) {
    throw badRequest(`'${String(value)}' is not a budget tier`, `tier must be one of ${BUDGET_TIERS.join(', ')}`);
  }

  return value as BudgetTier;
}

function parseMaxOutputTokens(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw badRequest('maxOutputTokens must be a positive integer', 'omit it to use the model default');
  }

  return value;
}

function parseHistory(value: unknown): readonly { question: string; answer: string }[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw badRequest('history must be an array of turns', 'send [{ "question": …, "answer": … }]');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw badRequest(`history[${index}] must be an object`, 'each turn needs a question and an answer');
    }

    const turn = entry as Record<string, unknown>;

    if (typeof turn.question !== 'string' || typeof turn.answer !== 'string') {
      throw badRequest(`history[${index}] needs a string question and answer`, 'omit incomplete turns');
    }

    return { question: turn.question, answer: turn.answer };
  });
}

/**
 * Translates an `AiError` into an `ApiError`, keeping its code.
 *
 * The code, detail and hint are the AI layer's own. Nothing is reworded: a client that already branches on
 * an `AiError` code sees the same vocabulary over HTTP.
 */
export function toApiErrorFromAi(error: AiError): ApiError {
  return new ApiError(error.code, error.detail, error.hint);
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
