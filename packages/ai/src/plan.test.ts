import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { deriveIdentity, type RepositoryIdentity } from './identity.js';
import { deriveState, type ConversationState } from './memory.js';
import { FACT_GROUPS, planFor, type AnswerPlan } from './plan.js';
import { project } from './projection.js';
import { questionGuidance } from './strategy.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * The planner asked the same questions about repositories that are not alike.
 *
 * **The milestone's success criterion is that one question produces different plans on different
 * repositories**, and that every part of a plan rests on something the identity actually proved. Both
 * are properties of a returned object, so the object is what these assert — never the model's prose,
 * which no test can adjudicate.
 *
 * Two fixtures carry almost all of it. `linkforge` is a routed service with a cache, a secret and three
 * domains: everything a plan can select from is present, so a selection that goes wrong goes visibly
 * wrong. `spare` is the same repository with the evidence removed — no routes, no cache, no
 * configuration — because the interesting half of evidence planning is what happens when the evidence
 * is missing, and a fixture that always has everything can never show it.
 */

const listing = (entries: readonly unknown[], total = entries.length): Record<string, unknown> => ({
  entries,
  total,
  truncated: total > entries.length,
});

const declaration = (name: string): Record<string, unknown> => node(`sym:src/modules/${name}.ts#${name}`, { name });

function handler(name: string): Record<string, unknown> {
  return {
    edge: {
      id: `e:${name}`,
      type: 'HANDLES_ROUTE',
      sourceId: 'r',
      targetId: `sym:src/modules/${name}.ts#${name}`,
      confidence: 'CERTAIN',
    },
    declaration: declaration(name),
  };
}

function route(method: string, path: string, handlers: readonly string[]): Record<string, unknown> {
  return {
    node: node(`route:${method}:${path}`, { fileId: 'file:src/routes.ts' }),
    method,
    path,
    composition: { composed: true, prefixes: [], effectivePath: path, note: '' },
    handlers: handlers.map(handler),
  };
}

const metric = (name: string, fanIn: number, fanOut = 2): Record<string, unknown> => ({
  node: declaration(name),
  fanIn,
  fanOut,
  incomingEdges: fanIn,
  outgoingEdges: fanOut,
});

interface Shape {
  readonly technologies?: readonly Record<string, unknown>[];
  readonly routes?: readonly Record<string, unknown>[];
  readonly environmentVariables?: readonly string[];
  readonly externalPackages?: readonly string[];
  readonly layers?: Readonly<Record<string, readonly string[]>>;
}

function repository(shape: Shape = {}): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;
  const layers = shape.layers ?? {};
  const role = (key: string): Record<string, unknown> => listing((layers[key] ?? []).map(declaration));

  return {
    ...base,
    technologies: shape.technologies ?? [],
    routes: (shape.routes ?? []) as never,
    dependencies: {
      ...base.dependencies,
      externalPackages: (shape.externalPackages ?? []).map((name) =>
        node(`ext:npm:${name}`, { kind: 'External', externalName: name, fileId: null }),
      ),
      environmentVariables: (shape.environmentVariables ?? []).map((name) => node(`env:${name}`, { name })),
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          /*
           * No artefact evidence unless a test asks for it.
           *
           * The shared fixture carries a compose file and a workflow, which is right for a fixture meant to
           * look like a real repository — and wrong here, where several tests are about what a repository
           * with *nothing* produces. A declared prerequisite is a workflow, so inheriting one made "this
           * repository has no workflow to narrate" untestable.
           */
          artifacts: [],
          keyArtifacts: listing([]),
          repository: { files: 235, declarations: 1703, routes: (shape.routes ?? []).length },
          packages: listing([
            { name: 'src/modules', files: 26, declarations: 900, dependencies: 3, dependents: 0 },
            { name: 'src/shared', files: 12, declarations: 300, dependencies: 0, dependents: 4 },
          ]),
        },
        architecture: {
          controllers: role('Controller'),
          services: role('Service'),
          repositories: role('Repository'),
          middleware: role('Middleware'),
          models: listing([]),
          tests: listing([]),
          routes: listing([], (shape.routes ?? []).length),
        },
        hotspots: {
          mostReferenced: listing([metric('urlService', 40), metric('analyticsService', 12), metric('authService', 6)]),
          mostCoupled: listing([metric('urlService', 40, 9)]),
          largestFanIn: listing([metric('urlService', 40)]),
          mostConnectedFiles: listing([]),
        },
      },
    },
  } as unknown as RepositoryContext;
}

