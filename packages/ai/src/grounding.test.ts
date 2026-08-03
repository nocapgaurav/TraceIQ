import { describe, expect, it } from 'vitest';

import { node, repositoryContext, symbolContext } from './fixtures.test-helper.js';
import type { ContextProjection } from './facts.js';
import { checkGrounding } from './grounding.js';
import { project } from './projection.js';
import { SYSTEM_PROMPT } from './prompt.js';

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

describe('the range citation form', () => {
  it('expands a range to every fact between its ends', () => {
    // Found in the product, not in a test: the chat page showed `unverifiable` beside a paragraph
    // that had plainly cited `[f8-f12]`. The pattern matched nothing at all, so an answer with five
    // real citations was reported as having none — the same silent-loss failure the combined form
    // was added for, in a shape nobody had written a case for.
    const ids = projection.facts.slice(0, 5).map((fact) => fact.id);
    const report = checkGrounding(`Several languages [${ids[0]}-${ids[4]}].`, projection);

    expect(report.citations.map((citation) => citation.factId)).toEqual(ids);
    expect(report.verdict).toBe('grounded');
  });

  it('reads the abbreviated end of a range, which is how a model usually writes one', () => {
    const ids = projection.facts.slice(0, 3).map((fact) => fact.id);
    const to = (ids[2] as string).slice(1);

    expect(checkGrounding(`[${ids[0]}-${to}]`, projection).citations).toHaveLength(3);
  });

  it('mixes a range with a plain id in one bracket', () => {
    const ids = projection.facts.slice(0, 4).map((fact) => fact.id);
    const report = checkGrounding(`[${ids[0]}-${ids[1]}, ${ids[3]}]`, projection);

    expect(report.citations.map((citation) => citation.factId)).toEqual([ids[0], ids[1], ids[3]]);
  });

  it('reads an absurd range as a mistake rather than as thousands of citations', () => {
    // `[f1-f9999]` is a model error. Expanding it would flood the citation list with ids the answer
    // never used, which would make the evidence a reader checks meaningless.
    const report = checkGrounding(`[${firstFact}-f9999]`, projection);

    expect(report.citations.length).toBeLessThanOrEqual(1);
    expect(report.unknownCitations).toEqual(['f9999']);
  });

  it('does not invent citations from a descending range', () => {
    const report = checkGrounding('[f9-f2]', projection);

    expect(report.citations.length).toBeLessThanOrEqual(2);
  });
});

describe('grounding beyond identifiers', () => {
  /**
   * The failure this closes is the characteristic one for a repository assistant: an answer that names
   * plausible dependencies. A model told a repository is a JavaScript project volunteers `express` and
   * `lodash` because JavaScript projects have them, and before this nothing could contradict it — the
   * claim carries no `ext:` prefix, so the identifier guard never looked at it.
   */
  const withTerms = (terms: readonly string[]): ContextProjection => ({
    ...projection,
    terms: new Set(terms.map((term) => term.toLowerCase())),
  });

  it('accepts a package name the facts carried', () => {
    const report = checkGrounding('It depends on `@reduxjs/toolkit` [f1].', withTerms(['@reduxjs/toolkit']));

    expect(report.unsupportedTerms).toEqual([]);
  });

  it('reports dependencies the facts never carried', () => {
    const report = checkGrounding('It depends on `express` and `@types/node`.', withTerms(['@reduxjs/toolkit']));

    // `express` is a bare lowercase word and deliberately not adjudicated; `@types/node` is scoped and
    // unambiguously a package name, so it is.
    expect(report.unsupportedTerms).toEqual(['@types/node']);
    expect(report.verdict).toBe('ungrounded');
  });

  it('reports a coordinate-shaped claim the facts never carried', () => {
    const report = checkGrounding(
      'It depends on `org.springframework:spring-core`.',
      withTerms(['org.apache.commons:commons-lang3']),
    );

    expect(report.unsupportedTerms).toEqual(['org.springframework:spring-core']);
    expect(report.verdict).toBe('ungrounded');
  });

  it('accepts a scoped package written by its last segment, as prose does', () => {
    const report = checkGrounding('`core` is used [f1].', withTerms(['@babel/core', 'core']));

    expect(report.unsupportedTerms).toEqual([]);
  });

  it('does not adjudicate ordinary prose, however it is quoted', () => {
    // The guard's value is that it is never wrong. A design claim is not decidable against a closed
    // set, and reporting one would make the guard noise — which is how a guard gets switched off.
    const report = checkGrounding(
      'The architecture is `layered` and the code is `well tested`, though nothing measures that.',
      withTerms([]),
    );

    expect(report.unsupportedTerms).toEqual([]);
  });
});

