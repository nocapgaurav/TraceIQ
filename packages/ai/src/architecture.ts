import type { RepositoryContext } from '@traceiq/context';

import {
  deriveStructure,
  isProductionPath,
  ownRoutes,
  roleOfPath,
  scopedTechnologies,
  type RegionRole,
  type RepositoryStructure,
} from './structure.js';

/**
 * What the repository *is*, derived from the graph before a single fact is rendered.
 *
 * **This exists because a correct answer was still a bad answer.** Asked to explain an architecture,
 * the model was given packages, counts, roles and technologies as a flat list of equals, and it
 * answered in kind: "src/modules contains 26 files", "there are 395 declarations", "there are 6
 * controllers". Every sentence was true and cited, and none of them said what the system was. A
 * projection that presents a role count and a file count at the same rank invites exactly that.
 *
 * So the shape of the system is composed here, first, and the counts follow it as evidence. The
 * discipline is unchanged and is the whole reason this can be trusted:
 *
 * - **Every field is a restatement of something the graph asserted.** A technology comes from the
 *   detection with its own evidence attached; a layer comes from role annotations; a route comes from
 *   the framework extractor. Nothing is concluded from the absence of something else.
 * - **A field that cannot be proven is absent, never guessed.** LinkForge declares
 *   `@prisma/adapter-pg` and no `pg`, so PostgreSQL is not detected and this summary does not mention
 *   PostgreSQL — even though a person reading the repository would know it is there. Being silent
 *   about a true thing is the cost of never asserting a false one.
 * - **Nothing here is a judgement about quality, suitability or intent.** It says what is present.
 */

export interface ArchitectureSummary {
  /** Technologies that render a user interface. */
  readonly frontend: readonly TechnologyRef[];
  /** Technologies that serve requests. */
  readonly backend: readonly TechnologyRef[];
  /** Technologies that store data durably. */
  readonly persistence: readonly TechnologyRef[];
  /** Technologies whose purpose is caching. See `CACHING_TECHNOLOGIES`. */
  readonly cache: readonly TechnologyRef[];
  /** How it is packaged and shipped. */
  readonly infrastructure: readonly TechnologyRef[];
  readonly testing: readonly TechnologyRef[];
  readonly build: readonly TechnologyRef[];
  /** The role layers the Framework Extractor annotated, with how many declarations carry each. */
  readonly layers: readonly Layer[];
  /**
   * The layers a request passes through, in conventional order, restricted to the ones present.
   *
   * The *order* is a convention rather than a measurement — TraceIQ records that a declaration is a
   * Controller and that another is a Repository, not that one calls the other on every request — and
   * the rendered fact says so. Only the membership is a graph fact.
   */
  readonly requestFlow: readonly string[];
  /** Route path groups, so an answer can name what the system exposes rather than count it. */
  readonly routeGroups: readonly RouteGroup[];
  /** Routes the repository's own code registers. What it exposes. */
  readonly routeCount: number;
  /**
   * Every route the extractor found, including the ones declared in tests, examples and fixtures.
   *
   * **Both counts are needed, and forgetting that broke the framework rule.** Scoping `routeCount` to
   * the repository's own routes made the proportion test in `profile.ts` compare a number with itself,
   * so Flask and Gin — whose entire route surface is test and example machinery — became web services
   * again. The existing profile tests caught it. The difference between the two numbers is also the
   * clearest evidence there is that a repository is a framework rather than a service, so it is carried
   * rather than recomputed.
   */
  readonly declaredRouteCount: number;
  /** Environment variables, which is where a database URL or a cache URL is named. */
  readonly configuration: readonly string[];
  /** Languages in size order, the honest opening of any identity sentence. */
  readonly languages: readonly { readonly language: string; readonly files: number }[];
  readonly packageCount: number;
  readonly fileCount: number;
  /** Domains the role annotations agree on. See `Capability`. */
  readonly capabilities: readonly Capability[];
  /**
   * Technologies found only in code that demonstrates, tests or measures the repository.
   *
   * **Kept rather than dropped, and kept apart rather than merged.** `stripe/ai` genuinely contains
   * Mongoose, PostgreSQL, SQLite, Next.js, Flask and Express — in six different benchmark fixtures, no
   * two of which run together. Discarding them would make the analysis silent about most of the files
   * in the repository; merging them into `persistence` and `backend` produced a stack that has never
   * existed. Each one is carried with the region it was found in and the role of that region, so an
   * answer can say what is true: that a benchmark fixture uses it.
   */
  readonly incidental: readonly IncidentalTechnology[];
  /** Where the repository's own code lives, and whether it is one unit or several. */
  readonly scope: ArchitectureScope;
  /**
   * The repository's test files, by path, and what each appears to exercise.
   *
   * **Not to be confused with `testing`, which is the test *technologies* — Jest, pytest.** This is the
   * files themselves, which is what a reader asking what to read first actually wants.
   *
   * **Added because "what tests should I read first?" was answered with an architecture overview.** The
   * only test evidence that ever reached a prompt was the count `N declarations carry the Test role` — no
   * names, no paths, nothing a reader could open. So the projection had nothing to offer the question,
   * the importance ranking answered it instead, and a reader asking which tests to read was handed the
   * repository's most-referenced declarations.
   *
   * The two attributions are kept apart because they rest on different evidence, exactly as a workflow's
   * steps are. `area` is the package the test file sits in, which is a path the graph recorded. `covers`
   * is what the test's *name* suggests it exercises, matched against declarations the repository
   * annotated — a convention, never an observed relationship, and rendered as one.
   */
  readonly testFiles: readonly TestRef[];
}

