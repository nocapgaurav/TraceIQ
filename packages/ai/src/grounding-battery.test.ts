import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { checkGrounding } from './grounding.js';
import { project } from './projection.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * Every category of claim an answer about a repository actually makes, adjudicated end to end.
 *
 * **The guard's two failure modes are not symmetric, and this battery exists to hold both.** Accusing a
 * correct answer is the worse one: a user shown "ungrounded" beside a true sentence learns to ignore
 * the verdict, and then the guard protects nothing. Missing a fabrication costs one unflagged sentence.
 * But loosening a guard until nothing fails is how a verifier becomes decoration — so every permissive
 * case below is paired with a fabricated control of the *same shape*, and the negative half of this file
 * is what makes the positive half safe to change.
 *
 * **The projection is real, not hand-written.** A first version declared the permitted sets by hand and
 * promptly disagreed with what `termsFrom` actually produces — which made it a test of the fixture
 * rather than of the guard. Everything below is adjudicated against a projection of a fixture context,
 * so a change to either half of the pair is caught.
 *
 * The categories come from the manual runs rather than from imagination: route paths and `CI/CD` were
 * both reported against otherwise correct answers.
 */

const listing = (entries: readonly unknown[], total = entries.length): Record<string, unknown> => ({
  entries,
  total,
  truncated: total > entries.length,
});

const declaration = (name: string): Record<string, unknown> => node(`sym:src/modules/${name}.ts#${name}`, { name });

function route(method: string, routePath: string, handler: string): Record<string, unknown> {
  return {
    node: node(`route:${method}:${routePath}`, { fileId: 'file:src/routes.ts' }),
    method,
    path: routePath,
    composition: { composed: true, prefixes: [], effectivePath: routePath, note: '' },
    handlers: [
      {
        edge: {
          id: `e:${handler}`,
          type: 'HANDLES_ROUTE',
          sourceId: 'r',
          targetId: `sym:src/modules/${handler}.ts#${handler}`,
          confidence: 'CERTAIN',
        },
        declaration: declaration(handler),
      },
    ],
  };
}

function context(): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;

  return {
    ...base,
    technologies: [
      { id: 'redis', name: 'Redis', category: 'data', regionPath: '', confidence: 'CERTAIN', evidence: "declares 'ioredis'" },
      { id: 'gha', name: 'GitHub Actions', category: 'infrastructure', regionPath: '', confidence: 'CERTAIN', evidence: 'a workflow is present' },
    ],
    routes: [
      route('POST', '/create-checkout-session', 'checkoutController'),
      route('GET', '/customer/:email/bookings', 'bookingController'),
    ] as never,
    dependencies: {
      ...base.dependencies,
      externalPackages: [
        node('ext:npm:ioredis', { kind: 'External', externalName: 'ioredis', fileId: null }),
        node('ext:npm:@prisma/client', { kind: 'External', externalName: '@prisma/client', fileId: null }),
        node('ext:maven:org.springframework:spring-core', {
          kind: 'External',
          externalName: 'org.springframework:spring-core',
          fileId: null,
        }),
        node('ext:go:github.com/gin-gonic/gin', { kind: 'External', externalName: 'github.com/gin-gonic/gin', fileId: null }),
      ],
      environmentVariables: [node('env:REDIS_URL', { name: 'REDIS_URL' })],
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          repository: { files: 40, declarations: 120, routes: 2 },
          packages: listing([{ name: 'src/modules', files: 12, declarations: 100, dependencies: 1, dependents: 0 }]),
        },
        architecture: {
          controllers: listing(['checkoutController', 'bookingController'].map(declaration)),
          services: listing([]),
          repositories: listing([]),
          middleware: listing([]),
          models: listing([]),
          tests: listing([]),
          routes: listing([], 2),
        },
      },
    },
  } as unknown as RepositoryContext;
}

// `full` so the budget admits everything: this battery is about what the guard permits, and a fact the
// budget cut is a name the model was legitimately not shown.
const PROJECTION = project(context(), { tier: 'full' });

/** One cited sentence, so the verdict turns on the claim rather than on a missing citation. */
const verdictFor = (claim: string): ReturnType<typeof checkGrounding> =>
  checkGrounding(`The repository does this through ${claim} [f1].`, PROJECTION);

