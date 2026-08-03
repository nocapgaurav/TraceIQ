import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { checkEntailment } from './entailment.js';
import { checkGrounding } from './grounding.js';
import { project } from './projection.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * Claims made of real names that the facts do not license.
 *
 * **Every rule in `entailment.ts` was written against a sentence a model actually produced**, and this
 * file holds those sentences. Each is built entirely from identifiers the projection carried, cites a real
 * fact, and would pass every check the grounding guard had before this: the identifier guard sees a real
 * file, the term guard sees a real package, the citation resolves. What is wrong is the verb.
 *
 * The file is arranged in pairs. For each transformation there is the sentence that must be rejected, the
 * hedged form of the same sentence that must be accepted, and — where the licensing fact exists — a
 * repository on which the flat assertion is fine. A rule that fires on a repository whose facts *do*
 * establish the claim is a rule that punishes correct answers, and that is the failure mode this whole
 * battery is meant to prevent.
 */

const listing = (entries: readonly unknown[], total = entries.length): Record<string, unknown> => ({
  entries,
  total,
  truncated: total > entries.length,
});

const declaration = (id: string, name: string): Record<string, unknown> =>
  node(id, { name, fileId: `file:${id.slice(4).split('#')[0]}` });

/** A repository whose only code is CI scripts, one of which stores a secret. The observed failure case. */
function ciOnly(): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;

  return {
    ...base,
    technologies: [],
    routes: [] as never,
    dependencies: { ...base.dependencies, externalPackages: [], environmentVariables: [] },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          /*
           * No artefact evidence, and that absence is the fixture's whole premise.
           *
           * Its four Python scripts are the repository's only analysable code, and nothing in it declares
           * a job order, a service or a trigger. Every rule below is asking what happens when a claim has
           * *no* fact of a licensing kind behind it, so a fixture carrying a workflow's declared
           * prerequisite would be testing the opposite case — and did, until this line was added.
           */
          artifacts: [],
          keyArtifacts: listing([]),
          repository: { files: 90, declarations: 12, routes: 0 },
          packages: listing([
            { name: '.ci/scripts', files: 4, declarations: 12, dependencies: 0, dependents: 0 },
            { name: '.gitmodules', files: 1, declarations: 0, dependencies: 0, dependents: 0 },
            { name: 'README.md', files: 1, declarations: 0, dependencies: 0, dependents: 0 },
          ]),
        },
        architecture: {
          controllers: listing([]),
          services: listing([]),
          repositories: listing([]),
          middleware: listing([]),
          models: listing([]),
          tests: listing([]),
          routes: listing([], 0),
        },
        hotspots: {
          mostReferenced: listing([
            {
              node: declaration('sym:.ci/scripts/set_secret.py#set_secret', 'set_secret'),
              fanIn: 9,
              fanOut: 2,
              incomingEdges: 9,
              outgoingEdges: 2,
            },
            {
              node: declaration('sym:.ci/scripts/aml_creation.py#main', 'main'),
              fanIn: 4,
              fanOut: 3,
              incomingEdges: 4,
              outgoingEdges: 3,
            },
          ]),
          mostCoupled: listing([]),
          largestFanIn: listing([]),
          mostConnectedFiles: listing([]),
        },
      },
    },
  } as unknown as RepositoryContext;
}

/** A repository that genuinely authenticates: a route, and middleware annotated for access control. */
function guarded(): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;
  const handler = declaration('sym:src/auth/loginController.ts#loginController', 'loginController');

  return {
    ...base,
    technologies: [
      { id: 'express', name: 'Express', category: 'backend', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'express'" },
      { id: 'redis', name: 'Redis', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'ioredis'" },
    ],
    routes: [
      {
        node: node('route:POST:/login', { fileId: 'file:src/auth/routes.ts' }),
        method: 'POST',
        path: '/login',
        composition: { composed: true, prefixes: [], effectivePath: '/login', note: '' },
        handlers: [
          {
            edge: { id: 'e', type: 'HANDLES_ROUTE', sourceId: 'r', targetId: handler.id, confidence: 'CERTAIN' },
            declaration: handler,
          },
        ],
      },
    ] as never,
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          // No artefact evidence either: this fixture exists to show that a *route and middleware*
          // licence an authentication claim, and artefact facts would confound which licence fired.
          artifacts: [],
          keyArtifacts: listing([]),
          repository: { files: 40, declarations: 120, routes: 1 },
          packages: listing([{ name: 'src/auth', files: 8, declarations: 60, dependencies: 0, dependents: 1 }]),
        },
        architecture: {
          controllers: listing([handler]),
          services: listing([]),
          repositories: listing([]),
          middleware: listing([declaration('sym:src/auth/requireAuth.ts#requireAuth', 'requireAuth')]),
          models: listing([]),
          tests: listing([]),
          routes: listing([], 1),
        },
        hotspots: { mostReferenced: listing([]), mostCoupled: listing([]), largestFanIn: listing([]), mostConnectedFiles: listing([]) },
      },
    },
  } as unknown as RepositoryContext;
}

const CI_ONLY = project(ciOnly(), { tier: 'full' });
const GUARDED = project(guarded(), { tier: 'full' });

