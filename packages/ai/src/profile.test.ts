import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { NAMING_CAPACITY, deriveProfile, subsystemsOf } from './profile.js';
import { project } from './projection.js';
import { node, repositoryContext } from './fixtures.test-helper.js';

/**
 * Repositories shaped like the ones the milestone names, each built to exercise one rule.
 *
 * **Built rather than recorded, and each one deliberately minimal.** A recorded context is whatever a
 * real repository happened to contain, and a test that depends on it cannot say what it is testing. Each
 * fixture below carries exactly the evidence its rule needs and nothing else, so a passing test names the
 * evidence that made it pass — and a fixture stripped of that evidence is expected to fall back to
 * `unknown`, which several tests assert directly.
 */

interface Shape {
  readonly technologies?: readonly Record<string, unknown>[];
  readonly routes?: readonly Record<string, unknown>[];
  readonly packages?: readonly { readonly name: string; readonly declarations: number }[];
  readonly regions?: readonly Record<string, unknown>[];
  readonly externalPackages?: readonly string[];
  readonly environmentVariables?: readonly string[];
  readonly files?: number;
  readonly declarations?: number;
  readonly layers?: Record<string, readonly string[]>;
}

function technology(id: string, name: string, category: string, region = ''): Record<string, unknown> {
  return { id, name, category, regionPath: region, confidence: 'CERTAIN', evidence: `${region || '.'} declares ${name}` };
}

function region(path: string, ecosystems: readonly string[] = ['npm'], files = 10): Record<string, unknown> {
  return {
    path,
    primaryLanguage: 'typescript',
    languages: [{ language: 'typescript', files }],
    ecosystems,
    fileCount: files,
    sourceFileCount: files,
    depth: 'semantic',
    reason: 'the TypeScript compiler read these sources',
  };
}

function listing(entries: readonly unknown[], total = entries.length): Record<string, unknown> {
  return { entries, total, truncated: total > entries.length };
}

/** One repository context, assembled from the few fields a profile actually reads. */
function shaped(shape: Shape): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;
  const layers = shape.layers ?? {};

  const role = (key: string): Record<string, unknown> =>
    listing((layers[key] ?? []).map((name) => node(`sym:src/${name}.ts#${name}`, { name })));

  return {
    ...base,
    technologies: shape.technologies ?? [],
    routes: (shape.routes ?? []) as never,
    capabilities: {
      ...base.capabilities,
      regions: shape.regions ?? [region('')],
    },
    dependencies: {
      ...base.dependencies,
      externalPackages: (shape.externalPackages ?? []).map((name) =>
        node(`ext:npm:${name}`, { kind: 'External', name, externalName: name, fileId: null }),
      ),
      environmentVariables: (shape.environmentVariables ?? []).map((name) =>
        node(`env:${name}`, { kind: 'EnvironmentVariable', name, fileId: null }),
      ),
    },
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          repository: {
            files: shape.files ?? 120,
            declarations: shape.declarations ?? 800,
            routes: (shape.routes ?? []).length,
          },
          packages: listing(
            (shape.packages ?? []).map((entry) => ({
              name: entry.name,
              files: 5,
              declarations: entry.declarations,
              dependencies: 1,
              dependents: 1,
            })),
          ),
        },
        architecture: {
          controllers: role('Controller'),
          services: role('Service'),
          repositories: role('Repository'),
          middleware: role('Middleware'),
          models: role('Model'),
          tests: listing([]),
          routes: listing(shape.routes ?? []),
        },
      },
    },
  } as unknown as RepositoryContext;
}

function route(method: string, path: string): Record<string, unknown> {
  return { node: node(`route:${method}:${path}`), method, composition: { effectivePath: path, composed: true, note: '' } };
}

// -------------------------------------------------------------------------------------------------
// The repositories the mission names, each reduced to the evidence its rule reads.
// -------------------------------------------------------------------------------------------------

