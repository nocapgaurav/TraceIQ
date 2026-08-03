import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { estimatingCounter } from './budget.js';
import type { Turn } from './conversation.js';
import { deriveIdentity } from './identity.js';
import { deriveState } from './memory.js';
import { planFor, type AnswerPlan } from './plan.js';
import { project } from './projection.js';
import { deriveStructure } from './structure.js';
import { questionGuidance, repositoryGuidance } from './strategy.js';
import { fixedReservedTokens, reservedTokens } from './prompt.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * Semantic understanding, across the repository shapes that break it.
 *
 * **The failures this file holds all have one cause: structural prominence read as semantic importance.**
 * On an umbrella repository of git submodules whose only analysable code is four CI scripts, a fan-in
 * count is a perfectly accurate measurement and a completely wrong answer — `set_secret.py` really is the
 * most-referenced declaration, and it is not what the repository is for, not the test to read first, and
 * not an authentication system. Every scenario below is a repository shape where the measurement and the
 * meaning come apart.
 *
 * Nothing here is named after a real repository, and no rule anywhere reads a repository name. The shapes
 * are the general cases the brief enumerates; the numbers are what makes each shape itself.
 */

const listing = (entries: readonly unknown[], total = entries.length): Record<string, unknown> => ({
  entries,
  total,
  truncated: total > entries.length,
});

const declaration = (id: string, name: string): Record<string, unknown> =>
  node(id, { name, fileId: `file:${id.slice(4).split('#')[0]}` });

const hotspot = (id: string, name: string, fanIn: number): Record<string, unknown> => ({
  node: declaration(id, name),
  fanIn,
  fanOut: 2,
  incomingEdges: fanIn,
  outgoingEdges: 2,
});

const technology = (name: string, category: string, regionPath = ''): Record<string, unknown> => ({
  id: name.toLowerCase(),
  name,
  category,
  regionPath,
  confidence: 'CERTAIN',
  evidence: `declares '${name.toLowerCase()}'`,
});

const region = (path: string, sources: number, packaged = true): Record<string, unknown> => ({
  path,
  primaryLanguage: 'typescript',
  depth: 'semantic',
  fileCount: sources * 2,
  sourceFileCount: sources,
  reason: 'analysed',
  ecosystems: packaged ? ['npm'] : [],
});

interface Shape {
  readonly packages: readonly { name: string; files: number; declarations: number; dependents?: number }[];
  readonly regions?: readonly Record<string, unknown>[];
  readonly technologies?: readonly Record<string, unknown>[];
  readonly hotspots?: readonly Record<string, unknown>[];
  readonly layers?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly routes?: readonly Record<string, unknown>[];
  readonly environmentVariables?: readonly string[];
  readonly declarations?: number;
}

function build(shape: Shape): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;
  const layers = shape.layers ?? {};

  return {
    ...base,
    technologies: shape.technologies ?? [],
    routes: (shape.routes ?? []) as never,
    capabilities: { ...base.capabilities, regions: shape.regions ?? [region('', 10)] },
    dependencies: {
      ...base.dependencies,
      externalPackages: [],
      environmentVariables: (shape.environmentVariables ?? []).map((name) => node(`env:${name}`, { name })),
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          repository: {
            files: shape.packages.reduce((sum, entry) => sum + entry.files, 0),
            declarations: shape.declarations ?? shape.packages.reduce((sum, entry) => sum + entry.declarations, 0),
            routes: (shape.routes ?? []).length,
          },
          packages: listing(
            shape.packages.map((entry) => ({
              name: entry.name,
              files: entry.files,
              declarations: entry.declarations,
              dependencies: 0,
              dependents: entry.dependents ?? 0,
            })),
          ),
        },
        architecture: {
          controllers: listing(layers.Controller ?? []),
          services: listing(layers.Service ?? []),
          repositories: listing(layers.Repository ?? []),
          middleware: listing(layers.Middleware ?? []),
          models: listing(layers.Model ?? []),
          tests: listing(layers.Test ?? []),
          routes: listing([], (shape.routes ?? []).length),
        },
        hotspots: {
          mostReferenced: listing(shape.hotspots ?? []),
          mostCoupled: listing([]),
          largestFanIn: listing([]),
          mostConnectedFiles: listing([]),
        },
      },
    },
  } as unknown as RepositoryContext;
}

// ---------------------------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------------------------

