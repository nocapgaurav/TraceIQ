import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { TIER_TOKENS, estimatingCounter } from './budget.js';
import { factLine } from './facts.js';
import {
  CALLER,
  SUBJECT,
  node,
  repositoryContext,
  symbolContext,
  wideRepositoryContext,
  wideSymbolContext,
} from './fixtures.test-helper.js';
import { intentOf } from './intent.js';
import { assemble, stablePrefixOf } from './prompt.js';
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

describe('dependencies are real, in every ecosystem', () => {
  /**
   * Measured on `facebook/react`: 740 external nodes, of which 395 are `ext:builtin:*` and 11 are
   * `ext:node:*`. The list is alphabetical by identifier, so `ext:builtin:` sorts first and the fifteen
   * "dependencies" a `standard` projection showed were fifteen language builtins. React's 333 npm
   * packages never reached a prompt.
   */
  const withExternals = (ids: readonly string[]): RepositoryContext => {
    const context = repositoryContext();

    return {
      ...context,
      dependencies: {
        ...context.dependencies,
        externalPackages: ids.map((id) => ({ id, name: id, kind: 'External' })),
      },
    } as unknown as RepositoryContext;
  };

  /** Dependencies are grouped by namespace, so the assertion is on what is *named*, not on line count. */
  const dependencies = (context: RepositoryContext): readonly string[] => {
    const projection = project(context, { tier: 'full' });
    const text = projection.facts
      .filter((fact) => fact.predicate === 'depends-on')
      .map((fact) => fact.object)
      .join(' | ');

    return context.dependencies.externalPackages
      .map((node) => node.id)
      .filter((id) => [...projection.identifiers].includes(id) && text.length > 0);
  };

  it('drops language builtins and standard libraries, and keeps every ecosystem', () => {
    const kept = dependencies(
      withExternals([
        'ext:builtin:Promise',
        'ext:node:fs',
        'ext:stdlib:java.util',
        'ext:outside-analysis',
        'ext:npm:react-dom',
        'ext:python:flask',
        'ext:maven:org.springframework:spring-core',
        'ext:go:github.com/gin-gonic/gin',
        'ext:cargo:serde',
        'ext:nuget:Newtonsoft.Json',
      ]),
    );

    expect([...kept].sort()).toEqual(
      [
        'ext:cargo:serde',
        'ext:go:github.com/gin-gonic/gin',
        'ext:maven:org.springframework:spring-core',
        'ext:npm:react-dom',
        'ext:nuget:Newtonsoft.Json',
        'ext:python:flask',
      ].sort(),
    );
  });

  it('admits an ecosystem nobody has added yet, because the filter denies rather than allows', () => {
    // The whole reason the strategy is a deny list: a tenth packaging system must not silently vanish
    // from every answer until somebody remembers to edit a constant.
    expect(dependencies(withExternals(['ext:hex:phoenix']))).toEqual(['ext:hex:phoenix']);
  });

  it('makes a dependency name citable without its identity prefix', () => {
    // A model writes `react-dom`, not `ext:npm:react-dom`. Grounding has to accept the form prose uses.
    const projection = project(withExternals(['ext:npm:react-dom']), { tier: 'full' });

    expect(projection.terms.has('react-dom')).toBe(true);
  });

  it('keeps every grouped member citable by its identifier, though the line prints only names', () => {
    // Compression must not shrink what an answer is allowed to say. The family renders as
    // "12 npm packages under @babel: core, parser, …" and every member stays a permitted identifier.
    const projection = project(
      withExternals(['ext:npm:@babel/core', 'ext:npm:@babel/parser', 'ext:npm:@babel/traverse']),
      { tier: 'full' },
    );
    const line = projection.facts.find((fact) => fact.predicate === 'depends-on')?.object ?? '';

    expect(line).toContain('3 npm packages under @babel');
    expect(line).not.toContain('ext:npm:');

    for (const id of ['ext:npm:@babel/core', 'ext:npm:@babel/parser', 'ext:npm:@babel/traverse']) {
      expect(projection.identifiers.has(id), id).toBe(true);
    }
  });
});

describe('the repository can be described, not merely counted', () => {
  const facts = (predicate: string): readonly string[] =>
    project(repositoryContext(), { tier: 'full' })
      .facts.filter((fact) => fact.predicate === predicate)
      .map((fact) => `${fact.subject} ${fact.object}`);

  it('names the largest packages first, rather than the alphabetically first', () => {
    const packages = facts('has-package');

    expect(packages[0]).toContain('packages/core');
    // The dotfile the Explorer returns first is last here, and present rather than filtered away.
    expect(packages.at(-1)).toContain('.editorconfig');
  });

  it('names the roles that describe the system and counts the ones that do not', () => {
    expect(facts('has-role').join(' ')).toContain('Controller');
    expect(facts('metric').join(' ')).toContain('declarations carry the Test role');
  });

  it('reports hotspots with the measurement that ordered them', () => {
    expect(facts('hotspot').join(' ')).toContain('referenced by 63 distinct declarations');
  });

  it('reports a file nothing imports as an entry point, with its ambiguity stated', () => {
    const entry = facts('entry-point').join(' ');

    expect(entry).toContain('no analysed file imports it');
    expect(entry).toContain('or code nothing reaches');
  });

  it('projects technologies for the repository kind, which it never used to', () => {
    // The repository kind returned from `identity` before reaching the technology loop, so
    // "what technologies are used" was unanswerable about a repository and answerable about a symbol.
    expect(facts('built-with').length).toBeGreaterThan(0);
  });
});

