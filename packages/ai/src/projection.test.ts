import { describe, expect, it } from 'vitest';

import { TIER_TOKENS, estimatingCounter } from './budget.js';
import { factLine } from './facts.js';
import { CALLER, SUBJECT, node, repositoryContext, symbolContext, wideSymbolContext } from './fixtures.test-helper.js';
import { project, subjectOf } from './projection.js';

/**
 * The projection — the core of this milestone.
 *
 * Measured on TraceIQ itself, an `impact` context is 4.2 MB, about 1.2 million tokens. These tests are the
 * ones that keep the reduction honest: fixed priority rather than ranking, nothing invented, every cap
 * reported, and the same input producing the same bytes.
 */
describe('subjectOf', () => {
  it('names the declaration for a symbol context', () => {
    expect(subjectOf(symbolContext())).toBe(SUBJECT);
  });

  it('has no single subject for a repository context', () => {
    expect(subjectOf(repositoryContext())).toBeNull();
  });
});

describe('project', () => {
  it('states the subject identity before anything else', () => {
    const projection = project(symbolContext(), { tier: 'full' });
    const first = projection.facts[0];

    expect(first?.subject).toBe(SUBJECT);
    expect(first?.predicate).toBe('is-a');
    expect(first?.object).toBe('Method');
  });

  it('carries the role with the confidence the extractor reported, not as certain', () => {
    const role = project(symbolContext(), { tier: 'full' }).facts.find((fact) => fact.predicate === 'has-role');

    expect(role?.object).toBe('Service');
    expect(role?.confidence).toBe('INFERRED');
  });

  it('puts limitations near the front, because they are the honesty guarantee', () => {
    const projection = project(symbolContext(), { tier: 'full' });
    const positions = projection.facts.map((fact) => fact.predicate);
    const firstLimitation = positions.indexOf('limitation');
    const firstCall = positions.indexOf('calls');

    expect(firstLimitation).toBeGreaterThan(-1);
    expect(firstLimitation).toBeLessThan(firstCall);
  });

  it('keeps DIRECT, INDIRECT and UNKNOWN as separate facts', () => {
    const facts = project(symbolContext(), { tier: 'full' }).facts;
    const predicates = facts.map((fact) => fact.predicate);

    expect(predicates).toContain('affects-directly');
    expect(predicates).toContain('affects-indirectly');
    expect(predicates).toContain('unresolved');

    // Never summed into one number: a direct dependent breaks, an indirect one might, and unknown is
    // impact that could not be determined rather than impact that is absent.
    expect(facts.find((fact) => fact.predicate === 'affects-directly')?.object).toBe('2 declarations');
    expect(facts.find((fact) => fact.predicate === 'affects-indirectly')?.object).toBe('5 declarations');
  });

  it('reports the subject condition from health', () => {
    const facts = project(symbolContext(), { tier: 'full' }).facts;

    expect(facts.find((fact) => fact.predicate === 'in-cycle')?.object).toBe('true');
    expect(facts.find((fact) => fact.predicate === 'fan-in')?.object).toBe('4');
    expect(facts.some((fact) => fact.predicate === 'isolated')).toBe(false);
    expect(facts.find((fact) => fact.predicate === 'finding')?.object).toBe('declaration-in-dependency-cycle');
  });

  it('records a caller as a fact about the caller, not about the subject', () => {
    const call = project(symbolContext(), { tier: 'full' }).facts.find(
      (fact) => fact.predicate === 'calls' && fact.subject === CALLER,
    );

    expect(call?.object).toBe(SUBJECT);
    expect(call?.confidence).toBe('INFERRED');
  });

  it('never invents an identifier for an edge whose other end the graph could not name', () => {
    const projection = project(symbolContext(), { tier: 'full' });

    // The fixture holds an outgoing call with a `null` target. It must simply not appear.
    expect(projection.facts.some((fact) => fact.object.includes('unknown#helper'))).toBe(false);
    expect([...projection.identifiers]).not.toContain('sym:unknown#helper');
  });

  it('collects every identifier it showed, and nothing it did not', () => {
    const projection = project(symbolContext(), { tier: 'full' });

    expect(projection.identifiers.has(SUBJECT)).toBe(true);
    expect(projection.identifiers.has(CALLER)).toBe(true);
    expect(projection.identifiers.has('ext:npm:express')).toBe(true);
    expect(projection.identifiers.has('sym:not-in-the-context.ts#Nope')).toBe(false);
  });

  it('does not index a plain value as an identifier', () => {
    const projection = project(symbolContext(), { tier: 'full' });

    // 'Method', 'true', '4' and the like are objects of facts but are not identifiers.
    for (const value of projection.identifiers) {
      expect(value).toMatch(/^(sym|file|route|env|ext):/);
    }
  });

  it('numbers facts contiguously from f1', () => {
    const projection = project(symbolContext(), { tier: 'full' });

    expect(projection.facts.map((fact) => fact.id)).toEqual(
      projection.facts.map((_, index) => `f${index + 1}`),
    );
  });
});

