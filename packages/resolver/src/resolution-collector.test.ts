import type { SourceRange } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';
import { describe, expect, it } from 'vitest';

import { ResolutionCollector } from './resolution-collector.js';
import type { SymbolResolution } from './symbol-target.js';
import type { ResolutionTarget } from './types.js';

/**
 * Direct unit tests for the collector.
 *
 * The ambiguous path is tested here rather than through a fixture repository
 * because no TypeScript program reachable by the IR produces two distinct in-IR
 * targets for one symbol — see the README. Driving the collector directly tests the
 * mechanism honestly instead of asserting over an empty set.
 */

const LOCATION: SourceRange = { startLine: 4, startColumn: 7, endLine: 4, endColumn: 20 };

const SITE = {
  type: 'REFERENCES_TYPE' as const,
  sourceId: 'sym:src/a.ts#Holder' as NodeId,
  name: 'Thing',
  location: LOCATION,
  resolver: 'type-references' as const,
  fileId: 'file:src/a.ts' as NodeId,
};

const declarationTarget = (id: string): ResolutionTarget => ({
  kind: 'declaration',
  declarationId: id as NodeId,
});

const ambiguous: SymbolResolution = {
  outcome: 'resolved',
  targets: [declarationTarget('sym:src/b.ts#Thing'), declarationTarget('sym:src/c.ts#Thing')],
  confidence: 'AMBIGUOUS',
  evidence: 'the type checker bound it to 2 distinct targets',
};

const unique: SymbolResolution = {
  outcome: 'resolved',
  targets: [declarationTarget('sym:src/b.ts#Thing')],
  confidence: 'RESOLVED',
  evidence: 'the type checker bound it to one target',
};

describe('a uniquely resolved reference', () => {
  it('produces one relationship', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, unique, 'Thing');

    expect(collector.relationships).toHaveLength(1);
  });

  it('leaves the candidate group unset', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, unique, 'Thing');

    expect(collector.relationships[0]?.candidateGroup).toBeNull();
  });

  it('carries the site, confidence, provenance and location through', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, unique, 'Thing');

    expect(collector.relationships[0]).toMatchObject({
      type: 'REFERENCES_TYPE',
      sourceId: 'sym:src/a.ts#Holder',
      name: 'Thing',
      confidence: 'RESOLVED',
      location: LOCATION,
      provenance: {
        resolver: 'type-references',
        fileId: 'file:src/a.ts',
        evidence: 'the type checker bound it to one target',
      },
    });
  });
});

describe('an ambiguous reference', () => {
  it('produces one relationship per candidate, discarding none', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, ambiguous, 'Thing');

    expect(collector.relationships).toHaveLength(2);
    expect(collector.relationships.map((entry) => entry.target)).toEqual(ambiguous.targets);
  });

  it('marks every candidate AMBIGUOUS', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, ambiguous, 'Thing');

    expect(collector.relationships.every((entry) => entry.confidence === 'AMBIGUOUS')).toBe(true);
  });

  it('gives every candidate the same non-null group, so they read as alternatives', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, ambiguous, 'Thing');

    const groups = new Set(collector.relationships.map((entry) => entry.candidateGroup));

    expect(groups.size).toBe(1);
    expect([...groups][0]).not.toBeNull();
  });

  it('derives the group from the site, so repeated runs agree', () => {
    const first = new ResolutionCollector();
    const second = new ResolutionCollector();

    first.addSymbolResolution(SITE, ambiguous, 'Thing');
    second.addSymbolResolution(SITE, ambiguous, 'Thing');

    expect(first.relationships[0]?.candidateGroup).toBe(second.relationships[0]?.candidateGroup);
  });

  it('separates two ambiguous references at different positions', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(SITE, ambiguous, 'Thing');
    collector.addSymbolResolution(
      { ...SITE, location: { ...LOCATION, startLine: 9 } },
      ambiguous,
      'Thing',
    );

    const groups = new Set(collector.relationships.map((entry) => entry.candidateGroup));

    expect(groups.size).toBe(2);
  });
});

describe('an unresolved reference', () => {
  it('is recorded as unresolved rather than as a relationship', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(
      SITE,
      { outcome: 'unresolved', reason: 'no-symbol', evidence: 'no symbol here' },
      'Thing',
    );

    expect(collector.relationships).toHaveLength(0);
    expect(collector.unresolved).toHaveLength(1);
  });

  it('keeps the reason, the text and the explanation', () => {
    const collector = new ResolutionCollector();

    collector.addSymbolResolution(
      SITE,
      { outcome: 'unresolved', reason: 'type-parameter', evidence: 'it is a type parameter' },
      'T',
    );

    expect(collector.unresolved[0]).toMatchObject({
      type: 'REFERENCES_TYPE',
      sourceId: 'sym:src/a.ts#Holder',
      reason: 'type-parameter',
      text: 'T',
      location: LOCATION,
      provenance: { evidence: 'it is a type parameter' },
    });
  });
});

describe('a relationship recorded without the checker', () => {
  it('takes the confidence and evidence it is given', () => {
    const collector = new ResolutionCollector();

    collector.addRelationship(
      SITE,
      declarationTarget('sym:src/b.ts#Thing'),
      'CERTAIN',
      'established syntactically',
    );

    expect(collector.relationships[0]).toMatchObject({
      confidence: 'CERTAIN',
      candidateGroup: null,
      provenance: { evidence: 'established syntactically' },
    });
  });
});