/** D + E: an umbrella of submodules whose only analysable code is CI. The observed failure. */
const UMBRELLA = build({
  packages: [
    { name: '.ci/scripts', files: 4, declarations: 12 },
    { name: '.ci/steps', files: 43, declarations: 0 },
    { name: '.gitmodules', files: 1, declarations: 0 },
    { name: 'CloudDeployment/Identity', files: 4, declarations: 0 },
    { name: 'README.md', files: 1, declarations: 0 },
    { name: 'x100-samples', files: 5, declarations: 0 },
  ],
  regions: [region('', 3, false)],
  hotspots: [
    hotspot('sym:.ci/scripts/set_secret.py#set_secret', 'set_secret', 9),
    hotspot('sym:.ci/scripts/aml_creation.py#main', 'main', 4),
  ],
  environmentVariables: ['AZURE_CLIENT_SECRET', 'SUBSCRIPTION_KEY'],
});

/** A: an ordinary application, with a cache, a route and tests. */
const APPLICATION = build({
  packages: [
    { name: 'src', files: 40, declarations: 300, dependents: 0 },
    { name: 'tests', files: 12, declarations: 40 },
    { name: '.github', files: 6, declarations: 0 },
  ],
  regions: [region('', 4), region('src', 40, false)],
  technologies: [technology('Express', 'backend'), technology('Redis', 'data'), technology('Docker', 'infrastructure')],
  layers: {
    Controller: [declaration('sym:src/urlController.ts#urlController', 'urlController')],
    Service: [declaration('sym:src/urlService.ts#urlService', 'urlService')],
    Middleware: [declaration('sym:src/requireAuth.ts#requireAuth', 'requireAuth')],
    Test: [declaration('sym:tests/urlService.test.ts#urlServiceTest', 'urlServiceTest')],
  },
  hotspots: [hotspot('sym:src/urlService.ts#urlService', 'urlService', 30)],
  routes: [
    {
      node: node('route:POST:/urls', { fileId: 'file:src/routes.ts' }),
      method: 'POST',
      path: '/urls',
      composition: { composed: true, prefixes: [], effectivePath: '/urls', note: '' },
      handlers: [
        {
          edge: { id: 'e', type: 'HANDLES_ROUTE', sourceId: 'r', targetId: 'sym:src/urlController.ts#urlController', confidence: 'CERTAIN' },
          declaration: declaration('sym:src/urlController.ts#urlController', 'urlController'),
        },
      ],
    },
  ],
  environmentVariables: ['REDIS_URL'],
});

/** I + K: the same application with no cache, and secrets but no guard. */
const NO_CACHE = build({
  packages: [
    { name: 'src', files: 40, declarations: 300 },
    { name: '.github', files: 6, declarations: 0 },
  ],
  regions: [region('', 4), region('src', 40, false)],
  technologies: [technology('Express', 'backend')],
  layers: { Service: [declaration('sym:src/reportService.ts#reportService', 'reportService')] },
  hotspots: [hotspot('sym:src/reportService.ts#reportService', 'reportService', 20)],
  environmentVariables: ['API_SECRET_KEY'],
});

/** G: a repository with no identifiable tests. */
const UNTESTED = build({
  packages: [{ name: 'lib', files: 20, declarations: 120 }],
  regions: [region('', 2), region('lib', 20, false)],
  layers: { Service: [declaration('sym:lib/core.ts#core', 'core')] },
  hotspots: [hotspot('sym:lib/core.ts#core', 'core', 15)],
});

const plan = (context: RepositoryContext, question: string): AnswerPlan =>
  planFor({ identity: deriveIdentity(context), question, kind: 'repository' });

// ---------------------------------------------------------------------------------------------

describe('a repository knows what kind of thing it is before it ranks anything', () => {
  it('reads an umbrella of submodules as an umbrella, not as its CI', () => {
    const structure = deriveStructure(UMBRELLA);

    expect(structure.category).toBe('umbrella');
    expect(structure.categoryEvidence.join(' ')).toContain('git submodules');
    // The map that says so, which the declarations cannot see.
    expect(structure.areas.map((area) => `${area.name}:${area.role}`)).toEqual(
      expect.arrayContaining(['.ci:ci', 'CloudDeployment:deployment', 'x100-samples:sample']),
    );
  });

  it('reads an ordinary application as a codebase', () => {
    expect(deriveStructure(APPLICATION).category).toBe('codebase');
  });

  it('puts the repository’s own category in the cacheable guidance', () => {
    const identity = deriveIdentity(UMBRELLA);
    const guidance = repositoryGuidance(identity.profile, identity);

    // Without this the guidance opened "what kind of project this is could not be established", and the
    // model built an answer out of the only thing it had.
    expect(guidance).toContain('umbrella repository');
    expect(guidance).toContain('top-level areas');
  });
});