describe('claims a correct answer makes must survive', () => {
  it.each([
    ['a route path exactly as the facts record it', '`/create-checkout-session`'],
    ['a route path with a parameter segment', '`/customer/:email/bookings`'],
    ['a route path written bare rather than in backticks', '/create-checkout-session'],
    ['a route identifier', '`route:POST:/create-checkout-session`'],
    ['a full file path', '`src/modules/checkoutController.ts`'],
    ['a file by its basename', '`checkoutController.ts`'],
    ['a declaration identifier', '`sym:src/modules/checkoutController.ts#checkoutController`'],
    ['a declaration by its name alone', '`checkoutController`'],
    ['a scoped package', '`@prisma/client`'],
    ['a scoped package by its last segment', '`client`'],
    ['a plain dependency', '`ioredis`'],
    ['a Maven coordinate', '`org.springframework:spring-core`'],
    ['a Maven coordinate by its artefact', '`spring-core`'],
    ['a Go module path', '`github.com/gin-gonic/gin`'],
    ['a package directory', '`src/modules`'],
    ['an environment variable', '`env:REDIS_URL`'],
    ['a technology the manifest declared', '`Redis`'],
  ])('accepts %s', (_case, claim) => {
    const report = verdictFor(claim);

    expect({ case: _case, unsupported: report.unsupportedTerms, fabricated: report.fabricatedIdentifiers }).toEqual({
      case: _case,
      unsupported: [],
      fabricated: [],
    });
    expect(report.verdict).toBe('grounded');
  });

  it.each([
    /*
     * Category words a model writes about any repository, none of which is an artefact.
     *
     * `CI/CD` was reported as an unsupported package in a manual run. Adjudicating it against a manifest
     * is a category error: the standing instruction already forbids generalising GitHub Actions into
     * "CI/CD", and that is a *prose* rule for the model, not a naming claim for the verifier.
     */
    ['CI/CD in backticks', '`CI/CD`'],
    ['CI/CD bare in a sentence', 'its CI/CD pipeline'],
    ['I/O', '`I/O`'],
    ['TCP/IP', 'TCP/IP'],
    ['HTTP/2', 'HTTP/2'],
    ['and/or between two clauses', 'the service and/or the worker'],
  ])('does not adjudicate the prose acronym %s as a package', (_case, claim) => {
    expect(verdictFor(claim).unsupportedTerms).toEqual([]);
  });
});

describe('fabrications of every one of those shapes must still fail', () => {
  it.each([
    ['an invented route path', '`/admin/delete-everything`'],
    ['an invented file path', '`src/modules/billing/billingService.ts`'],
    ['an invented identifier', '`sym:src/modules/billing/billingService.ts#billingService`'],
    ['an invented route identifier', '`route:DELETE:/admin/purge`'],
    ['an invented scoped package', '`@stripe/checkout`'],
    ['an invented hyphenated package', '`aws-sdk/client-s3`'],
    ['an invented Maven coordinate', '`org.hibernate:hibernate-core`'],
    ['an invented Go module', '`github.com/redis/go-redis`'],
    ['an invented environment variable', '`env:STRIPE_SECRET_KEY`'],
    ['a plausible framework nobody declared', '`next.js/router`'],
    // Mixed case with a five-character segment: the shape a scoped package has, not the shape an
    // acronym pair has. The exemption must not reach it.
    ['a mixed-case slashed name', '`React/DOM`'],
  ])('rejects %s', (_case, claim) => {
    const report = verdictFor(claim);

    expect(report.verdict).toBe('ungrounded');
    expect([...report.unsupportedTerms, ...report.fabricatedIdentifiers].length).toBeGreaterThan(0);
  });

  it('still rejects an invented fact id', () => {
    expect(checkGrounding('It does this [f9999].', PROJECTION).verdict).toBe('ungrounded');
  });

  it('still reports an answer that cited nothing as unverifiable', () => {
    expect(checkGrounding('It is a service.', PROJECTION).verdict).toBe('unverifiable');
  });

  it('rejects a route path that differs from a real one by a segment', () => {
    // The narrowest possible control on the route normalisation: one real path, one that is not, and
    // the two differ only in the last segment.
    expect(verdictFor('`/customer/:email/invoices`').verdict).toBe('ungrounded');
  });
});