const claims = (answer: string, projection = CI_ONLY): readonly string[] =>
  checkEntailment(answer, projection).unsupported.map((finding) => finding.kind);

describe('a reference is not an execution order', () => {
  it('rejects a graph edge restated as a sequence', () => {
    // `aml_creation.py` references another script. That records a name, not a moment.
    expect(claims('The deployment workflow begins with `.ci/scripts/aml_creation.py` [f1].')).toContain(
      'execution-order',
    );
    expect(claims('`.ci/scripts/aml_creation.py` then calls the attach step [f1].')).toContain('execution-order');
  });

  it('accepts the same sentence hedged', () => {
    // The honest form of an inference, and the wording the pipeline asks for where one is allowed.
    expect(claims('The deployment appears to begin with `.ci/scripts/aml_creation.py` [f1].')).toEqual([]);
  });

  it('accepts a sequence on a repository whose facts record one', () => {
    // A route-to-handler edge is a recorded chain, so ordering is established and the flat form is right.
    expect(claims('A request begins with `POST /login` [f1].', GUARDED)).toEqual([]);
  });
});

describe('secret management is not an authentication flow', () => {
  it('rejects an authentication architecture assembled from a secret script', () => {
    /*
     * The transformation the milestone names first. Every name is real, the file genuinely manages
     * secrets, and the repository has no authentication anywhere.
     */
    expect(claims('Authentication works through `.ci/scripts/set_secret.py` [f1].')).toContain(
      'secrets-as-authentication',
    );
    expect(claims('Access control is handled by the secret store [f1].')).toContain('secrets-as-authentication');
  });

  it('accepts an authentication claim where middleware and a route establish one', () => {
    expect(claims('Authentication is enforced by `requireAuth` on `POST /login` [f1].', GUARDED)).toEqual([]);
  });

  it('does not treat a secret-shaped variable as the licensing fact', () => {
    // A `JWT_SECRET` is the credential, not the flow. The licence has to come from a route or middleware.
    const withSecret = project(
      {
        ...ciOnly(),
        dependencies: {
          ...ciOnly().dependencies,
          environmentVariables: [node('env:JWT_SECRET', { name: 'JWT_SECRET' })],
        },
      } as unknown as RepositoryContext,
      { tier: 'full' },
    );

    expect(claims('Authentication uses the JWT secret [f1].', withSecret)).toContain('secrets-as-authentication');
  });
});

describe('prominence is not architectural centrality', () => {
  /*
   * **The three sentences below came out of one live answer, and none of the first version's patterns held
   * any of them.** Asked to explain TraceIQ's architecture, the model wrote that a package "sits at a
   * critical intersection", "acts as a bridge between the persistence layer and the rendering layer" and
   * "underpins the rest of the system" — the same claim as "is the core of", in words the rule did not
   * know. The middle one is the most dangerous: it asserts a relationship between two named layers that no
   * edge in the projection records, which is a centrality claim with a direction.
   *
   * What licenses any of them is a fact putting *this thing* at the middle of something. A fan-in count is
   * not on that list and cannot be, because it is the measurement being conflated.
   */
  it.each([
    'The `.ci/scripts` directory sits at a critical intersection of the repository [f1].',
    'It acts as a bridge between the persistence layer and the rendering layer [f1].',
    '`.ci/scripts/set_secret.py` underpins the rest of the system [f1].',
    '`.ci/scripts` is the backbone of this repository [f1].',
    'It is the key component of the build [f1].',
    'This module is business-critical [f1].',
  ])('rejects %j', (sentence) => {
    expect(claims(sentence)).toContain('prominence-as-importance');
  });

  it('accepts the same claim hedged, which is what an inference honestly sounds like', () => {
    expect(claims('It appears to act as a bridge between the two layers [f1].')).toEqual([]);
  });

  it('accepts it flat on a repository whose facts put the thing at the centre of something', () => {
    // `guarded()` records a route and a middleware chain, so a fact does place a declaration in the middle
    // of something and the claim is the model reading the graph rather than filling a gap in it.
    expect(claims('`requireAuth` is the core of the login flow [f1].', GUARDED)).toEqual([]);
  });

  it('leaves the literal word alone where it is not making the claim', () => {
    // A guard that fired on the noun rather than on the construction would be unusable: "the bridge
    // pattern" and "a core dependency" are ordinary prose. Each alternative in the rule is anchored.
    expect(claims('The repository holds 12 declarations under `.ci/scripts` [f1].')).toEqual([]);
    expect(claims('There is a directory named core in the tree [f1].')).toEqual([]);
  });
});

describe('a declared technology is not an observed behaviour', () => {
  it('rejects a dependency restated as a responsibility', () => {
    expect(claims('Redis caches the redirect lookup [f1].', CI_ONLY)).toContain('presence-as-behaviour');
  });

  it('accepts a responsibility the detector itself recorded', () => {
    // `runs-on` carries the category's own responsibility clause, which is what licenses the sentence.
    expect(claims('Redis is responsible for keeping hot data in memory [f1].', GUARDED)).toEqual([]);
  });
});

