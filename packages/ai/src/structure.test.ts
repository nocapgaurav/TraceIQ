import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { summariseArchitecture } from './architecture.js';
import { deriveIdentity } from './identity.js';
import { rankComponents } from './importance.js';
import { deriveProfile } from './profile.js';
import { deriveStructure, isProductionPath, ownRoutes, roleOfPath, scopedTechnologies } from './structure.js';
import { workflowsOf } from './workflow.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * A monorepo whose sample applications must not become its architecture.
 *
 * **This is `stripe/ai` reduced to the smallest fixture that reproduces it.** That repository reported a
 * persistence layer of Mongoose, SQLite, Drizzle ORM and PostgreSQL, a stack of Next.js, React, Flask and
 * Express, six workflows named for checkout and payment, and a surface exposing
 * `POST /create-checkout-session` — from six unrelated benchmark fixtures, none of which has ever run in
 * the same process as another. Every detection was correct; the composition was fiction.
 *
 * The fixture below has the same shape at a tenth of the size: two real library packages, two sample
 * applications under `benchmarks/`, and one example under `tools/`. Nothing here is named after
 * `stripe/ai` — the fixture directories are called `environment` and `solution` in that repository and
 * neither word appears in the vocabulary, because what disqualifies them is sitting under `benchmarks/`.
 */

const listing = (entries: readonly unknown[], total = entries.length): Record<string, unknown> => ({
  entries,
  total,
  truncated: total > entries.length,
});

const declaration = (id: string, name: string): Record<string, unknown> => node(id, { name, fileId: `file:${id.slice(4).split('#')[0]}` });

function region(path: string, language: string, sources: number, packaged = true): Record<string, unknown> {
  return {
    path,
    primaryLanguage: language,
    depth: 'semantic',
    fileCount: sources * 2,
    sourceFileCount: sources,
    reason: 'analysed',
    ecosystems: packaged ? ['npm'] : [],
  };
}

function technology(name: string, category: string, regionPath: string): Record<string, unknown> {
  return { id: name.toLowerCase(), name, category, regionPath, confidence: 'CERTAIN', evidence: `declares '${name.toLowerCase()}'` };
}

/** A route whose node carries no file, exactly as the graph emits one it merged across several. */
function mergedRoute(method: string, routePath: string, handlerId: string | null): Record<string, unknown> {
  return {
    node: node(`route:${method}:${routePath}`, { fileId: null }),
    method,
    path: routePath,
    composition: { composed: true, prefixes: [], effectivePath: routePath, note: '' },
    handlers:
      handlerId === null
        ? []
        : [
            {
              edge: { id: 'e', type: 'HANDLES_ROUTE', sourceId: 'r', targetId: handlerId, confidence: 'CERTAIN' },
              declaration: declaration(handlerId, handlerId.split('#').at(-1) ?? ''),
            },
          ],
  };
}