export interface TestRef {
  readonly name: string;
  /** The file the test is declared in, so a reader can open it. */
  readonly path: string;
  /** The package it sits in. A recorded path. */
  readonly area: string;
  /** Declarations whose names its filename matches. A naming convention, not an observed call. */
  readonly covers: readonly string[];
}

export interface IncidentalTechnology {
  readonly name: string;
  readonly category: string;
  readonly region: string;
  readonly role: RegionRole;
  readonly evidence: string;
}

export interface ArchitectureScope {
  /** Production region paths, largest first. `''` is the repository root. */
  readonly production: readonly string[];
  /** Whether the production code is one packaged unit or several independent ones. */
  readonly composition: 'single' | 'several' | 'unknown';
  /** What share of analysed source is production code. */
  readonly productionShare: number;
  /** How many regions were set aside, and as what. */
  readonly setAside: readonly { readonly role: RegionRole; readonly regions: number }[];
}

export interface TechnologyRef {
  readonly name: string;
  /** Where it was found; `''` is the repository root. */
  readonly region: string;
  /** The detection's own words, so a claim about it can be checked against the files it names. */
  readonly evidence: string;
}

export interface Layer {
  readonly role: string;
  readonly declarations: number;
  /**
   * The declarations that carry the role, by name.
   *
   * **Names explain a system; counts only support the explanation.** "14 repositories" tells a reader
   * nothing they can act on. `PrismaUrlRepository, PrismaAnalyticsRepository, UserRepository` tells
   * them what is persisted, that persistence is split by domain, and which file to open first — from
   * the same graph facts, at almost the same token cost.
   */
  readonly members: readonly string[];
}

/**
 * A domain the repository is organised around.
 *
 * **Derived, and derived narrowly.** A noun counts only when it appears in **two or more different
 * role layers** — a `urlController` and a `urlService` and a `PrismaUrlRepository` are three
 * independent annotations agreeing that "url" is a thing this system is built around, and that
 * agreement is the evidence. A noun appearing once is a file name, not a capability, and is dropped.
 *
 * This is the closest the graph gets to what a repository is *for*, and it is still not a claim about
 * purpose: it says which nouns the code is organised around, and leaves the reader to conclude that a
 * system organised around `url` with a redirect route is a URL shortener.
 */
export interface Capability {
  readonly noun: string;
  /** Which role layers contain it — the agreement that makes it a capability rather than a name. */
  readonly layers: readonly string[];
  /** The declarations that named it, so the claim is checkable. */
  readonly members: readonly string[];
}

export interface RouteGroup {
  /** The first path segment, or the literal path for a root route. */
  readonly prefix: string;
  readonly methods: readonly string[];
  readonly count: number;
  /** One real path from the group, so the group is checkable rather than a category. */
  readonly example: string;
}