describe('an absence of evidence is not a nonexistence', () => {
  it('rejects the flat form', () => {
    /*
     * The mirror of everything else here, and it became reachable *because* of this milestone: teaching
     * the pipeline to answer "no caching was identified" invites the stronger sentence.
     */
    expect(claims('This repository has no caching layer [f1].')).toContain('absence-as-nonexistence');
    expect(claims('There is no authentication in this repository [f1].')).toContain('absence-as-nonexistence');
  });

  it('accepts the wording an absence of evidence actually supports', () => {
    expect(claims('No caching mechanism was identified in the analysed evidence [f1].')).toEqual([]);
    expect(claims('The analysis did not detect a cache [f1].')).toEqual([]);
  });
});

describe('a configuration file is not a run', () => {
  it('rejects a workflow file restated as something that happened', () => {
    expect(claims('The pipeline runs nightly against the production cluster [f1].')).toContain(
      'configuration-as-runtime',
    );
  });
});

describe('the guard keeps its existing behaviour', () => {
  it('makes an unsupported claim ungrounded, on the same footing as an invention', () => {
    /*
     * Deliberately not a softer category. A sentence of real names saying an unsupported thing is more
     * misleading than one naming a file that does not exist: the second is obviously wrong to anyone who
     * looks, and the first reads as a finding.
     */
    const report = checkGrounding('Authentication works through `.ci/scripts/set_secret.py` [f1].', CI_ONLY);

    expect(report.verdict).toBe('ungrounded');
    expect(report.unsupportedClaims).toHaveLength(1);
    expect(report.diagnostics.some((entry) => entry.kind === 'unsupported-claim')).toBe(true);
    // The names in it were real, which is exactly why the older checks could not see the problem.
    expect(report.fabricatedIdentifiers).toEqual([]);
    expect(report.unsupportedTerms).toEqual([]);
  });

  it('still grounds an ordinary correct answer', () => {
    const report = checkGrounding(
      'The repository is organised into `.ci/scripts`, which carries 12 declarations [f1].',
      CI_ONLY,
    );

    expect(report.verdict).toBe('grounded');
    expect(report.unsupportedClaims).toEqual([]);
  });

  it('reports a hedged inference without failing it', () => {
    const report = checkGrounding('The deployment appears to begin with `.ci/scripts/aml_creation.py` [f1].', CI_ONLY);

    expect(report.verdict).toBe('grounded');
    expect(report.inferredClaims.map((finding) => finding.kind)).toContain('execution-order');
  });

  it('does not adjudicate a sentence that is reporting what was not established', () => {
    const report = checkGrounding(
      'The analysed evidence does not establish an authentication flow, though the repository stores secrets [f1].',
      CI_ONLY,
    );

    expect(report.verdict).toBe('grounded');
    expect(report.unsupportedClaims).toEqual([]);
  });

  it.each([
    // Every one of these is a sentence a live run produced while answering honestly. A guard that fails
    // the wording the pipeline asked for is worse than no guard.
    // The pipeline's own absence wording, composed by `sufficiencyOf` and handed to the model as the
    // answer to give. The guard rejected it on a live run, which is the guard removing the sentence it
    // asked for — the failure mode that teaches a reader the verdict means nothing.
    'The repository does read secret-shaped configuration, which is credential storage rather than an authentication flow [f1].',
    'The repository contains several CI/CD scripts, but no route or middleware for authentication was found during analysis [f1].',
    'No caching mechanism was detected in the analyzed regions or manifests [f1].',
    'The tests could not be determined from the analysis [f1].',
    'This is a limitation of the analysis rather than a finding about the repository [f1].',
  ])('does not punish the honest wording: %j', (answer) => {
    expect(checkGrounding(answer, CI_ONLY).unsupportedClaims).toEqual([]);
  });

  it('reads "appears that" as a hedge, not only "appears to"', () => {
    // The live run produced "it appears that any such mechanism is not deeply integrated", which the
    // first version of the hedge list missed on a preposition.
    const report = checkGrounding(
      'It appears that the deployment starts from `.ci/scripts/aml_creation.py` [f1].',
      CI_ONLY,
    );

    expect(report.unsupportedClaims).toEqual([]);
    expect(report.inferredClaims.length).toBeGreaterThan(0);
  });

  it('catches "starts from" as well as "starts with"', () => {
    expect(claims('This workflow starts from `.ci/scripts/set_secret.py` [f1].')).toContain('execution-order');
  });

  it('does not read an instruction to the reader as a claim about order', () => {
    // "Start with X" is a recommendation; "the workflow starts with X" asserts an order. A live run
    // flagged the first, which is a guard punishing an answer for being helpful.
    expect(claims('Start with `.ci/scripts/set_secret.py`, which is the smallest of them [f1].')).toEqual([]);
    expect(claims('Read `.ci/scripts/aml_creation.py` first [f1].')).toEqual([]);
  });

  it('leaves prose it cannot classify alone', () => {
    // A validator that fires on sentences it does not understand is one somebody turns off.
    const report = checkGrounding('The repository is small and its layout is conventional [f1].', CI_ONLY);

    expect(report.unsupportedClaims).toEqual([]);
  });
});