/** LinkForge: an Express service behind a Next.js frontend, with Prisma and Redis. */
const linkforge = (): RepositoryContext =>
  shaped({
    technologies: [
      technology('nextjs', 'Next.js', 'frontend', 'frontend'),
      technology('express', 'Express', 'backend'),
      technology('prisma', 'Prisma', 'data'),
      technology('redis', 'Redis', 'data'),
    ],
    routes: [route('GET', '/:shortCode'), route('POST', '/login'), route('GET', '/analytics/summary')],
    environmentVariables: ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'],
    layers: {
      Controller: ['urlController', 'authController', 'analyticsController'],
      Service: ['urlService', 'authService'],
      Repository: ['PrismaUrlRepository', 'PrismaAnalyticsRepository'],
    },
    files: 180,
    declarations: 900,
  });

/** Flask: a backend framework with no frontend and no routes of its own. */
const flaskish = (): RepositoryContext =>
  shaped({
    technologies: [technology('flask', 'Flask', 'backend'), technology('pytest', 'pytest', 'testing')],
    packages: [
      { name: 'src/flask', declarations: 900 },
      { name: 'src/flask/json', declarations: 120 },
      { name: 'src/flask/cli', declarations: 80 },
    ],
    externalPackages: ['click', 'werkzeug', 'jinja2'],
    files: 90,
    declarations: 1100,
  });

/** React: many packages, several of them extension points, and no routes anywhere. */
const reactish = (): RepositoryContext =>
  shaped({
    technologies: [technology('react', 'React', 'frontend'), technology('jest', 'Jest', 'testing')],
    packages: [
      { name: 'packages/react-reconciler', declarations: 4200 },
      { name: 'packages/react-dom', declarations: 3900 },
      { name: 'packages/react', declarations: 800 },
      { name: 'packages/scheduler', declarations: 400 },
      { name: 'packages/react-devtools-extension', declarations: 900 },
      { name: 'packages/react-refresh-plugin', declarations: 300 },
      { name: 'packages/eslint-plugin-react-hooks', declarations: 500 },
      { name: 'packages/react-server-dom-webpack-loader', declarations: 350 },
      { name: 'packages/shared', declarations: 600 },
    ],
    files: 3400,
    declarations: 24_000,
  });

/** A compiler: package names that are the stages of the pipeline. */
const compilerish = (): RepositoryContext =>
  shaped({
    packages: [
      { name: 'src/parser', declarations: 900 },
      { name: 'src/checker', declarations: 2400 },
      { name: 'src/emitter', declarations: 700 },
    ],
    files: 300,
    declarations: 4000,
  });

/** A deployment repository: infrastructure detections and no code at all. */
const infrastructural = (): RepositoryContext =>
  shaped({
    technologies: [technology('docker', 'Docker', 'infrastructure'), technology('kubernetes', 'Kubernetes', 'infrastructure')],
    regions: [{ ...region('', [], 40), depth: 'universal', primaryLanguage: null }],
    environmentVariables: ['DATABASE_URL'],
    files: 40,
    declarations: 0,
  });

/** A command-line tool, recognised from the argument parser its manifest declares. */
const commandLine = (): RepositoryContext =>
  shaped({
    technologies: [technology('vitest', 'Vitest', 'testing')],
    externalPackages: ['commander'],
    packages: [{ name: 'src/cli', declarations: 300 }],
    files: 60,
    declarations: 400,
  });

