import { describe, expect, it } from 'vitest';

import { compareQuality } from './compare.js';
import type { QualityReport, RelationshipQuality } from './types.js';

const NO_CONFIDENCE = { CERTAIN: 0, RESOLVED: 0, INFERRED: 0, AMBIGUOUS: 0 } as const;

const calls = (resolved: number, unresolved: number): RelationshipQuality => ({
  type: 'CALLS',
  resolved,
  unresolved,
  bindRate: resolved + unresolved === 0 ? null : resolved / (resolved + unresolved),
  byConfidence: NO_CONFIDENCE,
  byReason: [],
});

const report = (input: {
  readonly repository?: string;
  readonly relationships?: readonly RelationshipQuality[];
  readonly opaqueImports?: number;
  readonly scanMillis?: number;
  readonly internalCallBindRate?: number | null;
}): QualityReport => ({
  repository: input.repository ?? 'fixture',
  repositoryPath: '/tmp/fixture',
  files: 1,
  nodes: 1,
  edges: 1,
  unresolved: 0,
  scanMillis: input.scanMillis ?? 100,
  relationships: input.relationships ?? [],
  importReach: { internal: 0, named: 0, opaque: input.opaqueImports ?? 0 },
  callReach: { internal: 0, named: 0, opaque: 0 },
  internalCallBindRate: input.internalCallBindRate ?? null,
  universal: {
    languages: [],
    regions: 0,
    semanticRegions: 0,
    manifests: 0,
    declaredDependencies: 0,
    depth: 'universal',
    isPolyglot: false,
  },
});

describe('comparison', () => {
  it('reports the bind rate change in percentage points', () => {
    const comparison = compareQuality(
      report({ relationships: [calls(20, 80)] }),
      report({ relationships: [calls(60, 40)] }),
    );

    expect(comparison.relationships[0]).toMatchObject({
      type: 'CALLS',
      baselineBindRate: 0.2,
      currentBindRate: 0.6,
      bindRatePoints: 40,
      resolvedDelta: 40,
      unresolvedDelta: -40,
    });
  });

  it('reports a regression as a negative movement', () => {
    const comparison = compareQuality(
      report({ relationships: [calls(60, 40)] }),
      report({ relationships: [calls(20, 80)] }),
    );

    expect(comparison.relationships[0]?.bindRatePoints).toBe(-40);
    expect(comparison.relationships[0]?.resolvedDelta).toBe(-40);
  });

  it('tracks the internal call bind rate, which external edges cannot inflate', () => {
    // The number that matters: a CALLS bind rate can be raised almost arbitrarily by
    // counting calls that leave the repository, and those answer a different question.
    const comparison = compareQuality(
      report({ internalCallBindRate: 0.206 }),
      report({ internalCallBindRate: 0.681 }),
    );

    expect(comparison.internalCallBindRatePoints).toBeCloseTo(47.5, 1);
  });

  it('reports a null internal call movement when either side saw no calls', () => {
    expect(
      compareQuality(report({}), report({ internalCallBindRate: 0.5 }))
        .internalCallBindRatePoints,
    ).toBeNull();
  });

  it('tracks the opaque external count, which a bind rate cannot show', () => {
    const comparison = compareQuality(
      report({ opaqueImports: 500 }),
      report({ opaqueImports: 12 }),
    );

    expect(comparison.opaqueImportsDelta).toBe(-488);
  });

  it('keeps a relationship that vanished, with a null current rate', () => {
    const comparison = compareQuality(report({ relationships: [calls(10, 0)] }), report({}));

    expect(comparison.relationships[0]).toMatchObject({
      type: 'CALLS',
      baselineBindRate: 1,
      currentBindRate: null,
      bindRatePoints: null,
      resolvedDelta: -10,
    });
  });

  it('keeps a relationship that appeared, with a null baseline rate', () => {
    const comparison = compareQuality(report({}), report({ relationships: [calls(10, 0)] }));

    expect(comparison.relationships[0]).toMatchObject({
      baselineBindRate: null,
      currentBindRate: 1,
      bindRatePoints: null,
      resolvedDelta: 10,
    });
  });

  it('refuses to compare different repositories', () => {
    // Subtracting these would produce clean numbers that mean nothing.
    expect(() =>
      compareQuality(report({ repository: 'a' }), report({ repository: 'b' })),
    ).toThrow(/different repositories/);
  });

  it('reports the scan time change', () => {
    const comparison = compareQuality(
      report({ scanMillis: 1000 }),
      report({ scanMillis: 2500 }),
    );

    expect(comparison.scanMillisDelta).toBe(1500);
  });
});
