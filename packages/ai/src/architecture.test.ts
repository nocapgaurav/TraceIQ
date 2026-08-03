import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { summariseArchitecture } from './architecture.js';
import { estimatingCounter } from './budget.js';
import { node, repositoryContext } from './fixtures.test-helper.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { project } from './projection.js';

/**
 * The architecture summary, against a context shaped like LinkForge's — the repository this was built
 * for: a Next.js frontend, an Express backend, Prisma for storage, Redis for cache, and four role
 * layers.
 *
 * The assertions that matter are the negative ones. A summary that describes a system is only worth
 * having if it never describes one that is not there.
 */
function linkforgeish(overrides: Record<string, unknown> = {}): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };

  return {
    ...base,
    technologies: [
      { id: 'nextjs', name: 'Next.js', category: 'frontend', regionPath: 'frontend', confidence: 'CERTAIN', evidence: 'frontend/next.config.ts a Next.js configuration file' },
      { id: 'react', name: 'React', category: 'frontend', regionPath: 'frontend', confidence: 'CERTAIN', evidence: "frontend/package.json declares 'react'" },
      { id: 'express', name: 'Express', category: 'backend', regionPath: '', confidence: 'CERTAIN', evidence: "package.json declares 'express'" },
      { id: 'prisma', name: 'Prisma', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "package.json declares '@prisma/client'" },
      { id: 'redis', name: 'Redis', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "package.json declares 'ioredis'" },
      { id: 'gha', name: 'GitHub Actions', category: 'infrastructure', regionPath: '', confidence: 'CERTAIN', evidence: '.github/workflows/ci.yml a workflow' },
    ],
    routes: [
      { node: node('route:GET:/:shortCode'), method: 'GET', composition: { effectivePath: '/:shortCode', composed: true, note: '' } },
      { node: node('route:GET:/:shortCode/analytics'), method: 'GET', composition: { effectivePath: '/:shortCode/analytics', composed: true, note: '' } },
      { node: node('route:POST:/login'), method: 'POST', composition: { effectivePath: '/login', composed: true, note: '' } },
    ],
    dependencies: {
      ...base.dependencies,
      environmentVariables: [node('env:DATABASE_URL', { name: 'DATABASE_URL' }), node('env:REDIS_URL', { name: 'REDIS_URL' })],
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        // Real member names, taken from LinkForge: the whole point is that names carry the domains,
        // so a fixture of empty listings would test nothing this milestone changed.
        architecture: {
          controllers: {
            entries: ['analyticsController', 'authController', 'urlController'].map((name) =>
              node(`sym:src/modules/${name}.ts#${name}`, { name }),
            ),
            total: 6,
            truncated: true,
          },
          services: {
            entries: ['analyticsService', 'authService', 'DefaultUrlService'].map((name) =>
              node(`sym:src/modules/${name}.ts#${name}`, { name }),
            ),
            total: 7,
            truncated: true,
          },
          repositories: {
            entries: ['PrismaAnalyticsRepository', 'PrismaUrlRepository', 'sessionRepository'].map((name) =>
              node(`sym:src/modules/${name}.ts#${name}`, { name }),
            ),
            total: 14,
            truncated: true,
          },
          middleware: {
            entries: ['corsMiddleware', 'requestLogger'].map((name) =>
              node(`sym:src/shared/${name}.ts#${name}`, { name }),
            ),
            total: 8,
            truncated: true,
          },
          models: { entries: [], total: 0, truncated: false },
          tests: { entries: [], total: 135, truncated: true },
          routes: { entries: [], total: 3, truncated: false },
        },
      },
    },
    ...overrides,
  } as unknown as RepositoryContext;
}