describe('what the repository is', () => {
  it('calls a routed repository with a frontend an application, and names the routes that say so', () => {
    const profile = deriveProfile(linkforge());

    expect(profile.type.value).toBe('application');
    expect(profile.type.evidence.join(' ')).toContain('3 routes');
    expect(profile.type.evidence.join(' ')).toContain('Next.js');
  });

  it('calls a routed repository with no frontend a service', () => {
    const withoutFrontend = shaped({
      technologies: [technology('express', 'Express', 'backend')],
      routes: [route('GET', '/health')],
    });

    expect(deriveProfile(withoutFrontend).type.value).toBe('service');
  });

  it('calls a package-organised repository with extension points a framework', () => {
    const profile = deriveProfile(reactish());

    expect(profile.type.value).toBe('framework');
    // The claim rests on the package names, and the fact carries them so a reader can check it.
    expect(profile.type.evidence.join(' ')).toContain('plugin');
  });

  it('calls a repository whose packages are compilation stages a compiler', () => {
    const profile = deriveProfile(compilerish());

    expect(profile.type.value).toBe('compiler');
    expect(profile.type.evidence.join(' ')).toContain('parsing');
    expect(profile.type.evidence.join(' ')).toContain('code generation');
  });

  it('refuses to call one stage a pipeline', () => {
    // A single `src/parser` in an ordinary repository is a directory, not a compiler.
    const one = shaped({ packages: [{ name: 'src/parser', declarations: 100 }] });

    expect(deriveProfile(one).type.value).not.toBe('compiler');
  });

  it('calls a repository with infrastructure and no declarations infrastructure', () => {
    const profile = deriveProfile(infrastructural());

    expect(profile.type.value).toBe('infrastructure');
    expect(profile.type.evidence.join(' ')).toContain('Kubernetes');
  });

  it('recognises a command-line tool from its argument parser and its command directory', () => {
    const profile = deriveProfile(commandLine());

    expect(profile.type.value).toBe('cli');
    expect(profile.type.evidence.join(' ')).toContain('commander');
    expect(profile.type.evidence.join(' ')).toContain('src/cli');
  });

  it('does not call a library a command-line tool for shipping one', () => {
    // Flask depends on `click` because it ships `flask run`, and its command code lives at
    // `src/flask/cli` — inside the library rather than at the top of the repository. An earlier rule
    // read the dependency alone and called the best-known Python web framework a CLI.
    const profile = deriveProfile(flaskish());

    expect(profile.type.value).not.toBe('cli');
    expect(profile.type.value).toBe('library');
  });

  it('calls a package-organised repository with extension points a framework even when it has routes', () => {
    // React carries five routes, from the little Express servers under `fixtures/flight/server` that
    // exercise Flight and SSR. With the route rule first, React was profiled as an Express
    // application and told to explain where a request enters.
    const withFixtureServers = shaped({
      technologies: [technology('react', 'React', 'frontend'), technology('express', 'Express', 'backend')],
      routes: [{ ...route('GET', '/todos'), node: node('route:GET:/todos', { fileId: null }) }],
      packages: [
        { name: 'packages/react-reconciler', declarations: 4200 },
        { name: 'packages/react-refresh-plugin', declarations: 300 },
        { name: 'packages/react-server-dom-webpack-loader', declarations: 350 },
      ],
      files: 7280,
    });

    expect(deriveProfile(withFixtureServers).type.value).toBe('framework');
  });

  it('reads a handful of routes among hundreds of test routes as machinery, not a surface', () => {
    // Path filtering took Flask from 134 routes to 13, Gin from 112 to 6 and FastAPI from 598 to 17,
    // and all three were still services on what remained — Gin's `routergroup.go`, where the method
    // that *registers* a route is defined. A framework providing routing always leaks a few.
    const residue = shaped({
      technologies: [technology('gin', 'Gin', 'backend')],
      routes: [
        { ...route('GET', '/ok'), node: node('route:GET:/ok', { fileId: 'file:routergroup.go' }) },
        ...Array.from({ length: 20 }, (_unused, index) => ({
          ...route('GET', `/t${index}`),
          node: node(`route:GET:/t${index}`, { fileId: `file:routes_test.go` }),
        })),
      ],
      packages: [{ name: 'src/gin', declarations: 900 }],
    });

    expect(deriveProfile(residue).type.value).not.toBe('service');
  });

  it('still calls a service a service when its end-to-end suite outnumbers its surface', () => {
    // The other side of the same threshold: three test routes for every real one is an ordinary,
    // well-tested service, and must not be read as a framework.
    const wellTested = shaped({
      technologies: [technology('express', 'Express', 'backend')],
      routes: [
        ...Array.from({ length: 5 }, (_unused, index) => ({
          ...route('GET', `/api/${index}`),
          node: node(`route:GET:/api/${index}`, { fileId: 'file:src/server.ts' }),
        })),
        ...Array.from({ length: 12 }, (_unused, index) => ({
          ...route('GET', `/api/${index}`),
          node: node(`route:GET:/e2e/${index}`, { fileId: 'file:tests/api.test.ts' }),
        })),
      ],
    });

    expect(deriveProfile(wellTested).type.value).toBe('service');
  });

  it('does not call a framework a service for the routes in its own tests', () => {
    // Flask's repository yields 134 real routes and Gin's 112, every one inside a test or an example.
    // Counting them made the two best-known micro-frameworks into web services, and the service
    // instruction then told the model to trace a request to persistence and not to describe a user
    // interface — both wrong about a framework.
    const demonstrated = shaped({
      technologies: [technology('flask', 'Flask', 'backend')],
      routes: [
        { ...route('GET', '/bar'), node: node('route:GET:/bar', { fileId: 'file:tests/test_basic.py' }) },
        { ...route('GET', '/json'), node: node('route:GET:/json', { fileId: 'file:examples/tutorial/app.py' }) },
      ],
      packages: [{ name: 'src/flask', declarations: 900 }],
    });

    expect(deriveProfile(demonstrated).type.value).not.toBe('service');
  });

  it('recognises a test by its filename where the language puts tests beside the code', () => {
    // Go's convention is `router_test.go` next to `router.go`, so Gin's test routes live in no
    // directory named for tests: 100 of its 112 routes survived a directory-only filter.
    const goish = shaped({
      technologies: [technology('gin', 'Gin', 'backend')],
      routes: [
        { ...route('GET', '/get'), node: node('route:GET:/get', { fileId: 'file:routes_test.go' }) },
        { ...route('GET', '/ok'), node: node('route:GET:/ok', { fileId: 'file:ginS/gin.go' }) },
      ],
    });
    const profile = deriveProfile(goish);

    expect(profile.type.evidence.join(' ')).toContain('exposes 1 route');
    expect(profile.type.evidence.join(' ')).toContain('1 further routes are declared only in tests');
  });

  it('does not treat a namespace word as a demonstration directory', () => {
    // Spring PetClinic lives under `org/springframework/samples/petclinic/` — `samples` is part of a
    // real application's Java package name, and discounting it reported PetClinic as exposing one
    // route out of fourteen.
    const spring = shaped({
      technologies: [technology('spring-boot', 'Spring Boot', 'backend')],
      routes: [
        {
          ...route('GET', '/owners/new'),
          node: node('route:GET:/owners/new', {
            fileId: 'file:src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java',
          }),
        },
      ],
    });

    expect(deriveProfile(spring).type.evidence.join(' ')).toContain('exposes 1 route');
  });

  it('cites surfaces drawn from the same routes it counted', () => {
    // "exposes 1 route under /owners (13)" contradicted itself inside eleven words, in the one field
    // whose whole job is to let a reader check the claim.
    const mixed = shaped({
      technologies: [technology('spring-boot', 'Spring Boot', 'backend')],
      routes: [
        { ...route('GET', '/owners/1'), node: node('route:GET:/owners/1', { fileId: 'file:src/main/Owner.java' }) },
        { ...route('GET', '/owners/2'), node: node('route:GET:/owners/2', { fileId: 'file:src/test/OwnerTests.java' }) },
        { ...route('GET', '/owners/3'), node: node('route:GET:/owners/3', { fileId: 'file:src/test/VetTests.java' }) },
      ],
    });
    const evidence = deriveProfile(mixed).type.evidence.join(' ');

    expect(evidence).toContain('exposes 1 route under /owners (1)');
  });

  it('still counts a route whose file it cannot name, because absence of evidence is not evidence', () => {
    const unnamed = shaped({
      technologies: [technology('express', 'Express', 'backend')],
      routes: [{ ...route('GET', '/health'), node: node('route:GET:/health', { fileId: null }) }],
    });

    expect(deriveProfile(unnamed).type.value).toBe('service');
  });

  it('says how many routes it discounted, where it discounted any', () => {
    const mixed = shaped({
      technologies: [technology('express', 'Express', 'backend')],
      routes: [
        { ...route('GET', '/health'), node: node('route:GET:/health', { fileId: 'file:src/server.ts' }) },
        { ...route('GET', '/demo'), node: node('route:GET:/demo', { fileId: 'file:examples/demo.ts' }) },
      ],
    });
    const profile = deriveProfile(mixed);

    expect(profile.type.value).toBe('service');
    expect(profile.type.evidence.join(' ')).toContain('1 further routes are declared only in tests or examples');
  });

  it('does not call a library tooling for having a test runner', () => {
    // Apache Commons Lang is a Java utility library that uses JUnit. An earlier rule asked for a test
    // technology and the absence of everything else, which is true of nearly every library alive.
    const utility = shaped({
      technologies: [technology('junit', 'JUnit', 'testing')],
      packages: [{ name: 'src/main/java/org/apache/commons/lang3', declarations: 4000 }],
      regions: [region('', ['maven'], 700)],
      files: 712,
    });

    expect(deriveProfile(utility).type.value).toBe('library');
  });

  it('needs two different stages to call something a pipeline, not two packages sharing a word', () => {
    // Plotly Dash ships `dash-generator-test-component-nested` and `-standard`. Both matched the same
    // stage, and a dashboard framework was profiled as a compiler on two test fixtures.
    const coincidence = shaped({
      packages: [
        { name: 'packages/dash-generator-test-component-nested', declarations: 40 },
        { name: 'packages/dash-generator-test-component-standard', declarations: 40 },
      ],
    });

    expect(deriveProfile(coincidence).type.value).not.toBe('compiler');
  });

  it('does not call a library a monorepo for packaging its examples', () => {
    // Flask ships `examples/tutorial/pyproject.toml` and `examples/celery/pyproject.toml`. Counting
    // every manifest region made Flask a monorepo, and its explanation would have opened with "what
    // the repository holds and how it is divided".
    const withPackagedExamples = shaped({
      technologies: [technology('flask', 'Flask', 'backend')],
      regions: [region('', ['pip'], 90), region('examples/tutorial', ['pip'], 20), region('examples/celery', ['pip'], 10)],
      packages: [{ name: 'src/flask', declarations: 900 }],
    });

    expect(deriveProfile(withPackagedExamples).type.value).toBe('library');
  });

  it('says unknown rather than guessing, when nothing supports a type', () => {
    // No technologies, no routes, no packages, no manifest region, no declarations to speak of.
    const bare = shaped({ regions: [region('', [], 4)], declarations: 0, files: 4 });
    const profile = deriveProfile(bare);

    expect(profile.type.value).toBe('unknown');
    expect(profile.type.evidence).toEqual([]);
  });

  it('never claims a technology the graph did not detect', () => {
    // The same discipline the architecture summary observes, asserted on the whole profile: nothing
    // reaches a rendered field that a detection did not put there.
    const rendered = JSON.stringify(deriveProfile(linkforge()));

    expect(rendered).not.toContain('PostgreSQL');
    expect(rendered).not.toContain('Kafka');
  });
});