const LINKFORGE: Shape = {
  technologies: [
    { id: 'express', name: 'Express', category: 'backend', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'express'" },
    { id: 'prisma', name: 'Prisma', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "declares '@prisma/client'" },
    // `data`, not `cache`: the detector reports a category and the architecture summary is what
    // separates a cache from a store, by name. See `CACHING_TECHNOLOGIES`.
    { id: 'redis', name: 'Redis', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'ioredis'" },
    { id: 'docker', name: 'Docker', category: 'infrastructure', regionPath: '', confidence: 'CERTAIN', evidence: 'a Dockerfile is present' },
    { id: 'vitest', name: 'Vitest', category: 'testing', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'vitest'" },
  ],
  routes: [
    route('GET', '/:shortCode', ['requestLogger', 'redirectController']),
    route('GET', '/:shortCode/analytics', ['requestLogger', 'analyticsController']),
    route('POST', '/urls', ['requireAuth', 'urlController']),
    route('POST', '/login', ['authController']),
  ],
  environmentVariables: ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'],
  externalPackages: ['express', 'ioredis', '@prisma/client'],
  layers: {
    Controller: ['redirectController', 'analyticsController', 'urlController', 'authController'],
    Service: ['urlService', 'analyticsService', 'authService'],
    Repository: ['PrismaUrlRepository', 'PrismaAnalyticsRepository'],
    Middleware: ['requireAuth', 'requestLogger'],
  },
};

const linkforge = deriveIdentity(repository(LINKFORGE));

/** The same repository with everything a plan could select stripped out. */
const spare = deriveIdentity(repository({ layers: { Service: ['urlService'] } }));

const plan = (identity: RepositoryIdentity, question: string, kind = 'repository'): AnswerPlan =>
  planFor({ identity, question, kind });

const titles = (planned: AnswerPlan): readonly string[] => planned.sections.map((section) => section.title);

describe('the answer gets its own structure', () => {
  it('gives a workflow question and a caching question different sections of the same repository', () => {
    // The point of the whole layer in one assertion. Neither question is about the other's subject, and
    // until the structure was planned both received the repository's default shape.
    const flow = plan(linkforge, 'How does a redirect work?');
    const cache = plan(linkforge, 'Explain caching.');

    expect(flow.lead).toBe('workflow');
    expect(titles(flow)[0]).toBe('what the system is');
    expect(titles(flow)).toContain('what happens when it does its job');

    expect(cache.intent).toBe('caching');
    expect(titles(cache)[0]).toBe('what does the caching');
    expect(titles(cache)).not.toContain('what happens when it does its job');
  });

  it('opens every plan with one section that stands alone', () => {
    // Progressive disclosure, asserted as a property rather than as a template: a reader who stops
    // after the first section must have an answer rather than an introduction.
    for (const question of ['Explain the architecture.', 'Where should I start?', 'Explain caching.', 'How is it deployed?']) {
      const planned = plan(linkforge, question);

      expect(planned.sections.length).toBeGreaterThan(0);
      expect(planned.sections[0]?.purpose.length).toBeGreaterThan(0);
    }
  });

  it('never plans more sections than a prompt can afford', () => {
    for (const question of ['Explain everything about this repository.', 'Where should I start?']) {
      expect(plan(linkforge, question).sections.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('no section is planned without the evidence to write it', () => {
  it('drops a section whose identity field is absent, and says why', () => {
    const cache = plan(spare, 'Explain caching.');

    // The repository has no cache, so the section that would have described one is gone — and the
    // reason is recorded in the analysis's own terms rather than as a claim about the repository.
    expect(titles(cache)).not.toContain('what does the caching');
    expect(cache.unknowns.join(' ')).toContain('no cache technology was detected');
  });

  it('keeps a section whose evidence the repository does carry', () => {
    expect(titles(plan(linkforge, 'Explain caching.'))).toContain('what does the caching');
    expect(plan(linkforge, 'Explain caching.').unknowns).toEqual([]);
  });

  it('gives back an opening when the template lost its own', () => {
    // `spare` has no cache, so the section that would say what does the caching is dropped — and what
    // survives is "how it is configured", which opens the answer mid-explanation about a thing it has
    // not introduced. Four of thirteen validation repositories planned exactly that.
    const cache = plan(spare, 'Explain caching.');

    expect(titles(cache)).not.toContain('what does the caching');
    expect(cache.sections[0]?.title).toBe('what the repository contains');
  });

  it('falls back to one honest section rather than planning none', () => {
    // Reachable on a repository the analysis could barely read. A plan with no sections instructs a
    // model to write nothing in particular, which is worse than admitting what was found.
    const nothing = deriveIdentity(repository());
    const planned = plan(nothing, 'How is it deployed?');

    expect(planned.sections.length).toBeGreaterThan(0);
  });

  it('asks the projection for the parts its own sections rest on', () => {
    const planned = plan(linkforge, 'Explain caching.');

    // The loop between structure and evidence: a section that needs the configuration causes the
    // environment variables to be asked for, so the paragraph has facts behind it.
    expect(planned.sections.some((section) => section.evidence.includes('environmentVariables'))).toBe(true);
    expect(planned.parts).toContain('environmentVariables');
  });
});

describe('the same question plans differently on different repositories', () => {
  it('plans a cache-centric answer where there is a cache, and an honest one where there is not', () => {
    const withCache = plan(linkforge, 'Explain Redis.');
    const without = plan(spare, 'Explain Redis.');

    expect(withCache.intent).toBe('caching');
    expect(withCache.technologies).toContain('Redis');
    expect(without.technologies).not.toContain('Redis');
    expect(without.unknowns.length).toBeGreaterThan(0);
  });

  it('leads a repository by what kind of thing it is when the question says nothing specific', () => {
    // A service leads with what happens; a repository with no routes and no workflow cannot, and must
    // not be instructed to narrate one anyway.
    expect(plan(linkforge, 'Explain this repository.').lead).toBe('workflow');
    expect(plan(spare, 'Explain this repository.').lead).not.toBe('workflow');
  });
});

describe('what the answer must leave alone', () => {
  it('names only concepts this repository demonstrably has', () => {
    const cache = plan(linkforge, 'Explain caching.');

    expect(cache.exclusions).toContain('authentication and access control');
    expect(cache.exclusions).toContain('deployment');
    // Its own subject is never excluded, and neither is what the answer needs to place it.
    expect(cache.exclusions).not.toContain('caching');
  });

  it('excludes nothing a repository does not have', () => {
    const cache = plan(spare, 'Explain caching.');

    expect(cache.exclusions).not.toContain('deployment');
    expect(cache.exclusions).not.toContain('external integrations');
  });

  it('excludes nothing at all from a repository-wide question', () => {
    // A breadth question told to avoid four of its own subsystems gets a worse answer than it asked for.
    expect(plan(linkforge, 'Explain the architecture.').exclusions).toEqual([]);
  });

  it('names the other domains when the question named one', () => {
    const focused = plan(linkforge, 'Explain the url module.');

    expect(focused.focus).not.toBeNull();
    expect(focused.exclusions.some((concept) => concept.includes('analytics') || concept.includes('auth'))).toBe(true);
  });
});

describe('who the answer is written for', () => {
  it.each([
    ['Where should I start?', 'newcomer'],
    ['What does this project do?', 'newcomer'],
    ['Where do I add a new route?', 'contributor'],
    ['Explain the architecture.', 'engineer'],
    ['Explain the url module.', 'specialist'],
  ])('reads %j as %s', (question, audience) => {
    expect(plan(linkforge, question).audience).toBe(audience);
  });

  it('treats a resolved subject as a reader who already navigated here', () => {
    expect(plan(linkforge, 'What is this?', 'symbol').audience).toBe('specialist');
  });

  it('does not let audience override the depth the scale decided', () => {
    // A newcomer asking about a repository too large to narrate still gets the boundaries instruction.
    const newcomer = plan(linkforge, 'Where should I start?');
    const engineer = plan(linkforge, 'Explain the architecture.');

    expect(newcomer.depth).toBe(engineer.depth);
  });
});

describe('a route into the repository', () => {
  it('orders an orientation answer from the entry point inwards', () => {
    const started = plan(linkforge, 'Where should I start?');

    expect(started.lead).toBe('orientation');
    expect(started.navigation.map((step) => step.stage)).toEqual(['start here', 'then read', 'then inspect', 'finally']);

    /*
     * No step is a ranked declaration, and that is what this test is for.
     *
     * It used to assert that the first target contained a `/`, on the theory that a path meant an entry
     * point and a bare name meant the fan-in ranking. The route is now built from `identity.onboarding`,
     * which admits documentation, manifest entry points, routes and declared package boundaries and admits
     * no ranking at all — so the property can be asserted directly instead of inferred from a path shape,
     * and the first step is whichever of those the repository actually supplies.
     */
    const ranked = new Set(linkforge.critical.map((component) => component.name));

    for (const step of started.navigation) {
      expect(ranked.has(step.target)).toBe(false);
      expect(step.why).not.toMatch(/fan-in|fan-out|most referenced/i);
    }
  });

  it('offers no route to a question that did not ask for one', () => {
    expect(plan(linkforge, 'Explain caching.').navigation).toEqual([]);
    expect(plan(linkforge, 'Explain the architecture.').navigation).toEqual([]);
  });

  it('skips a step the repository cannot supply', () => {
    const started = plan(spare, 'Where should I start?');

    expect(started.navigation.some((step) => step.stage === 'finally')).toBe(false);
  });

  it('always begins the route at its own first step', () => {
    // A route whose first line reads "then read" is not a route. Where the evidence for the earlier
    // steps is missing, the first step that does exist is where to start.
    for (const identity of [linkforge, spare]) {
      const started = plan(identity, 'Where should I start?');

      expect(started.navigation[0]?.stage).toBe('start here');
    }
  });
});

describe('a question that asks more than one thing', () => {
  it('splits a compound question into its parts', () => {
    const both = plan(linkforge, 'Explain authentication and how JWT tokens are handled here.');

    expect(both.tasks.length).toBe(2);
    expect(both.tasks[0]?.question).toContain('authentication');
    expect(both.tasks[1]?.question).toContain('JWT');
  });

  it('leaves a single question undivided', () => {
    expect(plan(linkforge, 'Explain the architecture.').tasks).toEqual([]);
    // One request naming two things is still one request: neither half is a clause of its own.
    expect(plan(linkforge, 'Explain the routes and layers.').tasks).toEqual([]);
  });
});


describe('a question asking where to look is answered with places', () => {
  it.each([
    'What tests should I read first?',
    'Where is the redirect implemented?',
    'Which file should I open?',
    'Where would I modify this behaviour?',
    'What tests cover the url module?',
  ])('reads %j as a locating question', (question) => {
    expect(plan(linkforge, question).intent).toBe('locate');
    expect(plan(linkforge, question).lead).toBe('locate');
  });

  it('opens a locating answer with the places themselves', () => {
    // The failure this closes: "what tests should I read first?" received an architecture overview,
    // because nothing in the projection carried a test name and the importance ranking answered instead.
    const located = plan(linkforge, 'What tests should I read first?');

    expect(titles(located)[0]).toBe('the short answer: where to look');
    expect(located.parts[0]).toBe('tests');
  });

  it('does not lead with tests when the question is not about tests', () => {
    // Same lead, different subject. A question about where to add a route answered with a list of test
    // files is the same category error as an architecture overview, one level down.
    const route = plan(linkforge, 'Where would I implement a new route?');

    expect(route.lead).toBe('locate');
    expect(route.parts[0]).not.toBe('tests');
    expect(route.parts).toContain('routes');
  });

  it('keeps a locating answer short whatever the repository size', () => {
    /*
     * Question breadth, which scope cannot express. "What tests should I read first?" on a medium
     * repository used to be given the `modules` instruction — explain the major modules and how they
     * interact — for a question whose whole answer is four filenames.
     */
    expect(plan(linkforge, 'What tests should I read first?').depth).toBe('focused');
    // And the broad question about the same repository keeps its substance.
    expect(plan(linkforge, 'Explain the architecture.').depth).not.toBe('focused');
  });

  it('still narrows to a named subsystem while pointing at files', () => {
    const located = plan(linkforge, 'Where is caching implemented?');

    expect(located.lead).toBe('locate');
    expect(located.focus).toBe('caching');
  });

  it('leaves an orientation question to the route, not the file list', () => {
    // "Where should I start?" contains `where`, so it classifies as locating — and it is still a request
    // to be led rather than a request for a filename. The orientation pattern is checked first.
    expect(plan(linkforge, 'Where should I start?').lead).toBe('orientation');
  });
});

describe('the fact budget is allocated rather than merely capped', () => {
  it('divides it differently by what the answer leads with', () => {
    const flow = plan(linkforge, 'How does a redirect work?').allocation;
    const parts = plan(linkforge, 'What are the most important components?').allocation;

    expect(flow.workflow).toBeGreaterThan(parts.workflow);
    expect(parts.components).toBeGreaterThan(flow.components);
  });

  it('always divides the whole budget', () => {
    for (const question of ['Explain caching.', 'Where should I start?', 'How is it deployed?', 'Explain the url module.']) {
      const allocation = plan(linkforge, question).allocation;
      const total = FACT_GROUPS.reduce((sum, group) => sum + allocation[group], 0);

      expect(total).toBeCloseTo(1, 5);
    }
  });

  it('reserves nothing for workflows a repository does not have', () => {
    const allocation = plan(spare, 'Explain this repository.').allocation;

    expect(allocation.workflow).toBe(0);
    expect(allocation.components).toBeGreaterThan(0);
  });

  it('leaves no part of the budget unspent', () => {
    /*
     * The invariant an allocation must satisfy, and it is about tokens rather than facts.
     *
     * Shares buy *different* facts, so the count moves either way — on the validation battery it rose
     * by fifteen on one question and fell by six on another. What must never happen is a group
     * declining its share and nobody else taking it, which is what the unallocated sweep exists to
     * prevent and what this would catch: a projection that spent visibly less than the same
     * projection without shares has lost budget to a reservation it did not use.
     */
    const context = repository(LINKFORGE);
    const planned = plan(deriveIdentity(context), 'How does a redirect work?');
    const options = { tier: 'minimal', intent: planned.intent, parts: planned.parts } as const;

    const without = project(context, options);
    const with_ = project(context, { ...options, allocation: planned.allocation });

    // One fact's worth of slack: both passes stop at the first fact that does not fit, and the two are
    // stopping on differently-sized facts.
    expect(with_.tokens).toBeGreaterThan(without.tokens - 40);
  });

  it('spends the supplement on what the question is about', () => {
    // The shares doing their actual job: a focused question moves the supplement toward the components
    // and away from the repository-wide listings, which is the reallocation the milestone asked for.
    const context = repository(LINKFORGE);
    const planned = plan(deriveIdentity(context), 'Explain caching.');
    const options = { tier: 'minimal', intent: planned.intent, parts: planned.parts } as const;

    const supplement = (projection: ReturnType<typeof project>): readonly string[] =>
      projection.facts.slice(projection.coreCount).map((fact) => fact.predicate);

    const without = supplement(project(context, options));
    const with_ = supplement(project(context, { ...options, allocation: planned.allocation }));

    expect(with_).not.toEqual(without);
  });

  it('leaves the stable core untouched, whatever the question allocated', () => {
    // The property the whole prompt-prefix reuse rests on. An allocation is question-derived, so it
    // must not reach the core — this is the assertion that would fail if it ever did.
    const context = repository(LINKFORGE);
    const core = (question: string): string => {
      const planned = plan(deriveIdentity(context), question);
      const projected = project(context, {
        tier: 'standard',
        intent: planned.intent,
        parts: planned.parts,
        allocation: planned.allocation,
      });

      return projected.facts
        .slice(0, projected.coreCount)
        .map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`)
        .join('\n');
    };

    expect(core('How does a redirect work?')).toBe(core('Explain caching.'));
  });
});

describe('a conversation is not restarted every turn', () => {
  const session = (
    turns: readonly { readonly question: string; readonly answer: string }[],
  ): ConversationState =>
    deriveState(
      {
        turns: turns.map((turn, index) => ({
          id: `t${index}`,
          question: turn.question,
          subject: { kind: 'repository' } as never,
          answer: turn.answer,
          citations: [],
          verdict: 'grounded' as const,
          projectionDigest: 'd',
          model: 'm',
        })),
      },
      linkforge,
    );

  it('marks what an earlier answer already explained', () => {
    const covered = planFor({
      identity: linkforge,
      question: 'What about the analytics side?',
      kind: 'repository',
      state: session([{ question: 'How does a redirect work?', answer: 'A request reaches urlService, which reads through Redis.' }]),
    }).covered;

    expect(covered).toContain('urlService');
  });

  it('does not treat a name the reader asked about as a name that was explained', () => {
    // The question is what the answer is for. Reading the questions back would mark the one thing the
    // follow-up is asking about as already covered.
    const covered = planFor({
      identity: linkforge,
      question: 'And urlService?',
      kind: 'repository',
      state: session([{ question: 'What is urlService?', answer: 'The facts do not settle that.' }]),
    }).covered;

    expect(covered).not.toContain('urlService');
  });

  it('covers nothing on a first turn', () => {
    expect(plan(linkforge, 'Explain the architecture.').covered).toEqual([]);
  });

  it('gives a follow-up the subject the session was already about', () => {
    // "Where is this implemented?" names nothing. Without the session it is a repository-wide question
    // and gets a repository-wide answer, which is the restart this milestone exists to stop.
    const state = session([{ question: 'How does caching work here?', answer: 'Redis answers repeated reads.' }]);
    const followUp = planFor({ identity: linkforge, question: 'Where is this implemented?', kind: 'repository', state });

    expect(state.focus).toBe('caching');
    expect(followUp.focus).toBe('caching');
    expect(followUp.continues).toBe(true);
    expect(followUp.depth).toBe('focused');
  });

  it('does not inherit a subject into a question that widened again', () => {
    const state = session([{ question: 'How does caching work here?', answer: 'Redis answers repeated reads.' }]);
    const wide = planFor({ identity: linkforge, question: 'What does this repository do?', kind: 'repository', state });

    // It says `this`, names no subsystem, and is the broadest question there is. Inheriting here would
    // answer a question about the whole repository as a question about its cache.
    expect(wide.continues).toBe(false);
    expect(wide.focus).toBeNull();
  });

  it.each([
    'How are errors handled?',
    // Begins with "why" and then names its own subject. Anchoring on the opening word alone read this
    // as a continuation on React and planned it as a question about authentication.
    'Why is Redis used in this kind of system?',
    'Explain how deployment is configured.',
  ])('does not inherit a subject into %j, which changed it', (question) => {
    const state = session([{ question: 'How does caching work here?', answer: 'Redis answers repeated reads.' }]);

    expect(planFor({ identity: linkforge, question, kind: 'repository', state }).continues).toBe(false);
  });

  it.each(['Why?', 'Where is this implemented?', 'What about under load?', 'Why was it chosen?'])(
    'inherits into %j, which points back',
    (question) => {
      const state = session([{ question: 'How does caching work here?', answer: 'Redis answers repeated reads.' }]);

      expect(planFor({ identity: linkforge, question, kind: 'repository', state }).continues).toBe(true);
    },
  );

  it('reads "what should I look at next?" as a request to be led', () => {
    // The closing question of a long session, and until validation ran it was planned as a workflow
    // answer — with no suggestions, because suggestions are for questions asking to be led.
    const state = session([{ question: 'How does caching work?', answer: 'Redis answers repeated reads for url.' }]);
    const next = planFor({ identity: linkforge, question: 'What should I look at next?', kind: 'repository', state });

    expect(next.lead).toBe('orientation');
    expect(next.suggested.length).toBeGreaterThan(0);
  });

  it('stops treating a reader as new once the session has explained things to them', () => {
    const state = session([
      { question: 'What does this do?', answer: 'It is organised around url, analytics and auth.' },
      { question: 'How does a redirect work?', answer: 'urlService reads through Redis, behind Prisma.' },
    ]);

    expect(state.level).not.toBe('newcomer');
    // Still an orientation question — it is still asking where to go — but not one that has to explain
    // what a controller is.
    expect(planFor({ identity: linkforge, question: 'Where should I start?', kind: 'repository', state }).lead).toBe('orientation');
    expect(planFor({ identity: linkforge, question: 'Where should I start?', kind: 'repository', state }).audience).not.toBe('newcomer');
  });

  it('points a session at what it has not reached', () => {
    const state = session([{ question: 'How does caching work?', answer: 'Redis answers repeated reads for url.' }]);
    const next = planFor({ identity: linkforge, question: 'Where should I start?', kind: 'repository', state });

    expect(next.suggested.length).toBeGreaterThan(0);
    expect(next.suggested).not.toContain('Redis');
  });
});

describe('how sure the planner is', () => {
  it.each([
    ['Explain the url module.', 'certain'],
    /*
     * This read `certain` on the grounds that `caching` is a domain the repository demonstrably has.
     *
     * It is — and the word is still the one that *classified the question*, which is a different fact
     * about it. Every question carrying a responsibility keyword scored `certain` on any repository whose
     * profile derived a domain of that name, which made the field say "the reader named a subsystem" when
     * what had happened was "the reader named a kind of question". `likely` is the accurate reading: the
     * question matched an explicit responsibility intent, and the caching policy routes its evidence.
     */
    ['Explain caching.', 'likely'],
    // A named technology still narrows, and still reads `certain`: `redis` names a thing rather than a
    // kind of question, which is exactly the distinction the frame guard draws.
    ['Explain Redis.', 'certain'],
    ['Where should I start?', 'likely'],
    // A responsibility intent whose keyword is not also the name of a subsystem: the question is about
    // deployment without having named anything the repository contains.
    ['How is this deployed?', 'likely'],
    ['Tell me about this.', 'uncertain'],
  ])('reads %j with %s confidence', (question, confidence) => {
    expect(plan(linkforge, question).confidence).toBe(confidence);
  });

  it('is uncertain only where it fell back to the repository’s own default shape', () => {
    const vague = plan(linkforge, 'Tell me about this.');

    expect(vague.confidence).toBe('uncertain');
    // Not a failure: most questions about a repository are repository-wide questions, and the default
    // shape is the right answer to them. The field says which decision produced the plan, not how good
    // the plan is.
    expect(vague.sections.length).toBeGreaterThan(0);
  });
});

describe('planning is deterministic and paid for once', () => {
  it('returns the identical plan for the identical question', () => {
    // Identity, not equality: the second call must be a cache hit, because one request plans four
    // times — to reserve the budget, to project, to assemble and to report the shape.
    expect(plan(linkforge, 'Explain caching.')).toBe(plan(linkforge, 'Explain caching.'));
  });

  it('plans two different questions differently', () => {
    expect(plan(linkforge, 'Explain caching.')).not.toBe(plan(linkforge, 'Where should I start?'));
  });

  it('derives the same plan from an equal identity of the same repository', () => {
    const again = deriveIdentity(repository(LINKFORGE));

    expect(plan(again, 'Explain caching.')).toEqual(plan(linkforge, 'Explain caching.'));
  });
});

describe('the plan reaches the prompt', () => {
  it('states the structure and what could not be settled', () => {
    // A question whose subject the repository does have: the structure leads, as it always did.
    const architecture = plan(linkforge, 'Explain the architecture.');

    expect(questionGuidance(architecture.strategy, architecture)).toContain('Build the answer in this order');

    const focused = plan(spare, 'Explain the url module.');

    expect(questionGuidance(focused.strategy, focused)).toContain('The facts do not settle:');
  });

  it('answers an absence with the absence, and offers no structure to pad it with', () => {
    /*
     * **The behaviour this milestone changed, asserted as the change.** Asked about caching on a
     * repository with no cache, the planner used to hand the model a full structure — sections, ranked
     * components, a need line asking it to explain the caching strategy — plus sixty facts about
     * something else. A model told to explain caching and given no cache explains whatever it was given.
     */
    const cache = plan(spare, 'Explain caching.');
    const guidance = questionGuidance(cache.strategy, cache);

    expect(cache.sufficiency.verdict).toBe('absent');
    expect(guidance).toContain('The analysis did not identify a caching mechanism');
    expect(guidance).toContain('two or three sentences');
    expect(guidance).not.toContain('Build the answer in this order');
    expect(guidance).not.toContain('Spend the most space on these');
  });

  it('distinguishes what is absent from what could not be looked for', () => {
    // Absence is a claim about the repository; only an analysis that could have seen the thing may make
    // it. The instruction says which of the two this is, in as many words.
    const absent = plan(spare, 'Explain caching.');

    expect(questionGuidance(absent.strategy, absent)).toContain('not that the repository does not have it');
  });

  it('gives the route instead of the ranking, never both', () => {
    const started = plan(linkforge, 'Where should I start?');
    const guidance = questionGuidance(started.strategy, started);

    expect(guidance).toContain('Give this route');
    // The two are the same names in two orders, and a model given both is given two conflicting
    // instructions about which order to use.
    expect(guidance).not.toContain('Spend the most space on these');
  });

  it('states what a newcomer is not expected to know, and says nothing to an engineer', () => {
    const newcomer = plan(linkforge, 'Where should I start?');
    const engineer = plan(linkforge, 'Explain the architecture.');

    expect(questionGuidance(newcomer.strategy, newcomer)).toContain('has not seen this repository before');
    expect(questionGuidance(engineer.strategy, engineer)).not.toContain('has not seen this repository before');
  });

  it('asks for both halves of a compound question in one explanation', () => {
    const both = plan(linkforge, 'Explain authentication and how JWT tokens are handled here.');
    const guidance = questionGuidance(both.strategy, both);

    expect(guidance).toContain('two parts');
    expect(guidance).toContain('in one explanation');
  });

  it('does not ask twice for the same coverage on a focused question', () => {
    // The plan's sections and the strategy's cover list say the same thing in different words, and a
    // model given both reads two requirements where there is one.
    const focused = plan(linkforge, 'Explain the url module.');
    const guidance = questionGuidance(focused.strategy, focused);

    expect(focused.depth).toBe('focused');
    expect(guidance).toContain('Build the answer in this order');
    expect(guidance).not.toContain('\nCover:');
  });

  it('stays affordable', () => {
    // Question guidance measured 205 to 457 tokens across the validation battery before the planner
    // grew a structure, against a standard fact budget of about 5,500. A guidance block that displaced
    // the facts it exists to organise would be the milestone defeating itself.
    const started = plan(linkforge, 'Where should I start?');
    const tokens = Math.ceil(questionGuidance(started.strategy, started).length / 4);

    expect(tokens).toBeLessThan(700);
  });
});