/**
 * Data technologies whose purpose is caching rather than storage.
 *
 * **A property of the technology, not a conclusion about the repository.** The detection layer already
 * classifies Redis as `data`; that it is a *cache* is the same kind of general knowledge as the rule
 * that `ioredis` means Redis, and it is what lets a summary distinguish "where state lives" from
 * "what makes reads fast" — the distinction a reader is actually asking about.
 *
 * Declared here rather than imported because this package may import `@traceiq/context` and nothing
 * else, type-only; the same trade `NON_DEPENDENCY_EXTERNAL_KINDS` makes, and stated for the same
 * reason. It is small and slow-moving. Anything not listed stays under persistence, which is the safe
 * direction: describing a cache as storage understates it, while describing storage as a cache would
 * be wrong about where the data is.
 */
export const CACHING_TECHNOLOGIES: ReadonlySet<string> = new Set(['redis', 'memcached', 'valkey']);

/** The order a request conventionally traverses. Only layers that exist are ever emitted. */
const FLOW_ORDER: readonly string[] = ['Middleware', 'Controller', 'Service', 'Repository'];

/**
 * What a technology in each category is *for*.
 *
 * **A responsibility, not a name — and a property of the category, not of this repository.** Saying
 * "Redis accelerates repeated URL lookups" would be a claim about how this system uses Redis, which
 * the graph does not record. Saying a cache "keeps hot data in memory so repeated reads avoid the
 * database" is what a cache is, true wherever one appears, and it is the clause that turns a list of
 * names into an explanation the reader can reason from.
 *
 * The categories are the detection layer's own; only the gloss is added here.
 */
const CATEGORY_RESPONSIBILITY: Readonly<Record<string, string>> = {
  frontend: 'renders the user interface',
  backend: 'serves HTTP requests',
  persistence: 'stores data durably and is how the code reaches the database',
  cache: 'keeps hot data in memory so repeated reads avoid the database',
  infrastructure: 'builds, ships and runs the service',
  testing: 'runs the test suite',
  build: 'installs dependencies and builds the code',
};

export function responsibilityOf(label: string): string {
  return CATEGORY_RESPONSIBILITY[label] ?? '';
}

/**
 * Role-name noise that says which layer a declaration is in rather than which domain it serves.
 *
 * `PrismaUrlRepository` is the `url` domain implemented over Prisma; `createAuthController` is the
 * `auth` domain behind a factory. Stripping the layer word and the construction verb leaves the noun
 * that three different annotations can then agree on.
 */
const ROLE_NOISE = /^(create|make|build|default|new)|(controller|service|repository|repo|middleware|model|handler|factory|provider)s?$/gi;

const IMPLEMENTATION_PREFIX = /^(prisma|redis|memory|inmemory|sql|http|default)/i;

