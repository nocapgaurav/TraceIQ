import { describe, expect, it } from 'vitest';

import {
  FACTS,
  FakeGraphApi,
  edge,
  unresolved,
  type FakeGraph,
} from './bench-fixture.test-helper.js';
import { measureQuality } from './metrics.js';
import type { QualityReport, RelationshipQuality } from './types.js';

const measure = (input: FakeGraph): QualityReport =>
  measureQuality(new FakeGraphApi(input), FACTS);

const relationship = (report: QualityReport, type: string): RelationshipQuality | undefined =>
  report.relationships.find((entry) => entry.type === type);

describe('bind rate', () => {
  it('is resolved over everything the engine attempted', () => {
    const report = measure({
      edges: [edge({ type: 'CALLS', targetId: 'sym:src/a.ts#f' })],
      unresolved: [
        unresolved({ type: 'CALLS', reason: 'root-not-bound' }),
        unresolved({ type: 'CALLS', reason: 'root-not-bound' }),
        unresolved({ type: 'CALLS', reason: 'root-is-external' }),
      ],
    });

    expect(relationship(report, 'CALLS')).toMatchObject({
      resolved: 1,
      unresolved: 3,
      bindRate: 0.25,
    });
  });

  it('is null rather than zero when the relationship never occurred', () => {
    // Zero would read as "every reference failed", which is a different claim from
    // "the repository contains no reference of this kind".
    const report = measure({ edges: [edge({ type: 'IMPORTS', targetId: 'ext:npm:express' })] });

    expect(relationship(report, 'CALLS')).toBeUndefined();
  });

  it('is zero when every attempt failed', () => {
    const report = measure({ unresolved: [unresolved({ type: 'CALLS', reason: 'x' })] });

    expect(relationship(report, 'CALLS')?.bindRate).toBe(0);
  });

  it('omits relationship types with neither edges nor failures', () => {
    const report = measure({ edges: [edge({ type: 'CALLS', targetId: 'sym:src/a.ts#f' })] });

    expect(report.relationships.map((entry) => entry.type)).toEqual(['CALLS']);
  });
});

describe('unresolved reasons', () => {
  it('counts each reason and orders by frequency', () => {
    const report = measure({
      unresolved: [
        unresolved({ type: 'CALLS', reason: 'rare' }),
        unresolved({ type: 'CALLS', reason: 'common' }),
        unresolved({ type: 'CALLS', reason: 'common' }),
      ],
    });

    expect(relationship(report, 'CALLS')?.byReason).toEqual([
      { reason: 'common', count: 2 },
      { reason: 'rare', count: 1 },
    ]);
  });

  it('breaks frequency ties alphabetically, so the ordering is total', () => {
    const report = measure({
      unresolved: [
        unresolved({ type: 'CALLS', reason: 'beta' }),
        unresolved({ type: 'CALLS', reason: 'alpha' }),
      ],
    });

    expect(relationship(report, 'CALLS')?.byReason.map((entry) => entry.reason)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('attributes reasons to their own relationship type', () => {
    const report = measure({
      unresolved: [
        unresolved({ type: 'CALLS', reason: 'root-not-bound' }),
        unresolved({ type: 'IMPORTS', reason: 'no-declaration' }),
      ],
    });

    expect(relationship(report, 'CALLS')?.byReason).toEqual([
      { reason: 'root-not-bound', count: 1 },
    ]);
    expect(relationship(report, 'IMPORTS')?.byReason).toEqual([
      { reason: 'no-declaration', count: 1 },
    ]);
  });
});

describe('target reach', () => {
  it('separates internal targets, named externals and the opaque sentinel', () => {
    const report = measure({
      edges: [
        edge({ type: 'IMPORTS', targetId: 'sym:src/a.ts#f' }),
        edge({ type: 'IMPORTS', targetId: 'file:src/b.ts' }),
        edge({ type: 'IMPORTS', targetId: 'ext:npm:express' }),
        edge({ type: 'IMPORTS', targetId: 'ext:node:fs' }),
        edge({ type: 'IMPORTS', targetId: 'ext:builtin:Promise' }),
        edge({ type: 'IMPORTS', targetId: 'ext:outside-analysis' }),
        edge({ type: 'IMPORTS', targetId: 'ext:outside-analysis' }),
      ],
    });

    expect(report.importReach).toEqual({ internal: 2, named: 3, opaque: 2 });
  });

  it('counts the opaque sentinel apart from named externals, since only one is nameable', () => {
    // This is the measurement that distinguishes a workspace package reached through
    // its published types from a genuine third-party dependency. Both are "resolved".
    const report = measure({
      edges: [
        edge({ type: 'IMPORTS', targetId: 'ext:outside-analysis' }),
        edge({ type: 'IMPORTS', targetId: 'ext:npm:express' }),
      ],
    });

    expect(report.importReach.opaque).toBe(1);
    expect(report.importReach.named).toBe(1);
    expect(relationship(report, 'IMPORTS')?.bindRate).toBe(1);
  });

  it('reports call reach separately from import reach', () => {
    const report = measure({
      edges: [
        edge({ type: 'IMPORTS', targetId: 'ext:outside-analysis' }),
        edge({ type: 'CALLS', targetId: 'sym:src/a.ts#f' }),
      ],
    });

    expect(report.importReach).toEqual({ internal: 0, named: 0, opaque: 1 });
    expect(report.callReach).toEqual({ internal: 1, named: 0, opaque: 0 });
  });
});

describe('confidence', () => {
  it('counts every level, including those that did not occur', () => {
    const report = measure({
      edges: [
        edge({ type: 'CALLS', targetId: 'sym:src/a.ts#f', confidence: 'INFERRED' }),
        edge({ type: 'CALLS', targetId: 'sym:src/a.ts#g', confidence: 'INFERRED' }),
        edge({ type: 'CALLS', targetId: 'sym:src/a.ts#h', confidence: 'RESOLVED' }),
      ],
    });

    expect(relationship(report, 'CALLS')?.byConfidence).toEqual({
      CERTAIN: 0,
      RESOLVED: 1,
      INFERRED: 2,
      AMBIGUOUS: 0,
    });
  });
});

describe('totals', () => {
  it('sums edges across every relationship type and carries the scan facts through', () => {
    const report = measure({
      edges: [
        edge({ type: 'CALLS', targetId: 'sym:src/a.ts#f' }),
        edge({ type: 'IMPORTS', targetId: 'ext:npm:express' }),
        edge({ type: 'DECLARES', targetId: 'sym:src/a.ts#f' }),
      ],
      unresolved: [unresolved({ type: 'CALLS', reason: 'x' })],
    });

    expect(report).toMatchObject({
      repository: 'fixture',
      files: 1,
      nodes: 2,
      edges: 3,
      unresolved: 1,
    });
  });
});