describe('how large it is', () => {
  it('calls a repository small when everything nameable fits one projection', () => {
    const profile = deriveProfile(linkforge());

    expect(profile.scale.scale).toBe('small');
    expect(profile.scale.nameable).toBeLessThanOrEqual(NAMING_CAPACITY);
  });

  it('calls React large, and carries the numbers that put it there', () => {
    // Large rather than huge, and the distinction earns its keep: React gets the boundaries
    // instruction — start from the major subsystems, offer a drill-down — which is exactly right for
    // it. `huge` is reserved for a repository whose package *list* will not fit either, and instructs
    // an answer never to attempt the whole.
    const profile = deriveProfile(reactish());

    expect(profile.scale.scale).toBe('large');
    expect(profile.scale.files).toBe(3400);
    expect(profile.scale.packages).toBe(9);
  });

  it('takes the larger of the two measures, so a repository is never called small by its analysed part', () => {
    // Almost nothing nameable, but forty thousand files. A profile that read only the graph would call
    // this small and instruct an answer to explain it completely.
    const vast = shaped({ regions: [region('', [], 40_000)], declarations: 10 });

    expect(deriveProfile(vast).scale.scale).toBe('huge');
  });

  it('agrees with the caps the projection actually applies', () => {
    // `NAMING_CAPACITY` is the sum of the standard-tier caps for the parts that emit names. A cap that
    // changed in `projection.ts` and not here would silently redefine what "small" means, so the two
    // are asserted against each other rather than trusted to stay in step.
    expect(NAMING_CAPACITY).toBe(18 + 24 + 24 + 12);
  });
});

