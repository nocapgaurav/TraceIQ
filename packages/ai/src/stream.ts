import type { Omission } from './facts.js';
import type { Answer } from './answer.js';

/**
 * What answering emits.
 *
 * **`grounding` always arrives before the first `delta`.** A consumer can show what the answer is
 * permitted to be based on — and what was left out — before any prose appears, which is the right order
 * for a grounded tool: the evidence precedes the claim.
 *
 * A failure is thrown, not emitted. An error event is ignorable; a throw from an async iterator is not.
 * A transport that has already sent bytes cannot answer with an error status, so the SSE adapter — a later
 * milestone — translates a throw into a terminal frame. That is a wire concern, not this one.
 */
export type AnswerEvent =
  | { readonly type: 'grounding'; readonly grounding: GroundingSummary }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'complete'; readonly answer: Answer };

/** The projection, described rather than carried: a consumer wants the shape, not thousands of facts. */
export interface GroundingSummary {
  readonly kind: string;
  readonly subject: string | null;
  readonly factCount: number;
  readonly omissions: readonly Omission[];
  readonly tier: string;
  readonly tokens: number;
  readonly digest: string;
}

/**
 * Drains a stream into its finished answer.
 *
 * The only non-streaming path, deliberately: were both primitives, providers would maintain two code
 * paths and streaming would become the one nobody exercises. Everything blocking is built from this.
 */
export async function collect(events: AsyncIterable<AnswerEvent>): Promise<Answer> {
  let answer: Answer | null = null;

  for await (const event of events) {
    if (event.type === 'complete') {
      answer = event.answer;
    }
  }

  if (answer === null) {
    // Unreachable through `RepositoryAnswerer`, which always ends with `complete` or throws. Guarding
    // rather than asserting, because a custom stream could break the contract and a null return would
    // then surface far from its cause.
    throw new Error('the answer stream ended without completing');
  }

  return answer;
}

/** Collects the text of a stream, ignoring everything else. Useful for a caller that only wants prose. */
export async function collectText(events: AsyncIterable<AnswerEvent>): Promise<string> {
  const parts: string[] = [];

  for await (const event of events) {
    if (event.type === 'delta') {
      parts.push(event.text);
    }
  }

  return parts.join('');
}