describe('repository-level claims are checkable without becoming over-restrictive', () => {
  /**
   * **The failure mode this guards is the guard itself.** An earlier version marked a *correct* answer
   * about React ungrounded over eight terms the facts plainly carried — region paths printed inside a
   * `built-with` clause, and the file path inside a `sym:` identifier. Compression made the risk worse:
   * a dependency family renders as `12 npm packages under @babel: core, parser, …` and prints no `ext:`
   * id at all, so every member had to stay claimable by name *and* by identity.
   */
  const projection = project(repositoryContext(), { tier: 'full' });

  const answer = [
    'The repository is organised into `packages/core`, `packages/api` and `packages/util` [f1].',
    'It is built with `Express` [f2] and written in `typescript` [f3].',
    'The service `sym:packages/core/src/service.ts#UserService.find` lives in',
    '`packages/core/src/service.ts` and is referenced widely [f4].',
    'It depends on `express` [f5].',
  ].join(' ');

  it('accepts every kind of repository-level name the facts carried', () => {
    const report = checkGrounding(answer, projection);

    expect(report.unsupportedTerms).toEqual([]);
    expect(report.fabricatedIdentifiers).toEqual([]);
  });

  it('still refuses a package the repository does not have', () => {
    const report = checkGrounding('It is organised into `packages/billing` [f1].', projection);

    expect(report.unsupportedTerms).toEqual(['packages/billing']);
  });

  it('grounds a dependency named inside a compressed family', () => {
    // The line prints names only; both the name and the `ext:` identity must remain sayable.
    const base = repositoryContext();
    const withDependencies = project(
      {
        ...base,
        dependencies: {
          ...base.dependencies,
          externalPackages: ['ext:npm:@babel/core', 'ext:npm:@babel/parser'].map((id) => ({ id, name: id })),
        },
      } as unknown as typeof base,
      { tier: 'full' },
    );

    expect(withDependencies.terms.has('@babel/core')).toBe(true);
    expect(withDependencies.terms.has('core')).toBe(true);
    expect(withDependencies.identifiers.has('ext:npm:@babel/core')).toBe(true);
  });

  it('grounds a region path that only appears inside a technology clause', () => {
    const regions = project(repositoryContext(), { tier: 'full' }).terms;

    expect(regions.has('the repository root')).toBe(true);
  });
});

