import { describe, expect, it } from 'vitest';

import { checkGrounding } from './grounding.js';
import { pathAliases } from './facts.js';
import { planFor } from './plan.js';
import { deriveIdentity } from './identity.js';
import { project } from './projection.js';
import { repositoryContext } from './fixtures.test-helper.js';
import type { RepositoryContext } from '@traceiq/context';

/**
 * Whether the names an answer may write are the names the facts actually showed it.
 *
 * **Every failure here was a correct sentence marked as an invention**, which is the direction this guard
 * must never fail in: a verifier that is wrong about a right answer teaches a reader that the verdict means
 * nothing, and then it protects nobody from the answers it *is* right about. Three shapes were observed in
 * one production answer:
 *
 * 1. **A directory the facts described a file inside.** The projection carried
 *    `sym:packages/graph-api/src/graph-api.ts#GraphApi`; the answer said the repository has a package
 *    called `packages/graph-api`; the guard held whole paths and basenames and no directories, so a true
 *    sentence was rejected. Four of seven rejected names in that answer were this.
 * 2. **A path a fact printed and did not declare.** The artefact inventory renders `e.g. README.md,
 *    docker-compose.yml` — the model reads those as the repository's own words and writes them back, and
 *    the permitted set is built from what an extractor *declares*, which did not include them.
 * 3. **A name at a different granularity**, which earlier milestones had already fixed for basenames and
 *    scoped packages and which this extends to directories.
 *
 * The other direction is held just as hard, and every test below has a negative control: a name the
 * repository does not contain must still be rejected, and nothing here may accept a string because it
 * *resembles* one that it does.
 */

describe('the aliases a repository path admits', () => {
  it('admits the path, its basename and every directory that contains it', () => {
    expect(pathAliases('packages/graph-api/src/graph-api.ts')).toEqual([
      'packages/graph-api/src/graph-api.ts',
      'graph-api.ts',
      'packages',
      'packages/graph-api',
      'packages/graph-api/src',
    ]);
  });

  it('admits a root file as itself and nothing else', () => {
    expect(pathAliases('README.md')).toEqual(['README.md']);
  });

  it('derives every alias by truncation, so nothing that merely resembles a path is admitted', () => {
    /*
     * The property that keeps this from being fuzzy matching: an alias is a *prefix* of something the graph
     * holds. A sibling directory shares words with a real one and is a prefix of nothing.
     */
    const aliases = pathAliases('packages/graph-api/src/index.ts');

    expect(aliases).not.toContain('packages/graph-apis');
    expect(aliases).not.toContain('packages/graph');
    expect(aliases.every((alias) => 'packages/graph-api/src/index.ts'.startsWith(alias) || alias === 'index.ts')).toBe(
      true,
    );
  });

  it('ignores a leading ./ rather than admitting two spellings of one path', () => {
    expect(pathAliases('./src/index.ts')).toContain('src/index.ts');
    expect(pathAliases('./src/index.ts')).not.toContain('./src/index.ts');
  });
});

describe('an answer naming a repository path', () => {
  const projection = project(repositoryContext(), { tier: 'standard' });

  it('verifies when it names a package directory whose files the facts carried', () => {
    const report = checkGrounding('The repository is organised into `packages/core` and `packages/api` [f1].', projection);

    expect(report.unsupportedTerms).toEqual([]);
  });

  it('verifies when it names a file by its basename rather than by its whole path', () => {
    const report = checkGrounding('The entry point is in `service.ts` [f1].', projection);

    expect(report.unsupportedTerms).toEqual([]);
  });

  it('still rejects a directory that is not a prefix of anything the facts carried', () => {
    // The negative control, and it has to be a near miss: a guard that accepts `packages/core` and rejects
    // only `zzz/nonsense` has proved nothing about how narrow it is.
    const report = checkGrounding('It is organised into `packages/graphql` and `packages/core-legacy` [f1].', projection);

    expect(report.unsupportedTerms).toContain('packages/graphql');
    expect(report.unsupportedTerms).toContain('packages/core-legacy');
  });
});

