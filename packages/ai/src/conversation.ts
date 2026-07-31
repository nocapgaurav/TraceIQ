import type { ContextRequest } from '@traceiq/context';

import type { Citation } from './facts.js';
import type { GroundingVerdict } from './grounding.js';

/**
 * Conversation, as data.
 *
 * **Types only — nothing here persists anything.** Storage is a later milestone, and shipping an
 * implementation now would put a database in this package's closure for a feature nobody has asked for.
 *
 * The shape is **this layer's own**, never a provider's message format. That is what makes history
 * provider-independent: the same conversation replays against any model, and `prompt.renderHistory`
 * adapts it at the edge.
 */

export type ConversationId = string;

export interface Turn {
  readonly id: string;
  readonly question: string;
  /** What was asked about. A follow-up may have a different subject from the turn before it. */
  readonly subject: ContextRequest;
  readonly answer: string;
  /** The facts the answer referred to, resolved — so a consumer can show the evidence. */
  readonly citations: readonly Citation[];
  readonly verdict: GroundingVerdict;
  /** Identity of the facts that grounded this turn. Two equal digests ground identically. */
  readonly projectionDigest: string;
  /**
   * Which model answered.
   *
   * Metadata for audit, not structure: nothing in the conversation format depends on it, and a history
   * recorded against one model replays against another.
   */
  readonly model: string;
}

export interface Conversation {
  readonly id: ConversationId;
  readonly turns: readonly Turn[];
}

/**
 * The prior turns a prompt may replay.
 *
 * Separate from `Conversation` because assembling a prompt needs only the ordered turns, not the
 * conversation's identity — and a caller holding a partial or windowed history can supply one without
 * pretending it is the whole conversation.
 */
export interface ConversationHistory {
  readonly turns: readonly Turn[];
}

/** An empty history. Named so a caller need not construct the shape to mean "no prior turns". */
export const NO_HISTORY: ConversationHistory = { turns: [] };

/**
 * The most recent turns, oldest first.
 *
 * History competes with facts for the same budget, so a caller usually wants a window rather than
 * everything. Provided here because the alternative is every consumer writing the same slice.
 */
export function recentTurns(conversation: Conversation, limit: number): ConversationHistory {
  return { turns: limit <= 0 ? [] : conversation.turns.slice(-limit) };
}