describe('caps and omissions', () => {
  it('caps a wide list at the tier limit and reports the true total', () => {
    const projection = project(wideSymbolContext(200), { tier: 'standard' });
    const omission = projection.omissions.find((entry) => entry.part === 'incomingCalls');

    expect(omission).toBeDefined();
    expect(omission?.total).toBe(200);
    expect(omission?.kept).toBeLessThan(200);
    expect(projection.facts.filter((fact) => fact.predicate === 'calls')).toHaveLength(omission?.kept ?? 0);
  });

  it('keeps more at a larger tier', () => {
    // 600 exceeds every tier's cap, so all three omit and all three report a `kept`. With a count below
    // the largest cap the biggest tier would omit nothing at all — which is correct, and would make this
    // comparison meaningless rather than failing.
    const kept = (tier: 'minimal' | 'standard' | 'full'): number =>
      project(wideSymbolContext(600), { tier }).omissions.find((entry) => entry.part === 'incomingCalls')?.kept ?? -1;

    expect(kept('minimal')).toBeLessThan(kept('standard'));
    expect(kept('standard')).toBeLessThan(kept('full'));
  });

  it('records no omission for a list the cap did not reach', () => {
    // 50 callers fit inside `full`'s cap of 200, so nothing was hidden and nothing is claimed to be.
    expect(project(wideSymbolContext(50), { tier: 'full' }).omissions.map((entry) => entry.part)).not.toContain(
      'incomingCalls',
    );
  });

  it('reports no omission for a list that fitted', () => {
    expect(project(symbolContext(), { tier: 'full' }).omissions.map((entry) => entry.part)).not.toContain(
      'limitations',
    );
  });

  it('stays inside its budget', () => {
    for (const tier of ['minimal', 'standard', 'full'] as const) {
      const projection = project(wideSymbolContext(5000), { tier });

      expect(projection.tokens).toBeLessThanOrEqual(TIER_TOKENS[tier]);
    }
  });

  it('subtracts what the prompt scaffolding already reserved', () => {
    const withoutReserve = project(wideSymbolContext(5000), { tier: 'standard' });
    const withReserve = project(wideSymbolContext(5000), { tier: 'standard', reserved: 5000 });

    expect(withReserve.tokens).toBeLessThan(withoutReserve.tokens);
    expect(withReserve.tokens).toBeLessThanOrEqual(TIER_TOKENS.standard - 5000);
  });

  it('a larger tier buys more facts', () => {
    const standard = project(wideSymbolContext(5000), { tier: 'standard' });
    const full = project(wideSymbolContext(5000), { tier: 'full' });

    expect(full.facts.length).toBeGreaterThan(standard.facts.length);
  });

  it('the budget is a real second constraint, not only the caps', () => {
    // A cap bounds how much of one part is worth showing; the budget bounds the whole prompt. Squeezing
    // the budget below what the caps would allow must reduce the facts — otherwise a long question or a
    // long conversation would silently overrun the window.
    const capBound = project(wideSymbolContext(5000), { tier: 'full' });
    const budgetBound = project(wideSymbolContext(5000), { tier: 'full', reserved: TIER_TOKENS.full - 400 });

    expect(budgetBound.facts.length).toBeLessThan(capBound.facts.length);
    expect(budgetBound.tokens).toBeLessThanOrEqual(400);
  });

  it('reports the tokens it actually counted', () => {
    const projection = project(symbolContext(), { tier: 'full' });
    const measured = projection.facts.reduce((sum, fact) => sum + estimatingCounter.count(factLine(fact)), 0);

    expect(projection.tokens).toBe(measured);
  });
});