function showcase(): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;

  return {
    ...base,
    technologies: [
      // The repository's own: at the root, and in its two library packages.
      technology('GitHub Actions', 'infrastructure', ''),
      technology('Jest', 'testing', 'lib/core'),
      // Four unrelated sample applications' stacks. Every one is really there.
      technology('Mongoose', 'data', 'benchmarks/petshop/environment'),
      technology('Next.js', 'frontend', 'benchmarks/petshop/environment'),
      technology('PostgreSQL', 'data', 'benchmarks/saas/environment'),
      technology('Drizzle ORM', 'data', 'benchmarks/saas/environment'),
      technology('SQLite', 'data', 'benchmarks/invoicing/solution'),
      technology('Express', 'backend', 'benchmarks/invoicing/solution'),
      technology('Flask', 'backend', 'tools/python/examples/support'),
    ],
    routes: [
      mergedRoute('POST', '/create-checkout-session', 'sym:benchmarks/invoicing/solution/server.js#checkout'),
      mergedRoute('GET', '/customer/:email/bookings', 'sym:benchmarks/petshop/environment/app/api.ts#bookings'),
      // The hard case: merged across several fixtures, so the graph has no file and no handler for it.
      mergedRoute('GET', '/', null),
    ] as never,
    capabilities: {
      ...base.capabilities,
      regions: [
        region('', 'typescript', 4),
        region('lib/core', 'typescript', 22),
        region('lib/meter', 'typescript', 11),
        region('benchmarks/petshop/environment', 'typescript', 120),
        region('benchmarks/saas/environment', 'typescript', 33),
        region('benchmarks/invoicing/solution', 'javascript', 14),
        region('tools/python/examples/support', 'python', 6),
      ],
    },
    dependencies: {
      ...base.dependencies,
      externalPackages: [
        node('ext:npm:mongoose', { kind: 'External', externalName: 'mongoose', fileId: null }),
        node('ext:npm:next-auth', { kind: 'External', externalName: 'next-auth', fileId: null }),
      ],
      environmentVariables: [
        node('env:STRIPE_SECRET_KEY', { name: 'STRIPE_SECRET_KEY', fileId: null }),
        node('env:DATABASE_URL', { name: 'DATABASE_URL', fileId: null }),
      ],
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          repository: { files: 420, declarations: 900, routes: 3 },
          packages: listing([
            { name: 'lib/core', files: 22, declarations: 180, dependencies: 0, dependents: 1 },
            { name: 'lib/meter', files: 11, declarations: 90, dependencies: 1, dependents: 0 },
            { name: 'benchmarks/petshop', files: 220, declarations: 410, dependencies: 0, dependents: 0 },
            { name: 'benchmarks/saas', files: 51, declarations: 120, dependencies: 0, dependents: 0 },
          ]),
        },
        architecture: {
          controllers: listing([]),
          services: listing([declaration('sym:lib/core/meter.ts#meterService', 'meterService')]),
          repositories: listing([]),
          middleware: listing([]),
          // Entirely a sample application's, which is what made the domains fiction.
          models: listing([
            declaration('sym:benchmarks/petshop/environment/app/models/salon.ts#Salon', 'Salon'),
            declaration('sym:benchmarks/petshop/environment/app/models/salon.ts#SalonSchema', 'SalonSchema'),
          ]),
          tests: listing([declaration('sym:lib/core/tests/meter.test.ts#meterTest', 'meterTest')]),
          routes: listing([], 3),
        },
        hotspots: {
          // The fixture's declarations really are the most referenced in the tree.
          mostReferenced: listing([
            { node: declaration('sym:benchmarks/petshop/environment/app/models/salon.ts#Salon', 'Salon'), fanIn: 61, fanOut: 3, incomingEdges: 61, outgoingEdges: 3 },
            { node: declaration('sym:lib/core/meter.ts#meterService', 'meterService'), fanIn: 12, fanOut: 4, incomingEdges: 12, outgoingEdges: 4 },
          ]),
          mostCoupled: listing([]),
          largestFanIn: listing([]),
          mostConnectedFiles: listing([]),
        },
      },
    },
  } as unknown as RepositoryContext;
}

const SHOWCASE = showcase();

describe('a path says which part of a repository it belongs to', () => {
  it.each([
    ['lib/core', 'production'],
    ['src/modules/url', 'production'],
    ['benchmarks/petshop/environment', 'benchmark'],
    ['tools/python/examples/support', 'example'],
    ['packages/react/src/__tests__', 'test'],
    ['fixtures/flight/server', 'test'],
    ['docs_src/sql_databases', 'documentation'],
    ['src/generated/prisma', 'generated'],
    ['node_modules/react', 'vendored'],
    ['dist/index.js', 'generated'],
  ])('reads %j as %s', (path, role) => {
    expect(roleOfPath(path)).toBe(role);
  });

  it('does not disqualify a path for a role word inside a namespace', () => {
    /*
     * The regression that removed `sample` and `samples` from the vocabulary, and which now protects the
     * whole table. Spring PetClinic's application code lives under `org/springframework/samples/`, and a
     * vocabulary containing `samples` discounted all fourteen of its owner routes.
     */
    expect(isProductionPath('src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java')).toBe(true);
    // `testing` as part of a longer word is not the word.
    expect(isProductionPath('src/main/java/com/acme/attestation/Service.java')).toBe(true);
    expect(isProductionPath('src/latest/handler.ts')).toBe(true);
  });
});

