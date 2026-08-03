import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { deriveIdentity } from './identity.js';
import { rankComponents, starsOf } from './importance.js';
import { planFor } from './plan.js';
import { project } from './projection.js';
import { questionGuidance, repositoryGuidance } from './strategy.js';
import { fixedReservedTokens, reservedTokens, stablePrefixOf } from './prompt.js';
import { renderWorkflow, workflowsOf } from './workflow.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * A repository shaped like LinkForge, with the evidence an identity is actually made of.
 *
 * **Routes carry linked handlers, which no fixture did before.** `RouteResult.handlers` is the one
 * measured chain in the whole graph — an ordered list of edges from a route to the declarations
 * registered against it — and a fixture without it can only exercise the conventional half of a
 * workflow. Every route below names its middleware and its handler, so the tests can tell the two
 * confidences apart.
 */

const listing = (entries: readonly unknown[], total = entries.length): Record<string, unknown> => ({
  entries,
  total,
  truncated: total > entries.length,
});

const declaration = (name: string): Record<string, unknown> => node(`sym:src/modules/${name}.ts#${name}`, { name });

function handler(name: string): Record<string, unknown> {
  return {
    edge: { id: `e:${name}`, type: 'HANDLES_ROUTE', sourceId: 'r', targetId: `sym:src/modules/${name}.ts#${name}`, confidence: 'CERTAIN' },
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

function linkforge(overrides: Record<string, unknown> = {}): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;

  return {
    ...base,
    technologies: [
      { id: 'express', name: 'Express', category: 'backend', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'express'" },
      { id: 'prisma', name: 'Prisma', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "declares '@prisma/client'" },
      { id: 'redis', name: 'Redis', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'ioredis'" },
    ],
    routes: [
      route('GET', '/:shortCode', ['requestLogger', 'redirectController']),
      route('GET', '/:shortCode/analytics', ['requestLogger', 'analyticsController']),
      route('POST', '/urls', ['requireAuth', 'urlController']),
      route('POST', '/login', ['authController']),
    ] as never,
    dependencies: {
      ...base.dependencies,
      externalPackages: [
        node('ext:npm:express', { kind: 'External', externalName: 'express', fileId: null }),
        node('ext:npm:ioredis', { kind: 'External', externalName: 'ioredis', fileId: null }),
      ],
      environmentVariables: [
        node('env:DATABASE_URL', { name: 'DATABASE_URL' }),
        node('env:REDIS_URL', { name: 'REDIS_URL' }),
        node('env:JWT_SECRET', { name: 'JWT_SECRET' }),
      ],
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          /*
           * No artefact evidence unless a test supplies it.
           *
           * The shared fixture carries a compose file whose declared prerequisites are a workflow, which is
           * right for a fixture meant to look like a real repository — and wrong for the tests below about
           * what a repository with *no* narratable workflow produces.
           */
          artifacts: [],
          keyArtifacts: listing([]),
          repository: { files: 235, declarations: 1703, routes: 4 },
          packages: listing([
            { name: 'src/modules', files: 26, declarations: 900, dependencies: 3, dependents: 0 },
            { name: 'src/shared', files: 12, declarations: 300, dependencies: 0, dependents: 4 },
            { name: 'docs/architecture', files: 3, declarations: 0, dependencies: 0, dependents: 0 },
          ]),
        },
        architecture: {
          controllers: listing(['redirectController', 'analyticsController', 'urlController', 'authController'].map(declaration)),
          services: listing(['urlService', 'analyticsService', 'authService'].map(declaration)),
          repositories: listing(['PrismaUrlRepository', 'PrismaAnalyticsRepository'].map(declaration)),
          middleware: listing(['requireAuth', 'requestLogger'].map(declaration)),
          models: listing([]),
          tests: listing([]),
          routes: listing([], 4),
        },
        hotspots: {
          mostReferenced: listing([metric('urlService', 40), metric('analyticsService', 12), metric('authService', 6)]),
          mostCoupled: listing([metric('urlService', 40, 9)]),
          largestFanIn: listing([metric('urlService', 40)]),
          mostConnectedFiles: listing([]),
        },
      },
    },
    ...overrides,
  } as unknown as RepositoryContext;
}

describe('what the repository is for', () => {
  const identity = deriveIdentity(linkforge());

  it('states a purpose assembled from evidenced clauses, never written', () => {
    expect(identity.purpose?.value).toContain('service');
    expect(identity.purpose?.value).toContain('organised around');
    // Every clause carries the evidence it was assembled from, so the sentence is checkable.
    expect(identity.purpose?.evidence.length).toBeGreaterThan(0);
  });

  it('stops short of naming a product', () => {
    // A repository organised around `url` with a redirect route is a URL shortener, and that
    // conclusion belongs to the reader.
    expect(identity.purpose?.value).not.toContain('shorten');
    expect(identity.purpose?.value).not.toContain('URL shortener');
  });

  it('says who uses it from the category, and says that is what it is doing', () => {
    expect(identity.users?.value).toContain('other programs');
    expect(identity.users?.evidence.join(' ')).toContain('it is a service');
  });

  it('omits a field it cannot prove rather than reporting an absence as a finding', () => {
    const bare = deriveIdentity(repositoryContext());

    // The base fixture has no cache technology and no plugin packages. Both must be absent, not
    // reported as "none" — the second is a claim about the repository, the first about the analysis.
    expect(bare.caching).toBeNull();
    expect(bare.extensionPoints).toBeNull();
  });

  it('names the domains with the declarations that carry them, ranked', () => {
    const url = identity.domains.find((domain) => domain.name === 'url');

    expect(url).toBeDefined();
    expect(url?.members).toContain('urlService');
    // `urlService` has the largest fan-in in the repository, so `url` outranks the other domains.
    expect(identity.domains[0]?.name).toBe('url');
  });

  it('reaches the same object twice without ranking twice', () => {
    const context = linkforge();

    // Derivation is arithmetic over a context that is handed to the projection, the prompt and the
    // planner in one request. Ranking React's 141 packages four times per answer is the cost this
    // avoids, and object identity is the only key that can be correct here.
    expect(deriveIdentity(context)).toBe(deriveIdentity(context));
  });
});

describe('what matters more than what', () => {
  const components = rankComponents(linkforge());

  it('ranks a route-owning, heavily-referenced declaration above a quiet one', () => {
    const names = components.filter((entry) => entry.kind === 'declaration').map((entry) => entry.name);

    expect(names.indexOf('urlService')).toBeLessThan(names.indexOf('authService'));
  });

  it('carries the raw numbers that produced every score', () => {
    const service = components.find((entry) => entry.name === 'urlService');

    expect(service?.signals.some((signal) => signal.detail.includes('40 distinct declarations reference it'))).toBe(true);

    for (const component of components) {
      for (const signal of component.signals) {
        expect(signal.value, `${component.name}/${signal.signal}`).toBeGreaterThan(0);
        expect(signal.detail).not.toBe('');
      }
    }
  });

  it('credits the handler that answers, not the middleware in front of it', () => {
    // `requestLogger` runs on two routes and `redirectController` answers one. Crediting every
    // handler in the chain would rank the logger above the controller on every repository that has one.
    const logger = components.find((entry) => entry.name === 'requestLogger');
    const controller = components.find((entry) => entry.name === 'redirectController');

    expect(logger?.signals.some((signal) => signal.signal === 'route-ownership')).toBe(false);
    expect(controller?.signals.some((signal) => signal.signal === 'route-ownership')).toBe(true);
  });

  it('never counts one measurement twice', () => {
    // `urlService` appears in `mostReferenced` and in `largestFanIn` with the same fan-in. That is one
    // declaration with one fan-in, not two contributions of it.
    const service = components.find((entry) => entry.name === 'urlService');
    const fanIn = service?.signals.filter((signal) => signal.signal === 'fan-in') ?? [];

    expect(fanIn).toHaveLength(1);
  });

  it('does not award a top rank for one weak signal', () => {
    // The worst defect this file had. Scores were divided by the weight of the signals a component
    // actually carried, so a declaration whose only evidence was a role annotation scored a perfect
    // one — and LinkForge reported `analyticsController`, `authController` and `urlController` at five
    // stars on the strength of nothing but their names, ahead of a declaration with 70 recorded
    // references. Having one weak signal is not the same as being certain.
    const roleOnly = components.find((entry) => entry.signals.every((signal) => signal.signal === 'role'));

    expect(roleOnly).toBeDefined();
    expect(roleOnly?.stars).toBeLessThan(4);

    // And a declaration carrying several measured signals still ranks near the top.
    expect(components[0]?.stars).toBeGreaterThanOrEqual(4);
    expect(starsOf(0)).toBe(1);
    expect(starsOf(1)).toBe(5);
  });

  it('ranks nothing for a context with no repository overview', () => {
    expect(rankComponents(repositoryContext())).not.toHaveLength(0);
  });
});

describe('what happens when the repository does its job', () => {
  const workflows = workflowsOf(linkforge());

  it('traces a request from its route through the handler the extractor linked', () => {
    const redirect = workflows.find((workflow) => workflow.steps.some((step) => step.actor === 'redirectController'));

    expect(redirect).toBeDefined();
    expect(redirect?.steps[0]?.actor).toBe('the request');
    expect(redirect?.steps.map((step) => step.actor)).toContain('requestLogger');
  });

  it('keeps the middleware in the order it was registered', () => {
    const guarded = workflows.find((workflow) => workflow.steps.some((step) => step.actor === 'requireAuth'));
    const actors = guarded?.steps.map((step) => step.actor) ?? [];

    expect(actors.indexOf('requireAuth')).toBeLessThan(actors.indexOf('urlController'));
  });

  it('marks the recorded steps CERTAIN and the conventional continuation INFERRED', () => {
    // The whole basis on which a workflow can be trusted. That a request reaches `urlController` is an
    // edge; that `urlController` then calls `urlService` is a convention this does not measure.
    const guarded = workflows.find((workflow) => workflow.steps.some((step) => step.actor === 'urlController'));
    const handlerStep = guarded?.steps.find((step) => step.actor === 'urlController');
    const serviceStep = guarded?.steps.find((step) => step.actor === 'urlService');

    expect(handlerStep?.confidence).toBe('CERTAIN');
    expect(serviceStep?.confidence).toBe('INFERRED');
    expect(serviceStep?.evidence).toContain('the order is conventional, not an observed call');
  });

  it('says so in the rendered line, where a reader would otherwise read an arrow as a measurement', () => {
    const rendered = renderWorkflow(workflows[0]!);

    expect(rendered).toContain('→');
    expect(rendered).toContain('steps after the handler are conventional, not observed calls');
  });

  it('derives no workflow where no handler was linked', () => {
    // React has routes in its fixture servers and no role layers. A workflow without a handler is not
    // a workflow, and inventing one is exactly what this must not do.
    const unlinked = linkforge({
      routes: [{ ...route('GET', '/x', []), handlers: [] }] as never,
    });

    expect(workflowsOf(unlinked).every((workflow) => workflow.routes === 0)).toBe(true);
  });

  it('groups many routes answered by one handler into one workflow', () => {
    const many = linkforge({
      routes: [
        route('GET', '/a', ['urlController']),
        route('GET', '/b', ['urlController']),
        route('GET', '/c', ['urlController']),
      ] as never,
    });
    const routed = workflowsOf(many).filter((workflow) => workflow.routes > 0);

    expect(routed).toHaveLength(1);
    expect(routed[0]?.routes).toBe(3);
  });
});

describe('what this question needs', () => {
  const identity = deriveIdentity(linkforge());
  const plan = (question: string): ReturnType<typeof planFor> =>
    planFor({ identity, question, kind: 'repository' });

  it('reads "where should I start" as orientation, not as architecture', () => {
    // Every keyword in it says architecture. The reader is asking to be given a path into the
    // repository, and an architecture overview answers a question they did not ask.
    const started = plan('Where should I start?');

    expect(started.lead).toBe('orientation');
    expect(started.need).toContain('ordered path');
    expect(plan('Explain the architecture.').lead).not.toBe('orientation');
  });

  it('answers a repository-wide architecture question as architecture, and still carries a workflow', () => {
    /*
     * This asserted `workflow` and asserting that was the bug.
     *
     * LinkForge is an application, applications lead with a workflow, and "explain the architecture" had
     * no lead of its own — so the broadest question there is received the request path of one feature. A
     * repository-level question gets a repository-level shape whatever kind of repository it is asked
     * about; the workflow is still carried, because how the divisions meet is what a workflow shows.
     */
    const architecture = plan('Explain the architecture.');

    expect(architecture.lead).toBe('architecture');
    expect(architecture.workflows.length).toBeGreaterThan(0);
    expect(architecture.parts).toContain('routes');
    expect(architecture.sections).toContainEqual(
      expect.objectContaining({ title: 'what this analysis did not establish' }),
    );
  });

  it('reads a question about what matters as a ranking question', () => {
    const important = plan('What are the most important parts?');

    expect(important.lead).toBe('components');
    expect(important.need).toContain('which parts of this repository matter most');
  });

  it('narrows to one subsystem and takes only the workflows that reach it', () => {
    const redis = plan('Explain Redis.');

    expect(redis.lead).toBe('subsystem');
    expect(redis.focus).toBe('redis');
    expect(redis.depth).toBe('focused');
  });

  it('falls back to a domain workflow when no route handler was linked', () => {
    // Losing the handler edges costs the measured chain, not the workflow: two role layers naming the
    // same domain is still evidence of something the repository does, and it is emitted INFERRED.
    const withoutHandlers = deriveIdentity(
      linkforge({ routes: [{ ...route('GET', '/x', []), handlers: [] }] as never }),
    );

    expect(withoutHandlers.workflows.every((workflow) => workflow.routes === 0)).toBe(true);
    expect(withoutHandlers.workflows.length).toBeGreaterThan(0);
  });

  it('never asks for a workflow the repository cannot supply', () => {
    // The type rules can call a repository a service on route evidence the workflow extractor cannot
    // turn into a chain, and where no role layers agree either there is nothing to narrate.
    // Instructing a model to narrate a workflow it has no facts for is how confident, unsupported
    // prose gets written, so the lead falls back to the components instead.
    const bare = linkforge({
      routes: [] as never,
      primary: {
        type: 'repository',
        value: {
          ...(linkforge().primary as unknown as { value: Record<string, unknown> }).value,
          architecture: {
            controllers: listing([]),
            services: listing([]),
            repositories: listing([]),
            middleware: listing([]),
            models: listing([]),
            tests: listing([]),
            routes: listing([]),
          },
        },
      },
    });
    const identity = deriveIdentity(bare);
    const planned = planFor({ identity, question: 'Explain the architecture.', kind: 'repository' });

    expect(identity.workflows).toEqual([]);
    expect(planned.workflows).toEqual([]);
    // Stripped of its routes and its layers the repository is a library, and it leads with its public
    // surface. What matters is that nothing asks for a narration there are no facts for.
    expect(planned.lead).not.toBe('workflow');
  });

  it('names fewer components the less the depth allows', () => {
    const complete = planFor({ identity, question: 'Explain everything.', kind: 'repository' });

    expect(complete.components.length).toBeGreaterThan(0);
    expect(complete.components.length).toBeLessThanOrEqual(14);
  });
});

describe('the identity reaches the prompt, and stays citable there', () => {
  const context = linkforge();

  it('opens the guidance with what the repository does, ahead of what kind it is', () => {
    const guidance = repositoryGuidance(deriveIdentity(context).profile, deriveIdentity(context));

    expect(guidance).toContain('It is a service, organised around');
    expect(guidance).toContain('Used by');
    expect(guidance).toContain('Organised around, most significant first');
  });

  it('puts the workflow and the ranking in the question guidance, as instructions', () => {
    const identity = deriveIdentity(context);
    const plan = planFor({ identity, question: 'Explain the architecture.', kind: 'repository' });
    const guidance = questionGuidance(plan.strategy, plan);

    expect(guidance).toContain('What the reader needs:');
    expect(guidance).toContain('they are what this repository does');
    /*
     * It read `Spend the most space on these`, and that instruction was the failure it was testing for.
     *
     * The list is ranked by fan-in, so telling a model to give the most space to the highest-ranked unit
     * is telling it that the most-referenced unit is the most important one — the exact claim the
     * entailment guard then rejects as `prominence-as-importance`. The list is still given, and still in
     * rank order; what it now asks for is that each name be described from a fact rather than from its
     * place in the list.
     */
    expect(guidance).toContain('Name these, in this order');
    expect(guidance).toContain('a measurement of how much of the repository points at each');
    expect(guidance).not.toContain('Spend the most space');
  });

  it('emits the purpose, the workflows and the ranking as citable facts', () => {
    const projection = project(context, { tier: 'standard' });
    const predicates = projection.facts.map((fact) => fact.predicate);

    expect(predicates).toContain('exists-to');
    expect(predicates).toContain('workflow');
    expect(predicates).toContain('ranks');
  });

  it('marks a derived purpose INFERRED and a measured workflow CERTAIN', () => {
    const facts = project(context, { tier: 'standard' }).facts;

    expect(facts.find((fact) => fact.predicate === 'exists-to')?.confidence).toBe('INFERRED');

    // This workflow's continuation is conventional, so the weaker confidence governs the line.
    const workflow = facts.find((fact) => fact.predicate === 'workflow');

    expect(workflow?.confidence).toBe('INFERRED');
    expect(workflow?.object).toContain('conventional, not observed calls');
  });

  it('makes every name a workflow uses claimable, or the guard would call a right answer wrong', () => {
    const projection = project(context, { tier: 'standard' });

    for (const name of ['urlcontroller', 'requireauth', 'urlservice']) {
      expect(projection.terms.has(name), name).toBe(true);
    }
  });

  it('carries the identity on the projection, so the prompt and the facts cannot disagree', () => {
    const projection = project(context, { tier: 'standard' });

    expect(projection.identity?.purpose?.value).toBe(deriveIdentity(context).purpose?.value);
  });

  it('leaves a non-repository context without an identity rather than inventing one', () => {
    expect(project(context, { tier: 'standard' }).identity).not.toBeNull();
  });

  it('keeps the stable prefix stable, though the guidance now varies by hundreds of tokens', () => {
    /*
     * The regression this milestone very nearly shipped.
     *
     * The core's ceiling is a share of `TIER − reserved`, and `reserved` includes the guidance the
     * question steers. That was harmless while question guidance was forty tokens. Once the planner
     * began emitting workflows and a ranked component list it ranged from 205 to 457 tokens across one
     * battery, the ceiling moved by hundreds, a different number of facts fitted under it, and the
     * prefix a provider caches differed between two questions about the same repository — measured as
     * identical on 3 of 13 repositories and different on the other 10.
     *
     * Budgeting the core against the question-independent reservation is what restores it.
     */
    const identity = deriveIdentity(context);
    const fixed = fixedReservedTokens({
      guidance: repositoryGuidance(identity.profile, identity),
      count: (text) => Math.ceil(text.length / 4),
    });

    const prefixes = new Set<string>();

    for (const question of ['Explain the architecture.', 'Where should I start?', 'Explain caching.']) {
      const plan = planFor({ identity, question, kind: 'repository' });
      const reserved = reservedTokens({
        question,
        count: (text) => Math.ceil(text.length / 4),
        guidance: `${repositoryGuidance(identity.profile, identity)}\n${questionGuidance(plan.strategy, plan)}`,
      });

      prefixes.add(
        stablePrefixOf(
          project(context, {
            tier: 'standard',
            intent: plan.intent,
            parts: plan.parts,
            reserved,
            coreReserved: fixed,
          }),
        ),
      );
    }

    expect(prefixes.size).toBe(1);
  });
});