export function summariseArchitecture(context: RepositoryContext): ArchitectureSummary {
  const structure = deriveStructure(context);
  const scoped = scopedTechnologies(context, structure);

  /*
   * Categories are drawn from the repository's **own** technologies only.
   *
   * This one substitution is what dissolves the fact soup. Before it, every category was a union across
   * the whole tree, so a repository holding six sample applications reported their six stacks as one —
   * a persistence layer of Mongoose, SQLite, Drizzle and PostgreSQL that no process has ever loaded
   * together. A technology found in a benchmark is still recorded; it is recorded as a benchmark's. See
   * `incidental`.
   */
  const byCategory = (category: string): TechnologyRef[] =>
    dedupe(
      scoped.repositoryWide
        .filter((technology) => technology.category === category)
        .map((technology) => ({
          name: technology.name,
          region: technology.regionPath,
          evidence: technology.evidence,
        })),
    );

  const data = byCategory('data');
  const isCache = (entry: TechnologyRef): boolean => CACHING_TECHNOLOGIES.has(entry.name.toLowerCase());

  const architecture = context.primary.type === 'repository' ? context.primary.value.architecture : null;
  const overview = context.primary.type === 'repository' ? context.primary.value.overview : null;

  const layers: Layer[] = [];

  if (architecture !== null) {
    for (const [role, listing] of [
      ['Controller', architecture.controllers],
      ['Service', architecture.services],
      ['Repository', architecture.repositories],
      ['Middleware', architecture.middleware],
      ['Model', architecture.models],
    ] as const) {
      /*
       * Role-annotated declarations, restricted to the repository's own code.
       *
       * **The last unscoped source, and the one that kept the fictional domains alive.** After the
       * technologies, the routes and the configuration were all scoped, `stripe/ai` still reported that
       * it was organised around rendering, persistence, networking, routing and authentication — because
       * its `Model` layer is `Salon`, `SalonSchema` and `SalonEmailValid`, and its interfaces are
       * `SettingsProvider` and `BadgeProps`, every one of them inside a sample pet-grooming application
       * under `benchmarks/furever`. `capabilitiesOf` derives the repository's domains from these names,
       * so a fixture's vocabulary became the repository's subject matter.
       *
       * The path is on the declaration, either as its file or inside its identifier.
       */
      const kept = listing.entries.filter((entry) => {
        const fileId = (entry as { readonly fileId?: unknown }).fileId;

        if (typeof fileId === 'string') {
          return isProductionPath(fileId);
        }

        const id = (entry as { readonly id?: unknown }).id;

        return typeof id !== 'string' || isProductionPath(id.slice(id.indexOf(':') + 1).split('#')[0] ?? '');
      });

      if (kept.length > 0) {
        layers.push({
          role,
          /*
           * The kept count, not the graph's total, wherever anything was set aside.
           *
           * "Controller: a, b (14 in total)" where twelve of the fourteen are a fixture's is a fact that
           * misleads by arithmetic. Where nothing was set aside the graph's own total is used, because a
           * capped listing means the total is larger than the entries and the graph is the authority on
           * how much larger.
           */
          declarations: kept.length === listing.entries.length ? listing.total : kept.length,
          // Deduplicated: a factory and the thing it builds often share a name, and naming it twice
          // reads as two components where the graph recorded one domain.
          members: [...new Set(kept.map((entry) => entry.name))].slice(0, 8),
        });
      }
    }
  }

  const present = new Set(layers.map((layer) => layer.role));

  return {
    frontend: byCategory('frontend'),
    backend: byCategory('backend'),
    persistence: data.filter((entry) => !isCache(entry)),
    cache: data.filter(isCache),
    infrastructure: byCategory('infrastructure'),
    testing: byCategory('testing'),
    build: byCategory('build'),
    layers,
    requestFlow: FLOW_ORDER.filter((role) => present.has(role)),
    /*
     * Only routes the repository itself registers.
     *
     * A route declared inside a benchmark fixture or an example is a route the repository *shows how to
     * write*, and `stripe/ai` had three of them — `POST /create-checkout-session`, `POST /pay`,
     * `GET /customer/:email/bookings` — reported as the surface of a repository that serves nothing.
     * `profile.ts` already discounted these when deciding repository *type*; it had no way to stop them
     * reaching the identity's entry points, the workflows or this summary.
     */
    routeGroups: groupRoutes(ownRoutes(context)),
    routeCount: ownRoutes(context).length,
    declaredRouteCount: architecture?.routes.total ?? context.routes.length,
    /*
     * Configuration the repository's own code reads.
     *
     * `stripe/ai` reads `STRIPE_SECRET_KEY`, `NEXTAUTH_URL` and five `EXAMPLE_DEMO_*` variables — all of
     * them inside benchmark fixtures, none of them configuration the repository requires to run. The
     * identity's `security` field is built from the secret-shaped names here, so an unscoped list made a
     * repository that ships no service look like one guarding a payment surface.
     *
     * Scoped by the file that reads the variable, where the graph recorded one. A variable with no file
     * is kept, on the same principle the routes use: absence of evidence is not evidence.
     */
    configuration: context.dependencies.environmentVariables
      .filter((node) => {
        const fileId = (node as { readonly fileId?: unknown }).fileId;

        return typeof fileId !== 'string' || isProductionPath(fileId);
      })
      .map((node) => node.name)
      .filter((name): name is string => typeof name === 'string' && name !== '')
      .sort(),
    languages: [...context.capabilities.languages].sort(
      (left, right) => right.files - left.files || left.language.localeCompare(right.language),
    ),
    packageCount: overview?.packages.total ?? 0,
    fileCount: overview?.repository.files ?? 0,
    capabilities: capabilitiesOf(layers),
    testFiles: testsOf(architecture, layers, structure),
    incidental: scoped.incidental.map((technology) => ({
      name: technology.name,
      category: technology.category,
      region: technology.regionPath,
      role: technology.role,
      evidence: technology.evidence,
    })),
    scope: {
      production: structure.production
        .map((region) => region.path)
        .sort((left, right) => left.length - right.length || left.localeCompare(right)),
      composition: structure.composition,
      productionShare: structure.productionShare,
      setAside: [...new Set(structure.incidental.map((region) => region.role))]
        .map((role) => ({ role, regions: structure.incidental.filter((region) => region.role === role).length }))
        .sort((left, right) => right.regions - left.regions || left.role.localeCompare(right.role)),
    },
  };
}