describe('what shape it is', () => {
  it('calls three role layers layered, and two not', () => {
    expect(deriveProfile(linkforge()).traits.map((claim) => claim.trait)).toContain('layered');

    const thin = shaped({
      routes: [route('GET', '/a')],
      layers: { Controller: ['aController'], Service: ['aService'] },
    });

    expect(deriveProfile(thin).traits.map((claim) => claim.trait)).not.toContain('layered');
  });

  it('reports several traits at once rather than picking one', () => {
    const traits = deriveProfile(reactish()).traits.map((claim) => claim.trait);

    expect(traits).toContain('multi-package');
    expect(traits).toContain('modular');
    expect(traits).toContain('plugin-oriented');
    expect(traits).toContain('frontend-heavy');
  });

  it('separates a full-stack repository from a frontend-only one', () => {
    expect(deriveProfile(linkforge()).traits.map((claim) => claim.trait)).toContain('full-stack');
    expect(deriveProfile(reactish()).traits.map((claim) => claim.trait)).not.toContain('full-stack');
  });

  it('carries evidence for every trait it claims', () => {
    for (const claim of deriveProfile(reactish()).traits) {
      expect(claim.evidence.length, claim.trait).toBeGreaterThan(0);
    }
  });
});

describe('what it is organised around', () => {
  it('claims a domain from the artefact that names it, and carries that artefact', () => {
    const domains = deriveProfile(linkforge()).domains;
    const named = domains.map((claim) => claim.domain);

    expect(named).toContain('authentication');
    expect(named).toContain('caching');
    expect(named).toContain('persistence');
    expect(named).toContain('analytics');

    const caching = domains.find((claim) => claim.domain === 'caching');

    expect(caching?.evidence.join(' ')).toContain('Redis');
  });

  it('does not claim a domain nothing names', () => {
    // Nothing in LinkForge names a queue, a broker or a scheduler, and a repository that plainly had
    // one would still not get the claim without the evidence.
    const named = deriveProfile(linkforge()).domains.map((claim) => claim.domain);

    expect(named).not.toContain('messaging');
    expect(named).not.toContain('scheduling');
  });

  it('ranks the domains by how much evidence named them', () => {
    const domains = deriveProfile(linkforge()).domains;
    const counts = domains.map((claim) => claim.evidence.length);

    expect([...counts].sort((left, right) => right - left)).toEqual(counts);
  });
});