describe('the architecture summary', () => {
  const summary = summariseArchitecture(linkforgeish());

  it('separates what stores state from what caches it', () => {
    // Both are `data` to the detection layer. A reader asking where state lives needs the difference.
    expect(summary.persistence.map((entry) => entry.name)).toEqual(['Prisma']);
    expect(summary.cache.map((entry) => entry.name)).toEqual(['Redis']);
  });

  it('names the frontend and the backend separately, with the region each was found in', () => {
    expect(summary.frontend.map((entry) => entry.name)).toEqual(['Next.js', 'React']);
    expect(summary.frontend[0]?.region).toBe('frontend');
    expect(summary.backend.map((entry) => entry.name)).toEqual(['Express']);
  });

  it('reports only the role layers that exist', () => {
    expect(summary.layers.map((layer) => layer.role)).toEqual(['Controller', 'Service', 'Repository', 'Middleware']);
    // Model has a total of zero and is absent rather than reported as empty.
    expect(summary.layers.some((layer) => layer.role === 'Model')).toBe(false);
  });

  it('builds a request flow from the layers present, in conventional order', () => {
    expect(summary.requestFlow).toEqual(['Middleware', 'Controller', 'Service', 'Repository']);
  });

  it('refuses to build a flow out of one layer', () => {
    // `HTTP request → Controller` would dress a single fact up as a pipeline.
    const thin = linkforgeish();
    const value = (thin.primary as unknown as { value: Record<string, unknown> }).value;

    (value.architecture as Record<string, unknown>).services = { entries: [], total: 0, truncated: false };
    (value.architecture as Record<string, unknown>).repositories = { entries: [], total: 0, truncated: false };
    (value.architecture as Record<string, unknown>).middleware = { entries: [], total: 0, truncated: false };

    const facts = project(thin, { tier: 'full' }).facts;

    expect(facts.some((fact) => fact.predicate === 'request-flow')).toBe(false);
  });

  it('groups routes by their first segment, keeping a real path in each group', () => {
    const group = summary.routeGroups.find((entry) => entry.prefix === '/:shortCode');

    expect(group?.count).toBe(2);
    expect(group?.example).toBe('GET /:shortCode');
  });

  it('never claims a technology the graph did not detect', () => {
    // LinkForge declares `@prisma/adapter-pg` and no `pg`, so PostgreSQL is not detected — and a
    // summary that named it would be inventing the single most plausible thing it could invent.
    const rendered = JSON.stringify(summary);

    expect(rendered).not.toContain('PostgreSQL');
    expect(rendered).not.toContain('Postgres');
  });
});

describe('the summary reaches the prompt first, and stays grounded', () => {
  const projection = project(linkforgeish(), { tier: 'standard', intent: 'architecture' });

  it('puts what the system is ahead of what it contains', () => {
    // The whole point: a model handed a role count and a file count at the same rank answers with
    // both at the same rank, and never says what the repository does.
    //
    // Two facts now precede the stack rather than one. `characterised-as` says what kind of thing the
    // repository is — the claim the explanation strategy is built around — and `runs-on` says what it
    // is built from. Both are ahead of every count, which is the property this asserts.
    expect(projection.facts[0]?.predicate).toBe('characterised-as');

    const stack = projection.facts.findIndex((fact) => fact.predicate === 'runs-on');
    const counts = projection.facts.findIndex((fact) => fact.predicate === 'contains');

    expect(projection.facts[stack]?.object).toContain('frontend');
    expect(stack).toBeLessThan(counts);
  });

  it('makes every technology it names claimable', () => {
    for (const name of ['next.js', 'react', 'express', 'prisma', 'redis']) {
      expect(projection.terms.has(name), name).toBe(true);
    }
  });

  it('makes every route and environment variable it names claimable', () => {
    expect(projection.terms.has('/login')).toBe(true);
    expect(projection.terms.has('database_url')).toBe(true);
  });

  it('carries the role layers at the confidence the annotations had', () => {
    const layered = projection.facts.filter((fact) => fact.predicate === 'layered');

    expect(layered.length).toBeGreaterThan(0);
    // A role is a judgement the Framework Extractor made, and summarising must not promote it.
    expect(layered.every((fact) => fact.confidence === 'INFERRED')).toBe(true);
  });

  it('says that the request-flow order is a convention rather than a measured call chain', () => {
    const flow = projection.facts.find((fact) => fact.predicate === 'request-flow');

    expect(flow?.object).toContain('not a measured call chain');
    expect(flow?.confidence).toBe('INFERRED');
  });
});