/**
 * The domain nouns two or more role layers agree on.
 *
 * The agreement is the whole safeguard. One `urlService` proves a file exists; a `urlController`, a
 * `urlService` and a `PrismaUrlRepository` are three independent annotations converging on a domain,
 * and that convergence is a graph fact rather than a guess about intent.
 */
function capabilitiesOf(layers: readonly Layer[]): readonly Capability[] {
  const found = new Map<string, { layers: Set<string>; members: Set<string> }>();

  for (const layer of layers) {
    for (const member of layer.members) {
      const noun = domainNoun(member);

      if (noun === null) {
        continue;
      }

      const held = found.get(noun) ?? { layers: new Set<string>(), members: new Set<string>() };

      held.layers.add(layer.role);
      held.members.add(member);
      found.set(noun, held);
    }
  }

  return [...found.entries()]
    .filter(([, held]) => held.layers.size >= 2)
    .map(([noun, held]) => ({ noun, layers: [...held.layers].sort(), members: [...held.members].sort() }))
    .sort((left, right) => right.layers.length - left.layers.length || left.noun.localeCompare(right.noun));
}

/** The domain a role-annotated name is about, or `null` when nothing is left after the role words. */
function domainNoun(name: string): string | null {
  ROLE_NOISE.lastIndex = 0;

  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .filter((word) => word !== '');

  const kept = words.filter(
    (word) =>
      !/^(create|make|build|default|new|the|a)$/.test(word) &&
      !/^(controller|service|repository|repo|middleware|model|handler|factory|provider)s?$/.test(word) &&
      !IMPLEMENTATION_PREFIX.test(word),
  );

  const noun = kept.join(' ').trim();

  // A single letter or a bare number is not a domain.
  return noun.length < 3 ? null : noun;
}

/**
 * Routes gathered by their first path segment.
 *
 * **A restatement, not a classification.** Grouping `GET /:shortCode` and `GET /:shortCode/analytics`
 * under one prefix says the paths share a segment, which is a fact about the strings the framework
 * extractor recorded. It stops short of saying the repository "does URL shortening" — that is a
 * conclusion for a reader to draw from a real path, and the group carries a real path so they can.
 */
function groupRoutes(routes: RepositoryContext['routes']): readonly RouteGroup[] {
  const groups = new Map<string, { methods: Set<string>; count: number; example: string }>();

  for (const route of routes) {
    const path = route.composition.effectivePath;
    const segment = path.split('/').filter((part) => part !== '')[0];
    const prefix = segment === undefined ? '/' : `/${segment}`;
    const held = groups.get(prefix);

    if (held === undefined) {
      groups.set(prefix, { methods: new Set([route.method]), count: 1, example: `${route.method} ${path}` });
    } else {
      held.methods.add(route.method);
      held.count += 1;
    }
  }

  return [...groups.entries()]
    .map(([prefix, held]) => ({
      prefix,
      methods: [...held.methods].sort(),
      count: held.count,
      example: held.example,
    }))
    .sort((left, right) => right.count - left.count || left.prefix.localeCompare(right.prefix));
}

/** One entry per technology name; a technology found in three regions is one technology. */
function dedupe(entries: readonly TechnologyRef[]): TechnologyRef[] {
  const byName = new Map<string, TechnologyRef>();

  for (const entry of entries) {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, entry);
    }
  }

  return [...byName.values()];
}

