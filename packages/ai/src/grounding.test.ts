import { describe, expect, it } from 'vitest';

import { symbolContext } from './fixtures.test-helper.js';
import { checkGrounding } from './grounding.js';
import { project } from './projection.js';

/**
 * The guard — where "grounded only in RepositoryContext" stops being aspirational.
 *
 * Every identifier in the graph carries a fixed prefix, and for a given projection the permitted set is
 * closed and known, so a fabrication is decided deterministically with no model involved.
 */
const projection = project(symbolContext(), { tier: 'full' });
const real = [...projection.identifiers][0] ?? '';
const firstFact = projection.facts[0]?.id ?? 'f1';

describe('checkGrounding', () => {
  it('accepts an answer that cites a real fact and names only real identifiers', () => {
    const report = checkGrounding(`The method ${real} is in a cycle [${firstFact}].`, projection);

    expect(report.verdict).toBe('grounded');
    expect(report.fabricatedIdentifiers).toEqual([]);
    expect(report.citations).toHaveLength(1);
  });

  it('resolves a citation to the whole fact, so a consumer can show the evidence', () => {
    const report = checkGrounding(`See [${firstFact}].`, projection);

    expect(report.citations[0]?.factId).toBe(firstFact);
    expect(report.citations[0]?.fact.subject).toBe(projection.facts[0]?.subject);
    expect(report.citations[0]?.fact.provenance).toBe(projection.facts[0]?.provenance);
  });

  it('rejects an invented identifier', () => {
    const report = checkGrounding(`It calls sym:invented.ts#Nope [${firstFact}].`, projection);

    expect(report.verdict).toBe('ungrounded');
    expect(report.fabricatedIdentifiers).toEqual(['sym:invented.ts#Nope']);
  });

  it('rejects a citation to a fact that does not exist', () => {
    const report = checkGrounding('As shown in [f9999].', projection);

    expect(report.verdict).toBe('ungrounded');
    expect(report.unknownCitations).toEqual(['f9999']);
    expect(report.citations).toEqual([]);
  });

  it('reports an uncited answer as unverifiable rather than as grounded', () => {
    const report = checkGrounding('It is used in several places.', projection);

    expect(report.verdict).toBe('unverifiable');
    expect(report.citations).toEqual([]);
    expect(report.fabricatedIdentifiers).toEqual([]);
  });

  it('does not mistake sentence punctuation for part of an identifier', () => {
    const report = checkGrounding(`The subject is ${real}.`, projection);

    expect(report.fabricatedIdentifiers).toEqual([]);
  });

  it('reports each fabrication once, however often it is repeated', () => {
    const answer = 'sym:a.ts#X and sym:a.ts#X and sym:a.ts#X';

    expect(checkGrounding(answer, projection).fabricatedIdentifiers).toEqual(['sym:a.ts#X']);
  });

  it('reports each citation once, however often it is repeated', () => {
    expect(checkGrounding(`[${firstFact}] [${firstFact}]`, projection).citations).toHaveLength(1);
  });

  it('recognises every identity prefix the graph uses', () => {
    const report = checkGrounding('file:nope.ts route:GET:/nope env:NOPE ext:npm:nope sym:nope.ts#Nope', projection);

    expect(report.fabricatedIdentifiers).toHaveLength(5);
  });

  it('accepts an identifier the projection showed with a depth suffix', () => {
    // A fact object may read `sym:… at depth 2`; a model citing the identifier alone has not invented it.
    const withDepth = project(symbolContext(), { tier: 'full' });

    for (const identifier of withDepth.identifiers) {
      expect(identifier).not.toMatch(/ at depth /);
    }
  });

  it('a fabrication outweighs a valid citation', () => {
    const report = checkGrounding(`[${firstFact}] proves sym:invented.ts#Nope exists.`, projection);

    expect(report.verdict).toBe('ungrounded');
    expect(report.citations).toHaveLength(1);
  });
});

describe('the combined citation form', () => {
  it('reads several ids from one bracket', () => {
    // A real 7B model wrote `[f8, f10]` on the first live run. A pattern matching only `[f8]` dropped two
    // of three citations silently, which is the worst direction for this layer to fail in.
    const ids = projection.facts.slice(0, 3).map((fact) => fact.id);
    const report = checkGrounding(`Two reasons [${ids[0]}, ${ids[1]}] and a third [${ids[2]}].`, projection);

    expect(report.citations.map((citation) => citation.factId)).toEqual(ids);
    expect(report.verdict).toBe('grounded');
  });

  it('tolerates spacing inside a combined citation', () => {
    const ids = projection.facts.slice(0, 2).map((fact) => fact.id);

    expect(checkGrounding(`[${ids[0]},${ids[1]}]`, projection).citations).toHaveLength(2);
    expect(checkGrounding(`[${ids[0]} ,  ${ids[1]}]`, projection).citations).toHaveLength(2);
  });

  it('flags an unknown id inside an otherwise valid combined citation', () => {
    const report = checkGrounding(`[${firstFact}, f9999]`, projection);

    expect(report.citations).toHaveLength(1);
    expect(report.unknownCitations).toEqual(['f9999']);
    expect(report.verdict).toBe('ungrounded');
  });
});