describe('structural prominence does not become semantic importance', () => {
  it('keeps CI scripts out of the components a repository-wide question is answered from', () => {
    /*
     * `set_secret` genuinely has the highest fan-in in the repository. It is still not what the
     * repository is for, and an architecture answer built from it was the headline failure.
     */
    const architecture = plan(UMBRELLA, 'Explain the architecture.');

    expect(architecture.components.map((component) => component.id)).toEqual([]);
    expect(deriveIdentity(UMBRELLA).critical).toEqual([]);
  });

  it('still ranks them when the question is about the thing they belong to', () => {
    // The other half: excluding CI from the architecture must not make CI unanswerable.
    const deployment = plan(UMBRELLA, 'What handles deployment?');

    expect(deployment.roles).toContain('ci');
    expect(deployment.components.map((component) => component.name)).toContain('set_secret');
  });

  it('ranks the application’s own code for the application’s own questions', () => {
    const architecture = plan(APPLICATION, 'Explain the architecture.');

    expect(architecture.components.map((component) => component.name)).toContain('urlService');
  });
});

describe('a question about a kind of code retrieves that kind of code', () => {
  it('answers a test question from tests, and not from hotspots', () => {
    const tests = plan(APPLICATION, 'What tests should I read first?');

    expect(tests.roles).toEqual(['test']);
    expect(tests.components.map((component) => component.name)).toContain('urlServiceTest');
    // The failure being fixed: the most-referenced declaration substituting for a test.
    expect(tests.components.map((component) => component.name)).not.toContain('urlService');
  });

  it('substitutes nothing where the repository has no tests', () => {
    const tests = plan(UNTESTED, 'What tests should I read first?');

    expect(tests.components).toEqual([]);
    expect(tests.sufficiency.verdict).not.toBe('established');
  });

  it('answers a deployment question from deployment and CI code', () => {
    const deployment = plan(UMBRELLA, 'What handles deployment?');

    expect(deployment.roles).toEqual(['deployment', 'ci', 'script']);
  });
});

describe('absence is an answer', () => {
  it('reports a missing cache as missing, and asks for a short answer', () => {
    const caching = plan(NO_CACHE, 'How does caching work?');
    const guidance = questionGuidance(caching.strategy, caching);

    expect(caching.sufficiency.verdict).toBe('absent');
    expect(guidance).toContain('did not identify a caching mechanism');
    expect(guidance).toContain('two or three sentences');
    // The padding this replaces: a full section list and a ranked component list about something else.
    expect(guidance).not.toContain('Build the answer in this order');
  });

  it('reports a cache that exists as established', () => {
    expect(plan(APPLICATION, 'How does caching work?').sufficiency.verdict).toBe('established');
  });

  it('names nothing at all when the answer is that nothing was found', () => {
    /*
     * The padding, closed at the source. The planner used to return the repository's default component
     * ranking — its most-referenced declarations, about something else entirely — for a question whose
     * answer is one sentence, and the reported shape claimed six components an answer never used.
     */
    expect(plan(NO_CACHE, 'How does caching work?').components).toEqual([]);
    // The control: a question whose evidence exists still gets its components. A *focused* caching
    // question is not that control — it filters components by the subject's name and legitimately finds
    // none, because the answer comes from the technology facts rather than from a declaration.
    expect(plan(APPLICATION, 'Explain the architecture.').components.length).toBeGreaterThan(0);
  });

  it('keeps the relevant components of a role-restricted question that could not be settled', () => {
    /*
     * The exception, and it is not a loophole. No detector could name this repository's deployment
     * technology, so the *model* is undetermined — but the CI scripts that do the deploying are real,
     * relevant and exactly what the question asked for.
     */
    const deployment = plan(UMBRELLA, 'What handles deployment?');

    expect(deployment.sufficiency.verdict).toBe('undetermined');
    expect(deployment.components.length).toBeGreaterThan(0);
  });

  it('separates secret storage from an authentication flow', () => {
    /*
     * K, and the sharpest case in the brief. The repository reads `API_SECRET_KEY`; it has no middleware
     * named for access control and serves no route of its own. Credential storage is not a flow.
     */
    const auth = plan(NO_CACHE, 'How does authentication work?');

    expect(auth.sufficiency.verdict).not.toBe('established');
    expect(auth.sufficiency.detail).toContain('credential storage rather than an authentication flow');
  });

  it('reports authentication that exists as established', () => {
    expect(plan(APPLICATION, 'How does authentication work?').sufficiency.verdict).toBe('established');
  });

  it('says the analysis could not look, rather than that nothing is there', () => {
    /*
     * The distinction the brief insists on. This repository's code was never parsed deeply enough to
     * carry a declaration, so "no authentication middleware" is a fact about the reading. Claiming
     * absence from it would be the same overreach in the opposite direction.
     */
    const auth = plan(UMBRELLA, 'How does authentication work?');

    expect(auth.sufficiency.verdict).toBe('undetermined');
    expect(questionGuidance(auth.strategy, auth)).toContain('could not be determined');
  });
});