describe('what a question may be narrowed to', () => {
  it('offers the technologies, domains, layers and units the repository actually contains', () => {
    const subsystems = subsystemsOf(deriveProfile(linkforge()));

    expect(subsystems.has('redis')).toBe(true);
    expect(subsystems.has('prisma')).toBe(true);
    expect(subsystems.has('caching')).toBe(true);
    expect(subsystems.has('prismaurlrepository')).toBe(true);
  });

  it('offers a package by the name a person would use for it, not only by its path', () => {
    const subsystems = subsystemsOf(deriveProfile(reactish()));

    // Nobody asks about `packages/react-reconciler`; they ask about the reconciler.
    expect(subsystems.has('packages/react-reconciler')).toBe(true);
    expect(subsystems.has('react-reconciler')).toBe(true);
    expect(subsystems.has('reconciler')).toBe(true);
  });

  it('offers nothing the repository does not contain', () => {
    expect(subsystemsOf(deriveProfile(reactish())).has('redis')).toBe(false);
  });

  it('does not offer a documentation directory as a subsystem', () => {
    // `docs/architecture` is a derived package like any other, and offering it made "Explain the
    // architecture" — the most repository-wide question there is — a question about a docs folder.
    const documented = shaped({
      packages: [
        { name: 'docs/architecture', declarations: 0 },
        { name: 'src/modules', declarations: 900 },
      ],
    });
    const subsystems = subsystemsOf(deriveProfile(documented));

    expect(subsystems.has('docs/architecture')).toBe(false);
    expect(subsystems.has('modules')).toBe(true);
  });
});