describe('unrelated sample applications do not become one architecture', () => {
  const architecture = summariseArchitecture(SHOWCASE);

  it('gives the repository no persistence layer it does not have', () => {
    // The headline failure: four stacks from four fixtures reported as one.
    expect(architecture.persistence).toEqual([]);
    expect(architecture.cache).toEqual([]);
    expect(deriveIdentity(SHOWCASE).persistence).toBeNull();
  });

  it('gives it no frontend and no backend from a sample application', () => {
    expect(architecture.frontend).toEqual([]);
    expect(architecture.backend).toEqual([]);
  });

  it('keeps the repository-wide technologies that really are', () => {
    // Scoping must not silence the root manifest, the Dockerfile or the workflow file.
    expect(architecture.infrastructure.map((entry) => entry.name)).toEqual(['GitHub Actions']);
    expect(architecture.testing.map((entry) => entry.name)).toEqual(['Jest']);
  });

  it('still records every set-aside technology, as what it is', () => {
    /*
     * Discarding them would make the analysis silent about most of the files in the repository. The point
     * was never to hide them — it was to stop them being described as the repository's own.
     */
    const names = architecture.incidental.map((entry) => `${entry.name} (${entry.role})`);

    expect(names).toContain('Mongoose (benchmark)');
    expect(names).toContain('SQLite (benchmark)');
    expect(names).toContain('Flask (example)');
    expect(architecture.incidental).toHaveLength(7);
  });

  it('reports where the repository’s own code lives, and that there is more than one unit of it', () => {
    expect(architecture.scope.production).toEqual(['', 'lib/core', 'lib/meter']);
    expect(architecture.scope.composition).toBe('several');
    // Most of the analysed source is not the repository's own, which is the fact that made it dangerous.
    expect(architecture.scope.productionShare).toBeLessThan(0.5);
  });
});

describe('routes and workflows belong to whoever registered them', () => {
  it('keeps no route the repository does not serve', () => {
    expect(ownRoutes(SHOWCASE)).toEqual([]);
    expect(summariseArchitecture(SHOWCASE).routeGroups).toEqual([]);
    expect(summariseArchitecture(SHOWCASE).routeCount).toBe(0);
  });

  it('still reports how many routes were declared, which is the framework signal', () => {
    // Scoping `routeCount` to the repository's own routes made the profile's proportion test compare a
    // number with itself, and Flask and Gin became web services again. Both counts are carried.
    expect(summariseArchitecture(SHOWCASE).declaredRouteCount).toBe(3);
  });

  it('discounts a merged route the repository could not have registered', () => {
    /*
     * The subtlest of the three route cases. `GET /` is one node the graph materialised from several
     * framework registrations, so it carries no file and no handler — and "absence of evidence is not
     * evidence" kept it. What settles it is that no production region declares a backend framework, so
     * nothing in the repository's own code could have registered a route at all.
     */
    const merged = SHOWCASE.routes.filter((route) => (route as { readonly path?: string }).path === '/');

    expect(merged).toHaveLength(1);
    expect(ownRoutes(SHOWCASE)).not.toContain(merged[0]);
  });

  it('keeps an unattributable route where the repository does serve routes', () => {
    // The same route, on a repository whose own code declares a server framework. Believing it is then
    // the safe direction, and Flask, Gin, LinkForge and PetClinic all depend on that.
    const serving = {
      ...SHOWCASE,
      technologies: [...SHOWCASE.technologies, technology('Express', 'backend', 'lib/core')],
    } as unknown as RepositoryContext;

    expect(ownRoutes(serving).length).toBe(1);
  });

  it('narrates no workflow through a sample application', () => {
    // A workflow reads as a measurement, which made this the most confident form of the fiction.
    expect(workflowsOf(SHOWCASE).filter((workflow) => workflow.routes > 0)).toEqual([]);
  });
});

