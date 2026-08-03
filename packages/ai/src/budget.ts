import { createHash } from 'node:crypto';

import type { TokenCounter } from './model.js';

/**
 * How many prompt tokens a projection may spend.
 *
 * Three named tiers rather than an arbitrary number, so overflow steps down a **stated** rung instead of
 * dropping whatever happened to be at the end of the list.
 *
 * The sizes come from measurement. `standard` is set so a projection plus the question plus room to answer
 * fits an 8k window, which is the common case for a model running on a developer's own machine. `full`
 * targets a 32k window. `minimal` is the floor below which an answer would be grounded in so little that
 * it should fail loudly instead — `budget-not-satisfiable`.
 */
export const BUDGET_TIERS = ['minimal', 'standard', 'full'] as const;

export type BudgetTier = (typeof BUDGET_TIERS)[number];

/**
 * `standard` came down from 6,000, and the justification is latency measured against information kept.
 *
 * A projection always spends its budget, so compressing facts alone changes nothing about prompt size —
 * it changes how much fits. Once limitations went from 1,081 tokens to 160, technology evidence was cut
 * to its checkable clause and region groups stopped repeating a fixed sentence about their own depth,
 * the same repository knowledge needed far fewer tokens to state. Lowering the ceiling is what turns
 * that into a faster answer instead of simply more facts.
 *
 * The number is chosen against the clock. Prompt evaluation on the reference stack runs near 50 tokens
 * per second, so every 1,000 prompt tokens is about 20 seconds before the first word appears; 6,000
 * tokens of facts meant a cold answer began after roughly two minutes. 3,400 puts a common question's
 * whole prompt — instruction, facts, question — at about 3,300 tokens and its cold first token near
 * one minute, which is the difference between waiting and giving up.
 *
 * `full` is unchanged and still reachable by a deployment that raises `TRACEIQ_MODEL_CONTEXT`; nothing
 * here caps what a larger machine may do.
 */
export const TIER_TOKENS: Readonly<Record<BudgetTier, number>> = {
  minimal: 1_500,
  standard: 3_400,
  full: 24_000,
};

/** The next smaller tier, or `null` at the floor. Used when a provider rejects a prompt as too long. */
export function smallerTier(tier: BudgetTier): BudgetTier | null {
  const index = BUDGET_TIERS.indexOf(tier);

  return index <= 0 ? null : (BUDGET_TIERS[index - 1] ?? null);
}

/**
 * The largest tier that fits a model, leaving room to answer.
 *
 * Half the window is reserved for the answer and the fixed prompt scaffolding. A model that cannot hold
 * `minimal` still gets `minimal`, so the failure surfaces as an explicit `budget-not-satisfiable` rather
 * than as a silently empty projection.
 */
export function tierForWindow(contextWindow: number): BudgetTier {
  const usable = Math.floor(contextWindow / 2);

  for (const tier of [...BUDGET_TIERS].reverse()) {
    if (TIER_TOKENS[tier] <= usable) {
      return tier;
    }
  }

  return 'minimal';
}

/**
 * The default token counter.
 *
 * **An estimate, and labelled as one.** 3.6 characters per token is the ratio measured across the six
 * context kinds on TraceIQ itself; dense identifier text sits near it, prose slightly above. A provider
 * that can count exactly supplies its own `TokenCounter` and this is not used.
 *
 * Rounding is up and the floor is 1, so no non-empty string ever costs zero — an estimator that returns
 * zero would let an unbounded number of facts through a bounded budget.
 */
export const CHARS_PER_TOKEN = 3.6;

export const estimatingCounter: TokenCounter = {
  count: (text: string): number => (text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))),
};

/**
 * Separates the parts before hashing.
 *
 * NUL, because it cannot occur inside a rendered fact line — so `['ab','c']` and `['a','bc']` cannot produce
 * the same digest. Written as an escape rather than embedded as a raw byte: a literal NUL makes a source file
 * binary to `grep`, which would silently defeat the boundary audits this package relies on.
 */
const SEPARATOR = '\u0000';

/**
 * A deterministic digest of whatever grounded an answer.
 *
 * SHA-256 over the exact rendered facts, so two projections agree if and only if they would ground an
 * answer identically. `node:crypto` is a platform builtin — it adds no dependency, and it leaves the
 * package's runtime closure free of any `@traceiq` module, SQLite and ts-morph.
 *
 * Truncated to 16 hex characters: this identifies a projection, it does not authenticate one.
 */
export function digest(parts: readonly string[]): string {
  const hash = createHash('sha256');

  for (const part of parts) {
    hash.update(part);
    hash.update(SEPARATOR);
  }

  return hash.digest('hex').slice(0, 16);
}
