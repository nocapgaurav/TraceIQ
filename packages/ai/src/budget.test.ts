import { describe, expect, it } from 'vitest';

import { BUDGET_TIERS, TIER_TOKENS, digest, estimatingCounter, smallerTier, tierForWindow } from './budget.js';

describe('tiers', () => {
  it('grows monotonically', () => {
    const sizes = BUDGET_TIERS.map((tier) => TIER_TOKENS[tier]);

    expect(sizes).toEqual([...sizes].sort((left, right) => left - right));
  });

  it('steps down one named rung, and stops at the floor', () => {
    expect(smallerTier('full')).toBe('standard');
    expect(smallerTier('standard')).toBe('minimal');
    expect(smallerTier('minimal')).toBeNull();
  });
});

describe('tierForWindow', () => {
  it('leaves half the window for the answer', () => {
    expect(tierForWindow(TIER_TOKENS.standard * 2)).toBe('standard');
    expect(tierForWindow(TIER_TOKENS.full * 2)).toBe('full');
  });

  it('picks the largest tier that fits', () => {
    expect(tierForWindow(4096)).toBe('minimal');
    expect(tierForWindow(16_384)).toBe('standard');
    expect(tierForWindow(131_072)).toBe('full');
  });

  it('returns the floor for a window too small even for it, so the failure is explicit later', () => {
    expect(tierForWindow(512)).toBe('minimal');
  });
});

describe('estimatingCounter', () => {
  it('charges nothing for an empty string', () => {
    expect(estimatingCounter.count('')).toBe(0);
  });

  it('never charges zero for a non-empty string', () => {
    // A counter that returned zero would let an unbounded number of facts through a bounded budget.
    expect(estimatingCounter.count('a')).toBeGreaterThanOrEqual(1);
  });

  it('grows with length', () => {
    expect(estimatingCounter.count('x'.repeat(360))).toBeGreaterThan(estimatingCounter.count('x'.repeat(36)));
  });

  it('is deterministic', () => {
    expect(estimatingCounter.count('sym:a.ts#B calls sym:c.ts#D')).toBe(
      estimatingCounter.count('sym:a.ts#B calls sym:c.ts#D'),
    );
  });
});

describe('digest', () => {
  it('is stable for the same parts', () => {
    expect(digest(['a', 'b'])).toBe(digest(['a', 'b']));
  });

  it('differs for different parts, and for a different order', () => {
    expect(digest(['a', 'b'])).not.toBe(digest(['a', 'c']));
    expect(digest(['a', 'b'])).not.toBe(digest(['b', 'a']));
  });

  it('distinguishes a boundary that a naive concatenation would not', () => {
    expect(digest(['ab', 'c'])).not.toBe(digest(['a', 'bc']));
  });
});