describe('explicit current-turn intent outranks inherited focus', () => {
  const turn = (question: string, answer: string): Turn => ({
    id: `t:${question}`,
    question,
    subject: { kind: 'repository' } as never,
    answer,
    citations: [],
    verdict: 'grounded',
    projectionDigest: 'd',
    model: 'm',
  });

  it('does not answer an authentication question with the deployment the session was about', () => {
    const identity = deriveIdentity(UMBRELLA);
    const state = deriveState(
      { turns: [turn('What handles deployment?', 'The CI scripts under .ci/scripts do.')] },
      identity,
    );

    const auth = planFor({ identity, question: 'How does authentication work?', kind: 'repository', state });

    // The session was about deployment; the question is not. The intent decides.
    expect(auth.intent).toBe('security');
    expect(auth.roles).not.toContain('deployment');
  });

  it('still carries the focus into a question that names nothing', () => {
    const identity = deriveIdentity(APPLICATION);
    const state = deriveState({ turns: [turn('How does caching work?', 'Redis answers repeated reads.')] }, identity);
    const followUp = planFor({ identity, question: 'Where is this implemented?', kind: 'repository', state });

    expect(followUp.continues).toBe(true);
  });
});

describe('the budget and the prefix survive all of it', () => {
  const count = (text: string): number => estimatingCounter.count(text);

  const reservedFor = (context: RepositoryContext, question: string): number => {
    const identity = deriveIdentity(context);
    const planned = planFor({ identity, question, kind: 'repository' });

    return reservedTokens({
      question,
      count,
      guidance: `${repositoryGuidance(identity.profile, identity)}\n${questionGuidance(planned.strategy, planned)}`,
    });
  };

  it('keeps every question inside the tier', () => {
    for (const context of [UMBRELLA, APPLICATION, NO_CACHE, UNTESTED]) {
      for (const question of ['Explain the architecture.', 'How does caching work?', 'What tests should I read first?']) {
        expect(reservedFor(context, question)).toBeLessThan(2400);
      }
    }
  });

  it('spends fewer tokens on an absence than on an explanation', () => {
    // Answer depth follows evidence depth: the absence instruction replaces the structure rather than
    // being added to it, so the guidance for a question with no answer is smaller, not larger.
    expect(reservedFor(NO_CACHE, 'How does caching work?')).toBeLessThan(
      reservedFor(APPLICATION, 'Explain the architecture.'),
    );
  });

  it('keeps one stable prefix across the whole battery', () => {
    const identity = deriveIdentity(APPLICATION);
    const repository = repositoryGuidance(identity.profile, identity);
    const coreReserved = fixedReservedTokens({ guidance: repository, count });
    const prefixes = new Set<string>();

    for (const question of [
      'What does this repository do?',
      'Explain the architecture.',
      'How does caching work?',
      'What tests should I read first?',
      'What handles deployment?',
    ]) {
      const planned = planFor({ identity, question, kind: 'repository' });
      const projection = project(APPLICATION, {
        tier: 'standard',
        intent: planned.intent,
        parts: planned.parts,
        allocation: planned.allocation,
        coreReserved,
        counter: estimatingCounter,
      });

      prefixes.add(projection.facts.slice(0, projection.coreCount).map((fact) => fact.object).join('|'));
    }

    expect(prefixes.size).toBe(1);
  });

  it('carries the area map as citeable facts', () => {
    const projection = project(UMBRELLA, { tier: 'standard' });
    const areas = projection.facts.filter((fact) => fact.predicate === 'area');

    expect(areas.length).toBeGreaterThan(0);
    expect(areas.map((fact) => fact.object).join(' ')).toContain('.ci is ci');
    // And in the stable core, since a directory map does not change with the question.
    expect(projection.facts.slice(0, projection.coreCount).some((fact) => fact.predicate === 'area')).toBe(true);
  });
});