describe('the prefix is stable across questions, and the tail is not', () => {
  /**
   * **This is the property the warm path is bought with.** The provider caches the longest prompt
   * prefix it has already evaluated; measured on the reference stack, a repeat question reused 4,832 of
   * 4,843 tokens and answered in 19 seconds against 108 cold. Asserting byte equality here is what stops
   * a future change quietly turning every question back into a cold one.
   */
  const model = {
    id: 'test',
    contextWindow: 16_384,
    maxOutputTokens: null,
    capabilities: new Set(['system-prompt'] as const),
  };

  const promptFor = (question: string): { prefix: string; whole: string } => {
    const projection = project(repositoryContext(), { tier: 'standard', intent: intentOf(question) });

    return {
      prefix: stablePrefixOf(projection),
      whole: assemble({ question, projection, model }).map((message) => message.content).join('\n'),
    };
  };

  it('renders byte-identical bytes before the question, whatever the question was', () => {
    const architecture = promptFor('Explain the architecture and its layers.');
    const technology = promptFor('What frameworks and dependencies are used?');
    const hotspots = promptFor('Which declarations are most referenced?');

    expect(architecture.prefix).toBe(technology.prefix);
    expect(technology.prefix).toBe(hotspots.prefix);
    expect(architecture.prefix.length).toBeGreaterThan(0);
  });

  it('starts every prompt with that prefix, so the provider can reuse it', () => {
    const { prefix, whole } = promptFor('Explain the architecture.');

    expect(whole).toContain(prefix);
  });

  it('still answers different questions differently, or the intent would be pointless', () => {
    const architecture = promptFor('Explain the architecture and its layers.');
    const technology = promptFor('What frameworks and dependencies are used?');

    expect(architecture.whole).not.toBe(technology.whole);
  });

  it('withholds nothing when the whole repository fits, so a small one is never rationed', () => {
    const projection = project(repositoryContext(), { tier: 'standard', intent: 'technology' });

    expect(projection.intent).toBe('technology');
    expect(projection.coreCount).toBe(projection.facts.length);
  });

  it('leads the supplement with the part the question is about, once there is a supplement', () => {
    // A repository large enough that the core cannot hold it, which is the only case where the intent
    // can change anything. `minimal` squeezes the core hard for the same reason.
    const wide = wideRepositoryContext(60);
    const technology = project(wide, { tier: 'minimal', intent: 'technology' });
    const hotspots = project(wide, { tier: 'minimal', intent: 'hotspots' });

    const leading = (projection: ReturnType<typeof project>): string | undefined =>
      projection.facts[projection.coreCount]?.predicate;

    expect(technology.coreCount).toBeLessThan(technology.facts.length);
    expect(leading(technology)).toBe('built-with');
    expect(leading(hotspots)).toBe('hotspot');
  });

  it('keeps the core a real projection, so a misclassified question still gets a usable answer', () => {
    const projection = project(repositoryContext(), { tier: 'standard', intent: 'hotspots' });
    const core = projection.facts.slice(0, projection.coreCount);
    const predicates = new Set(core.map((fact) => fact.predicate));

    // Identity, composition and the repository's own units are in the core regardless of intent.
    expect(predicates.has('has-package')).toBe(true);
    expect(predicates.has('written-in')).toBe(true);
    expect(projection.coreCount).toBeGreaterThan(5);
  });
});

describe('compression buys facts rather than tokens', () => {
  it('states every language on one line instead of one line each', () => {
    const written = project(repositoryContext(), { tier: 'standard' }).facts.filter(
      (fact) => fact.predicate === 'written-in',
    );

    expect(written).toHaveLength(1);
  });

  it('groups regions by language and depth, accounting for every one of them', () => {
    const regions = project(repositoryContext(), { tier: 'standard' }).facts.filter(
      (fact) => fact.predicate === 'region-depth',
    );

    expect(regions.length).toBeGreaterThan(0);
    expect(regions.map((fact) => fact.object).join(' ')).toMatch(/regions? \(/);
  });

  it('names role members on one line per role rather than one per declaration', () => {
    const roles = project(repositoryContext(), { tier: 'standard' }).facts.filter(
      (fact) => fact.predicate === 'has-role',
    );

    expect(roles.every((fact) => fact.subject === 'repository')).toBe(true);
    expect(roles.map((fact) => fact.object).join(' ')).toContain('Controller:');
  });
});

describe('intentOf', () => {
  it('reads the question, and falls back to a balanced projection', () => {
    expect(intentOf('What frameworks does this use?')).toBe('technology');
    expect(intentOf('Which modules are most referenced?')).toBe('hotspots');
    expect(intentOf('What are the main packages?')).toBe('packages');
    expect(intentOf('Explain the architecture.')).toBe('architecture');
    expect(intentOf('Tell me something.')).toBe('overview');
  });

  it('matches whole words, so a substring cannot classify a question', () => {
    // `packaging` is not `package`; a classifier that matched substrings would send a question about
    // build packaging to the package graph.
    expect(intentOf('How is packaging handled?')).toBe('overview');
  });
});