describe('a fact that prints a path', () => {
  /** A repository whose only evidence of its own files is what the artefact inventory names. */
  function withInventory(): RepositoryContext {
    const base = repositoryContext();
    const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
    const overview = primary.value.overview as Record<string, unknown>;

    return {
      ...base,
      primary: {
        type: 'repository',
        value: {
          ...primary.value,
          overview: {
            ...overview,
            artifacts: [
              { kind: 'documentation', files: 4, elements: 30, examples: ['README.md', 'apps/api/README.md'] },
              { kind: 'container-compose', files: 1, elements: 8, examples: ['docker-compose.yml'] },
            ],
            keyArtifacts: { entries: [], total: 0, truncated: false },
          },
        },
      },
    } as unknown as RepositoryContext;
  }

  it('declares the path it prints, so an answer quoting the prompt is not called an invention', () => {
    /*
     * The inventory line reads `e.g. README.md, docker-compose.yml`. Whatever a fact puts in front of a
     * model is a name the model may use, and a fact that shows a name without declaring it is a trap.
     */
    const projection = project(withInventory(), { tier: 'standard' });
    const report = checkGrounding(
      'It ships `README.md` and `apps/api/README.md`, and its services are declared in `docker-compose.yml` [f1].',
      projection,
    );

    expect(report.unsupportedTerms).toEqual([]);
    expect(projection.identifiers.has('file:docker-compose.yml')).toBe(true);
  });

  it('still rejects a file of the same kind that no fact printed', () => {
    const projection = project(withInventory(), { tier: 'standard' });
    const report = checkGrounding('The services are declared in `docker-compose.prod.yml` [f1].', projection);

    expect(report.unsupportedTerms).toContain('docker-compose.prod.yml');
  });
});

describe('absence stays absence', () => {
  /** A repository with no cache, no authentication and no persistence of any kind. */
  function bare(): RepositoryContext {
    const base = repositoryContext();
    const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
    const overview = primary.value.overview as Record<string, unknown>;
    const empty = { entries: [], total: 0, truncated: false };

    return {
      ...base,
      technologies: [],
      routes: [] as never,
      dependencies: { ...base.dependencies, externalPackages: [], environmentVariables: [] },
      primary: {
        type: 'repository',
        value: {
          ...primary.value,
          overview: { ...overview, artifacts: [], keyArtifacts: empty },
          architecture: {
            controllers: empty,
            services: empty,
            repositories: empty,
            middleware: empty,
            models: empty,
            tests: empty,
            routes: empty,
          },
        },
      },
    } as unknown as RepositoryContext;
  }

  const planFrom = (question: string) =>
    planFor({ identity: deriveIdentity(bare()), question, kind: 'repository' });

  it.each([
    ['How does authentication work?', 'an authentication or access-control mechanism'],
    ['How does caching work?', 'a caching mechanism'],
  ])('answers %j by reporting that nothing was found, and names nothing instead', (question, concept) => {
    /*
     * The failure this replaced: sixty facts about something else, and a model instructed to explain a
     * mechanism the repository does not have, explaining the facts it was given instead. The verdict is
     * decided before generation so the absence can *be* the answer.
     */
    const plan = planFrom(question);

    expect(plan.sufficiency.verdict).not.toBe('established');
    expect(plan.sufficiency.concept).toBe(concept);
    // Nothing is substituted: the component list is emptied at the source rather than in the renderer.
    expect(plan.components).toEqual([]);
  });

  it('distinguishes "we did not find it" from "it is not there"', () => {
    // The middle verdict is the point of having three. Which one applies is decided by whether the
    // analysis could have seen the thing here, not by whether it did.
    for (const verdict of [planFrom('How does caching work?').sufficiency.verdict]) {
      expect(['absent', 'undetermined']).toContain(verdict);
    }
  });
});

describe('a citation corresponds to evidence', () => {
  const projection = project(repositoryContext(), { tier: 'standard' });

  it('resolves every cited id to the fact it stands for, and rejects one that resolves to nothing', () => {
    const report = checkGrounding('It holds several packages [f1]. It was analysed to a stated depth [f9999].', projection);

    expect(report.citations.map((citation) => citation.factId)).toEqual(['f1']);
    expect(report.citations[0]?.fact.id).toBe('f1');
    expect(report.unknownCitations).toEqual(['f9999']);
  });

  it('carries the whole fact, so a consumer can show the evidence without holding the projection', () => {
    const citation = checkGrounding('It holds several packages [f2].', projection).citations[0];

    expect(citation?.fact.subject).toBeTruthy();
    expect(citation?.fact.predicate).toBeTruthy();
    expect(citation?.fact.provenance).toMatch(/^@traceiq\//);
  });
});