describe('determinism', () => {
  it('produces an identical projection on repeated calls', () => {
    const context = symbolContext();

    expect(project(context, { tier: 'standard' })).toEqual(project(context, { tier: 'standard' }));
  });

  it('produces the same digest for the same facts and a different one for different facts', () => {
    const first = project(symbolContext(), { tier: 'standard' });
    const again = project(symbolContext(), { tier: 'standard' });
    const wider = project(wideSymbolContext(3), { tier: 'standard' });

    expect(again.digest).toBe(first.digest);
    expect(wider.digest).not.toBe(first.digest);
  });

  it('renders the same bytes for the same facts', () => {
    const lines = (tier: 'standard') => project(symbolContext(), { tier }).facts.map(factLine).join('\n');

    expect(lines('standard')).toBe(lines('standard'));
  });

  it('is plain data with no capability object attached', () => {
    const projection = project(symbolContext(), { tier: 'standard' });
    const serialised = JSON.parse(JSON.stringify({ ...projection, identifiers: [...projection.identifiers] }));

    expect(serialised.facts).toEqual(projection.facts);
  });
});

describe('the repository kind', () => {
  it('states repository scale rather than a subject', () => {
    const projection = project(repositoryContext(), { tier: 'full' });

    expect(projection.subject).toBeNull();
    expect(projection.facts.find((fact) => fact.predicate === 'is-a')?.object).toBe('Repository');
    expect(projection.facts.some((fact) => fact.object === '228 files')).toBe(true);
  });

  it('groups findings by code with a count instead of listing hundreds of nodes', () => {
    const findings = project(repositoryContext(), { tier: 'full' }).facts.filter(
      (fact) => fact.predicate === 'finding',
    );

    expect(findings.map((fact) => fact.object)).toEqual([
      'declaration-isolated (904 nodes)',
      'file-high-fan-in (12 nodes)',
    ]);
  });

  it('carries the coverage figure the health report measured', () => {
    const metrics = project(repositoryContext(), { tier: 'full' }).facts.filter(
      (fact) => fact.predicate === 'metric',
    );

    expect(metrics.some((fact) => fact.object === 'call graph coverage 0.220')).toBe(true);
  });
});

describe('deduplication', () => {
  it('never emits the same fact twice', () => {
    // The context mirrors some edges by design — `references` is "a kind-independent view, not additional
    // data" — so a type reference appears both there and under `related`. Emitting both spent 40 of a real
    // symbol projection's 276 facts on exact duplicates.
    for (const tier of ['minimal', 'standard', 'full'] as const) {
      const facts = project(symbolContext(), { tier }).facts;
      const keys = facts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`);

      expect(new Set(keys).size, tier).toBe(keys.length);
    }
  });

  it('lets the earlier, higher-priority extractor keep the fact', () => {
    const context = symbolContext({
      // The same edge offered by `references.typeReferences` and again by `related`.
      references: {
        incomingCalls: [],
        outgoingCalls: [],
        references: [],
        typeReferences: [
          {
            edge: { id: 't1', type: 'REFERENCES_TYPE', sourceId: CALLER, targetId: SUBJECT, confidence: 'CERTAIN', location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } },
            source: node(CALLER),
          },
        ],
      },
      related: [{ node: node(CALLER), relation: 'type-reference', depth: null, explain: null }],
    });

    const matching = project(context, { tier: 'full' }).facts.filter(
      (fact) => fact.predicate === 'references-type' && fact.subject === CALLER,
    );

    expect(matching).toHaveLength(1);
    // `typeReferences` runs before `related`, so its provenance is the one that survives.
    expect(matching[0]?.provenance).toBe('@traceiq/resolver');
  });

  it('counts only new facts in an omission, not ones already said', () => {
    const projection = project(wideSymbolContext(600), { tier: 'minimal' });
    const omission = projection.omissions.find((entry) => entry.part === 'incomingCalls');

    expect(omission?.total).toBe(600);
    expect(omission?.kept).toBeGreaterThan(0);
  });
});