describe('regressions caught in the product', () => {
  /**
   * Each of these is a failure a real model produced against a real repository. They are here rather
   * than as hypotheticals because every one of them was a case somebody had reasoned about and got
   * wrong — the value is in the specific string, not in the shape.
   */
  const withTerms = (terms: readonly string[]): ContextProjection => ({
    ...projection,
    terms: new Set(terms.map((term) => term.toLowerCase())),
  });

  it('accepts a file named the way prose names it, not the way the graph identifies it', () => {
    // `facebook/react`, asked to explain its architecture: a correct, well-cited answer was marked
    // ungrounded over `ModalDialog.js`, `ProfilerContext.js` and `InspectedElementContext.js` — three
    // files whose full paths were in the identifiers it had just been given.
    const paths = [
      'packages/react-devtools-shared/src/devtools/views/ModalDialog.js',
      'packages/react-devtools-shared/src/devtools/views/ProfilerContext.js',
    ];
    const withFiles = project(
      { ...repositoryContext(), related: paths.map((path) => ({ node: node(`file:${path}`, { kind: 'File' }), relation: 'package-file', depth: null, explain: null })) } as never,
      { tier: 'full' },
    );

    const report = checkGrounding(
      'The dialog lives in `ModalDialog.js` and the profiler context in `ProfilerContext.js` [f1].',
      withFiles,
    );

    expect(report.unsupportedTerms).toEqual([]);
    expect(report.verdict).not.toBe('ungrounded');
  });

  it('explains a rejection instead of only listing it', () => {
    const report = checkGrounding('It depends on `@scope/absent`.', withTerms(['@scope/present']));

    expect(report.unsupportedTerms).toEqual(['@scope/absent']);

    const diagnostic = report.diagnostics.find((entry) => entry.kind === 'unsupported-term');

    expect(diagnostic?.subject).toBe('@scope/absent');
    // What it was checked against, so a reader can tell a fabrication from too strict a guard.
    expect(diagnostic?.detail).toContain('names were available');
  });

  it('points at the near miss when one exists, which is how granularity bugs are spotted', () => {
    const report = checkGrounding('`react-devtools-shared/src/x.js` is central.', withTerms(['packages/react-devtools-shared/src/x.js']));
    const diagnostic = report.diagnostics.find((entry) => entry.kind === 'unsupported-term');

    expect(diagnostic?.nearest).toContain('packages/react-devtools-shared/src/x.js');
  });

  it('accepts an identifier written without its prefix, as prose writes it', () => {
    // `facebook/react`, "which declarations are most referenced": the model answered correctly and
    // wrote `packages/react-reconciler/src/ReactInternalTypes.js#Fiber` — the identifier the facts
    // carried, minus the four characters of `sym:`. Marked ungrounded.
    const report = checkGrounding(
      'The busiest is `packages/core/src/service.ts#UserService.find` [f1].',
      projection,
    );

    expect(report.unsupportedTerms).toEqual([]);
  });

  it('accepts a route named by its path', () => {
    // "Explain the architecture": the model named `/todos/:id`, a route the facts carried as
    // `GET /todos/:id`. A route is referred to by its path far more often than by method and path.
    const context = repositoryContext();
    const withRoute = project(
      {
        ...context,
        routes: [
          {
            node: node('route:GET:/todos/:id', { kind: 'Route' }),
            method: 'GET',
            composition: { effectivePath: '/todos/:id', composed: true, note: '' },
          },
        ],
      } as never,
      { tier: 'full' },
    );

    expect(withRoute.terms.has('/todos/:id')).toBe(true);
    expect(checkGrounding('It exposes `/todos/:id` [f1].', withRoute).unsupportedTerms).toEqual([]);
  });

  it('leaves a generalising category word to the prose rule rather than the verifier', () => {
    /*
     * **Reversed, deliberately, and this is the one place the guard was made more permissive.**
     *
     * The facts say `GitHub Actions`, and an answer that writes "CI/CD" has replaced a proved thing with
     * a category — which the standing instruction forbids in as many words. The previous position was
     * that the verifier should catch it too, on the grounds that `CI/CD` is coordinate-shaped. Running
     * real repositories showed what that costs: `CI/CD` appeared inside otherwise correct, well-cited
     * paragraphs and dragged the whole verdict to `ungrounded`, and a user shown that beside a true
     * answer learns to ignore the verdict entirely.
     *
     * The line is now drawn where it is decidable. A *naming* claim — this package, this file, this
     * route — is adjudicable against a closed set, and every one of those still is. Whether "CI/CD" is
     * too general a word for GitHub Actions is a judgement about prose, and the instruction is where
     * judgements about prose belong. See `isProseAcronym`, and the negative controls beside it that
     * prove a real slashed name is still adjudicated.
     */
    const report = checkGrounding('It uses `CI/CD` for builds [f1].', withTerms(['github actions']));

    expect(report.unsupportedTerms).toEqual([]);

    // The instruction that does forbid it is still there, and still says so.
    expect(SYSTEM_PROMPT).toContain('GitHub Actions is not "CI/CD"');
  });

  it('accepts the named technology itself, however it is capitalised', () => {
    const report = checkGrounding('Builds run through `GitHub Actions` [f1].', withTerms(['github actions']));

    expect(report.unsupportedTerms).toEqual([]);
  });

  it('says why an answer with no citations could not be checked', () => {
    /*
     * The sentence used to be "The repository is well organised", which now fails a *different* check —
     * `presence-as-quality`, because nothing in any projection measures how well a repository is organised.
     * That is the right verdict and the wrong test: this one is about the diagnostic an uncited answer
     * gets, so the sentence is now one that claims nothing rather than one that claims something
     * unsupportable. The quality claim has its own test below.
     */
    const report = checkGrounding('The repository holds several directories.', projection);

    expect(report.verdict).toBe('unverifiable');
    expect(report.diagnostics.map((entry) => entry.kind)).toEqual(['no-citations']);
  });

  it('rejects a quality verdict, because nothing in a projection measures quality', () => {
    const report = checkGrounding('The repository is well organised and well documented [f1].', projection);

    expect(report.verdict).toBe('ungrounded');
    expect(report.unsupportedClaims.map((finding) => finding.kind)).toEqual(['presence-as-quality']);
  });

  it('reports nothing at all when an answer is clean', () => {
    const report = checkGrounding(`It is a Method [f1].`, projection);

    expect(report.verdict).toBe('grounded');
    expect(report.diagnostics).toEqual([]);
  });
});
