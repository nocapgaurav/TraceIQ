import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_LEVELS,
  NODE_ID_KINDS,
  RELATIONSHIP_TYPES,
  ROLES,
} from './index.js';

/**
 * These are contract-conformance tests, not behaviour tests. The vocabularies
 * are closed sets fixed by the engineering contract, so any edit to them is an
 * architectural change. Asserting the exact contents makes such an edit fail
 * loudly instead of quietly spreading through the graph.
 */

const vocabularies = {
  CONFIDENCE_LEVELS,
  ROLES,
  RELATIONSHIP_TYPES,
  NODE_ID_KINDS,
} satisfies Record<string, readonly string[]>;

describe('domain vocabularies', () => {
  it.each(Object.entries(vocabularies))('%s contains no duplicates', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(Object.entries(vocabularies))('%s contains no empty entries', (_name, values) => {
    expect(values.every((value) => value.trim().length > 0)).toBe(true);
  });
});

describe('confidence levels', () => {
  it('are exactly the four levels the contract allows', () => {
    expect([...CONFIDENCE_LEVELS]).toEqual(['CERTAIN', 'RESOLVED', 'INFERRED', 'AMBIGUOUS']);
  });
});

describe('roles', () => {
  it('are exactly the six roles the contract allows', () => {
    expect([...ROLES]).toEqual([
      'Controller',
      'Service',
      'Repository',
      'Middleware',
      'Model',
      'Test',
    ]);
  });
});

describe('identifier prefixes', () => {
  it('are exactly the five the contract defines', () => {
    expect([...NODE_ID_KINDS]).toEqual(['file', 'sym', 'route', 'env', 'ext']);
  });
});

describe('relationship types', () => {
  it('are exactly the thirteen relationships the contract allows', () => {
    expect([...RELATIONSHIP_TYPES]).toEqual([
      'DECLARES',
      'IMPORTS',
      'EXPORTS',
      'CALLS',
      'IMPLEMENTS',
      'EXTENDS',
      'REFERENCES_TYPE',
      'HANDLED_BY',
      'READS',
      'WRITES',
      'DEPENDS_ON',
      'CONTINUES_TO',
      'TESTS',
    ]);
  });

  it('does not define a generic USES relationship', () => {
    expect(RELATIONSHIP_TYPES).not.toContain('USES');
  });
});
