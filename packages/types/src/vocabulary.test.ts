import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_ELEMENT_KINDS,
  ARTIFACT_KINDS,
  ARTIFACT_RELATIONSHIP_TYPES,
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
  ARTIFACT_KINDS,
  ARTIFACT_ELEMENT_KINDS,
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
  it('are exactly the six the contract defines', () => {
    expect([...NODE_ID_KINDS]).toEqual(['file', 'sym', 'route', 'env', 'ext', 'art']);
  });

  it('keeps artefact elements out of the declaration prefix', () => {
    // A consumer showing "declarations in this file" filters on `sym:`. Sharing the prefix would put
    // workflow steps in that list, and no layer downstream could tell them apart again.
    expect(NODE_ID_KINDS).toContain('art');
    expect(NODE_ID_KINDS).toContain('sym');
  });
});

describe('relationship types', () => {
  it('are exactly the nineteen relationships the contract allows', () => {
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
      'CONTAINS',
      'REFERENCES',
      'RUNS',
      'CONFIGURES',
      'DOCUMENTS',
      'USES_ENV',
    ]);
  });

  it('does not define a generic USES relationship', () => {
    expect(RELATIONSHIP_TYPES).not.toContain('USES');
  });

  it('keeps the six artefact relationships inside the one vocabulary', () => {
    for (const type of ARTIFACT_RELATIONSHIP_TYPES) {
      expect(RELATIONSHIP_TYPES).toContain(type);
    }

    expect(ARTIFACT_RELATIONSHIP_TYPES).toHaveLength(6);
  });
});

/**
 * The two artefact vocabularies share one graph column, discriminated by the node's `kind`.
 *
 * A term appearing in both would make a stored value ambiguous — a reader could not tell whether
 * `service` named the family of a file or the kind of an element — so disjointness is a contract rather
 * than a coincidence, and this is where it is enforced.
 */
describe('artefact vocabularies', () => {
  it('do not overlap, because they share one column', () => {
    const families = new Set<string>(ARTIFACT_KINDS);
    const overlap = ARTIFACT_ELEMENT_KINDS.filter((kind) => families.has(kind));

    expect(overlap).toEqual([]);
  });

  it('name an explicit unknown family rather than leaving one implicit', () => {
    expect(ARTIFACT_KINDS).toContain('unknown-artifact');
  });
});