/**
 * What the repository's tests are, and what each one appears to exercise.
 *
 * **Only the repository's own tests**, which is not the tautology it sounds like: a repository holding
 * sample applications holds their tests too, and a reader asking what to read first does not mean a
 * fixture's suite.
 *
 * The name matching is deliberately crude and deliberately conservative. Every ecosystem spells the same
 * convention differently — `meter.test.ts`, `test_meter.py`, `meter_test.go`, `MeterTests.java` — and
 * stripping the affix leaves the thing the test is named after. A match against an annotated declaration
 * is then a *naming* agreement between two things the graph recorded separately, which is the same
 * standard `Capability` holds nouns to. Where nothing matches, `covers` is empty, and the honest answer
 * to "what does this test cover" is that the analysis cannot say.
 */
function testsOf(
  architecture: { readonly tests?: { readonly entries: readonly { readonly id: string; readonly name: string; readonly fileId?: unknown }[] } } | null,
  layers: readonly Layer[],
  structure: RepositoryStructure,
): readonly TestRef[] {
  const entries = architecture?.tests?.entries ?? [];

  if (entries.length === 0) {
    return [];
  }

  const declarations = layers.flatMap((layer) => layer.members);
  const areas = [...structure.regions].sort((left, right) => right.path.length - left.path.length);

  const refs: TestRef[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const body = entry.id.slice(entry.id.indexOf(':') + 1);
    const path = typeof entry.fileId === 'string' ? entry.fileId.replace(/^file:/, '') : (body.split('#')[0] ?? '');

    if (path === '' || seen.has(path)) {
      continue;
    }

    /*
     * A test *inside* a demonstration is that demonstration's.
     *
     * Note the asymmetry with everything else in this file: a test is not production code, so it cannot
     * be filtered by `isProductionPath` — that would remove every test there is. What is filtered is a
     * test that sits inside an example or a benchmark, which is a different question about the same path.
     */
    if (roleOfPath(path) !== 'test' && !isProductionPath(path)) {
      continue;
    }

    seen.add(path);

    const subject = subjectOfTestPath(path);
    const covers =
      subject === null
        ? []
        : declarations.filter((name) => {
            const left = name.toLowerCase();
            const right = subject.toLowerCase();

            return left.includes(right) || right.includes(left);
          });

    refs.push({
      name: entry.name === '' ? (path.split('/').at(-1) ?? path) : entry.name,
      path,
      area: areas.find((region) => region.path !== '' && path.startsWith(`${region.path}/`))?.path ?? '',
      covers: [...new Set(covers)].slice(0, 4),
    });
  }

  /*
   * Tests whose subject the analysis could identify come first.
   *
   * **Otherwise the cap decides, and the cap is alphabetical by accident.** LinkForge's first eight tests
   * by listing order are all React page tests whose filenames — `page.test.tsx` — match no declaration, so
   * a reader asking what to read first was handed eight entries each saying "the analysis cannot say what
   * it exercises", while the service tests that do map were cut by the cap. Ordering by whether the
   * mapping resolved puts the useful evidence inside the budget.
   */
  return [...refs].sort(
    (left, right) => right.covers.length - left.covers.length || left.path.localeCompare(right.path),
  );
}

/**
 * What a test file's name says it is about, with the ecosystem's test affix removed.
 *
 * Returns `null` where removing the affixes leaves nothing, which is the honest outcome for a file called
 * `test_utils.py` or `spec_helper.rb`: it is a test of the tests, and it exercises nothing a reader asked
 * about.
 */
function subjectOfTestPath(path: string): string | null {
  const base = (path.split('/').at(-1) ?? '').replace(/\.[a-z0-9]+$/i, '');

  const stripped = base
    .replace(/\.(test|spec|integration|e2e)$/i, '')
    .replace(/^(test|spec)[_-]/i, '')
    .replace(/[_-](test|spec|tests|specs)$/i, '')
    .replace(/(Tests?|Specs?|IT)$/, '');

  const cleaned = stripped.trim();

  return cleaned === '' || /^(utils?|helpers?|common|base|setup|conftest|index|main|mod)$/i.test(cleaned) ? null : cleaned;
}