describe('a sample application cannot dominate what matters', () => {
  it('ranks the repository’s own code above a fixture that outranks it', () => {
    /*
     * `Salon` genuinely has 61 incoming references and `meterService` has 12. The measurement is right
     * and the conclusion was wrong: nobody maintaining this repository needs to understand a sample
     * pet-grooming application's model. Identical in kind to the generated-code failure that put
     * `SelectSubset` at the top of LinkForge.
     */
    const names = rankComponents(SHOWCASE).map((component) => component.name);

    expect(names).not.toContain('Salon');
    expect(names).not.toContain('SalonSchema');
    expect(names).toContain('meterService');
  });

  it('ranks no benchmark package as a unit to read', () => {
    const units = rankComponents(SHOWCASE)
      .filter((component) => component.kind === 'package')
      .map((component) => component.name);

    expect(units).toEqual(expect.arrayContaining(['lib/core', 'lib/meter']));
    expect(units).not.toContain('benchmarks/petshop');
  });

  it('organises the repository around nothing a fixture named', () => {
    // `Salon` and `SalonSchema` are the whole of the `Model` layer, and the domains were derived from it.
    const domains = deriveProfile(SHOWCASE).domains.map((claim) => claim.domain);

    expect(domains).not.toContain('rendering');
    expect(domains).not.toContain('authentication');
  });
});

describe('missing evidence stays missing', () => {
  it('claims no security surface from a secret-shaped variable alone', () => {
    /*
     * A credential the code *sends* is not a guard the code *applies*. This repository reads
     * `STRIPE_SECRET_KEY` and serves no route, and the identity used to report that as what guards its
     * surface.
     */
    expect(deriveIdentity(SHOWCASE).security).toBeNull();
  });

  it('claims no domain from an unplaceable name when most of the source is a showcase', () => {
    // `mongoose` and `next-auth` are really declared. They are declared by fixtures, and a repository
    // context cannot attribute an external package to a file — so in a repository that is mostly
    // demonstrations, a dependency name is not enough on its own.
    const domains = deriveProfile(SHOWCASE).domains.map((claim) => claim.domain);

    expect(domains).not.toContain('authentication');
  });

  it('still claims a domain from an unplaceable name in an ordinary repository', () => {
    /*
     * The other half, and the one that keeps the rule from being a blunt instrument. Almost every real
     * repository has a `tests` or `docs` directory; dropping dependency-derived domains on that basis
     * would cost a genuine service the `persistence` domain whose only evidence is a `DATABASE_URL`.
     */
    const ordinary = {
      ...SHOWCASE,
      capabilities: {
        ...SHOWCASE.capabilities,
        regions: [region('', 'typescript', 4), region('lib/core', 'typescript', 40), region('tests', 'typescript', 3, false)],
      },
    } as unknown as RepositoryContext;

    expect(deriveStructure(ordinary).productionShare).toBeGreaterThan(0.5);
    expect(deriveProfile(ordinary).domains.map((claim) => claim.domain)).toContain('persistence');
  });
});

describe('a repository that is only demonstrations is still described', () => {
  it('falls back to describing them rather than describing nothing', () => {
    /*
     * The safe direction. A repository of nothing but examples has an architecture — the examples' — and
     * reporting that it has none would be a worse answer than reporting theirs. The filtering exists to
     * stop a showcase outvoting the code beside it, not to erase a repository that is a showcase.
     */
    const onlyExamples = {
      ...SHOWCASE,
      capabilities: {
        ...SHOWCASE.capabilities,
        regions: [region('examples/one', 'typescript', 10), region('examples/two', 'typescript', 8)],
      },
    } as unknown as RepositoryContext;

    const structure = deriveStructure(onlyExamples);

    expect(structure.production).toHaveLength(2);
    expect(structure.incidental).toEqual([]);
    expect(scopedTechnologies(onlyExamples, structure).repositoryWide.length).toBeGreaterThan(0);
  });
});