describe('the profile reaches the prompt, and is citable there', () => {
  it('leads the facts with what the repository is', () => {
    const facts = project(linkforge(), { tier: 'standard' }).facts;

    expect(facts[0]?.predicate).toBe('characterised-as');
    expect(facts[0]?.object).toContain('application');
  });

  it('marks a derived characterisation INFERRED, and a counted one not', () => {
    const facts = project(linkforge(), { tier: 'standard' }).facts.filter(
      (fact) => fact.predicate === 'characterised-as',
    );

    // That the repository exposes routes is measured; that this makes it an application is a rule.
    expect(facts[0]?.confidence).toBe('INFERRED');
    expect(facts.find((fact) => fact.object.startsWith('small'))?.confidence).toBe('CERTAIN');
  });

  it('says nothing about type when the evidence settled nothing', () => {
    const bare = shaped({ regions: [region('', [], 4)], declarations: 0, files: 4 });
    const facts = project(bare, { tier: 'standard' }).facts.filter((fact) => fact.predicate === 'characterised-as');

    expect(facts.some((fact) => fact.object.includes('unknown'))).toBe(false);
  });

  it('carries the profile on the projection, so the prompt and the facts cannot disagree', () => {
    const projection = project(reactish(), { tier: 'standard' });

    expect(projection.profile.type.value).toBe('framework');
    expect(projection.profile.scale.scale).toBe('large');
  });
});

describe('the projection is shaped by what the repository is', () => {
  it('leads a framework with its packages and a service with its routes', () => {
    const partOf = (context: RepositoryContext, predicate: string): number =>
      project(context, { tier: 'minimal' }).facts.findIndex((fact) => fact.predicate === predicate);

    const framework = project(reactish(), { tier: 'standard' });
    const service = project(linkforge(), { tier: 'standard' });

    // A framework's answer is made of units; a service's is made of what it exposes.
    expect(framework.facts.findIndex((fact) => fact.predicate === 'has-package')).toBeLessThan(
      framework.facts.findIndex((fact) => fact.predicate === 'hotspot') === -1
        ? Number.MAX_SAFE_INTEGER
        : framework.facts.findIndex((fact) => fact.predicate === 'hotspot'),
    );
    expect(service.facts.some((fact) => fact.predicate === 'exposes')).toBe(true);
    expect(partOf(linkforge(), 'characterised-as')).toBe(0);
  });

  it('keeps the identity facts ahead of whatever the repository type asked for', () => {
    // The steering must never displace what the previous milestone put first. A type rule that named
    // `request-flow` once lifted it above the profile itself, and the first thing a model read about a
    // web service was the flow rather than what the system was.
    const facts = project(linkforge(), { tier: 'standard' }).facts;

    expect(facts[0]?.predicate).toBe('characterised-as');
    expect(facts.findIndex((fact) => fact.predicate === 'runs-on')).toBeLessThan(
      facts.findIndex((fact) => fact.predicate === 'exposes'),
    );
  });
});
