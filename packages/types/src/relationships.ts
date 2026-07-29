/**
 * The relationship vocabulary of the Knowledge Graph.
 *
 * Every relationship must state exactly what it means. There is deliberately no
 * generic USES relationship: a catch-all edge becomes the place extractors dump
 * whatever they could not classify, and once that happens no query can tell the
 * cases apart again.
 */
export const RELATIONSHIP_TYPES = [
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
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