describe('tests reach the answer as things a reader can open', () => {
  const architecture = summariseArchitecture(SHOWCASE);

  it('names the repository’s own tests with their paths', () => {
    // The only test evidence a prompt ever carried was the count `N declarations carry the Test role`,
    // which is why a test question was answered with an architecture overview. A count cannot be opened.
    expect(architecture.testFiles.map((test) => test.path)).toEqual(['lib/core/tests/meter.test.ts']);
    expect(architecture.testFiles[0]?.area).toBe('lib/core');
  });

  it('maps a test to what its name says it exercises, as a convention', () => {
    // `meter.test.ts` against `meterService`: a naming agreement between two independently recorded
    // facts. It is never rendered as an observed relationship — see the `tested-by` extractor.
    expect(architecture.testFiles[0]?.covers).toEqual(['meterService']);
  });

  it('claims no coverage it cannot derive', () => {
    const orphan = {
      ...SHOWCASE,
      primary: {
        type: 'repository',
        value: {
          ...(SHOWCASE.primary as unknown as { value: Record<string, unknown> }).value,
          architecture: {
            ...((SHOWCASE.primary as unknown as { value: Record<string, unknown> }).value.architecture as Record<string, unknown>),
            tests: listing([declaration('sym:lib/core/tests/smoke.test.ts#smoke', 'smoke')]),
          },
        },
      },
    } as unknown as RepositoryContext;

    // Nothing named `smoke` is annotated, so the honest answer is that the analysis cannot say.
    expect(summariseArchitecture(orphan).testFiles[0]?.covers).toEqual([]);
  });

  it('offers no sample application’s test suite as something to read', () => {
    const fixtureTests = {
      ...SHOWCASE,
      primary: {
        type: 'repository',
        value: {
          ...(SHOWCASE.primary as unknown as { value: Record<string, unknown> }).value,
          architecture: {
            ...((SHOWCASE.primary as unknown as { value: Record<string, unknown> }).value.architecture as Record<string, unknown>),
            tests: listing([
              declaration('sym:benchmarks/petshop/environment/tests/salon.test.ts#salonTest', 'salonTest'),
              declaration('sym:lib/core/tests/meter.test.ts#meterTest', 'meterTest'),
            ]),
          },
        },
      },
    } as unknown as RepositoryContext;

    // A repository holding sample applications holds their tests too, and a reader asking what to read
    // first does not mean a fixture's suite.
    expect(summariseArchitecture(fixtureTests).testFiles.map((test) => test.path)).toEqual(['lib/core/tests/meter.test.ts']);
  });
});

describe('the identity carries the tests as things to open', () => {
  it('names them with the count the analysis could resolve', () => {
    const identity = deriveIdentity(SHOWCASE);

    expect(identity.tests?.value).toEqual(['lib/core/tests/meter.test.ts']);
    expect(identity.tests?.evidence.join(' ')).toContain('1 have a subject the analysis could identify');
  });

  it('is null where the repository has no tests of its own', () => {
    const untested = {
      ...SHOWCASE,
      primary: {
        type: 'repository',
        value: {
          ...(SHOWCASE.primary as unknown as { value: Record<string, unknown> }).value,
          architecture: {
            ...((SHOWCASE.primary as unknown as { value: Record<string, unknown> }).value.architecture as Record<string, unknown>),
            tests: listing([]),
          },
        },
      },
    } as unknown as RepositoryContext;

    // `null` rather than an empty list, on the convention the whole identity follows: the absence is a
    // statement about the analysis, and a locating answer has to say so rather than fill it in.
    expect(deriveIdentity(untested).tests).toBeNull();
  });
});