describe('names and responsibilities replace counts', () => {
  const summary = summariseArchitecture(linkforgeish());
  const projection = project(linkforgeish(), { tier: 'standard', intent: 'architecture' });
  const objectOf = (predicate: string): string =>
    projection.facts.filter((fact) => fact.predicate === predicate).map((fact) => fact.object).join(' | ');

  it('introduces a technology by what it is for, before naming it', () => {
    // "Redis" is a name. "keeps hot data in memory so repeated reads avoid the database" is the thing
    // a reader needs in order to reason about why it is there.
    expect(objectOf('runs-on')).toContain('keeps hot data in memory');
    expect(objectOf('runs-on')).toContain('renders the user interface');
    expect(objectOf('runs-on')).toContain('serves HTTP requests');
  });

  it('names the members of a layer rather than counting them', () => {
    const layered = objectOf('layered');

    expect(layered).toContain('Repository:');
    expect(layered).toMatch(/Repository: [A-Za-z]/);
    // The count survives as supporting evidence, in parentheses, after the names.
    expect(layered).toContain('in total');
  });

  it('derives a capability only where two role layers agree on the noun', () => {
    const nouns = summary.capabilities.map((capability) => capability.noun);

    // url, auth and analytics each have a controller and a service; nothing else does.
    expect(nouns).toContain('url');
    expect(nouns).toContain('auth');
    expect(nouns).toContain('analytics');
    expect(summary.capabilities.every((capability) => capability.layers.length >= 2)).toBe(true);
  });

  it('drops a noun that only one layer mentions', () => {
    // A single `sessionRepository` is a file name, not a capability the system is organised around.
    const single = summary.capabilities.find((capability) => capability.noun === 'session');

    expect(single).toBeUndefined();
  });

  it('builds a flow naming this repository, not the framework pattern', () => {
    const flow = objectOf('request-flow');

    // Generic MVC would read identically for any Express application.
    expect(flow).toContain('Next.js');
    expect(flow).toContain('Express');
    expect(flow).toContain('Redis');
    expect(flow).toContain('Prisma');
    expect(flow).toMatch(/Controller \(/);
  });

  it('draws no stage the graph did not record', () => {
    const bare = linkforgeish({ technologies: [] });
    const flow = project(bare, { tier: 'full' })
      .facts.filter((fact) => fact.predicate === 'request-flow')
      .map((fact) => fact.object)
      .join('');

    // No frontend, no cache, no persistence detected — so none of them appear as a stage.
    expect(flow).not.toContain('Redis');
    expect(flow).not.toContain('Next.js');
    expect(flow).toContain('HTTP request');
  });

  it('makes every named component claimable, so naming them cannot cost grounding', () => {
    for (const name of ['prismaanalyticsrepository', 'urlcontroller', 'authservice', 'url', 'analytics']) {
      expect(projection.terms.has(name), name).toBe(true);
    }
  });

  it('marks everything derived as inferred rather than observed', () => {
    for (const predicate of ['layered', 'capability', 'request-flow']) {
      const facts = projection.facts.filter((fact) => fact.predicate === predicate);

      expect(facts.length, predicate).toBeGreaterThan(0);
      expect(facts.every((fact) => fact.confidence === 'INFERRED'), predicate).toBe(true);
    }

    // A detected technology is observed, and must not be demoted by sitting beside derived facts.
    expect(
      projection.facts.filter((fact) => fact.predicate === 'runs-on').every((fact) => fact.confidence === 'CERTAIN'),
    ).toBe(true);
  });
});

describe('the instruction stays small enough to be worth its place', () => {
  it('is well under the 738 tokens it had grown to', () => {
    // Behavioural guidance moved into the facts — a technology now carries its own responsibility, a
    // layer carries its own members — so the instruction no longer has to describe what good looks
    // like in prose it pays for on every single question.
    expect(estimatingCounter.count(SYSTEM_PROMPT)).toBeLessThan(600);
  });
});
