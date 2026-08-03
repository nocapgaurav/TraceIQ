import type { RepositoryContext } from '@traceiq/context';

import { CACHING_TECHNOLOGIES, summariseArchitecture, type ArchitectureSummary } from './architecture.js';
import { deriveStructure, isProductionPath, ownRoutes } from './structure.js';

/**
 * What *kind of thing* the repository is, derived from the graph before anything is explained.
 *
 * **This exists because a grounded answer was still the wrong answer.** The layer below this one
 * (`architecture.ts`) fixed a projection that presented a role count and a file count as equals, so an
 * answer now opens with the shape of the system rather than with a number. What it did not fix is that
 * *every repository receives the same shape of answer*. A 500-file Express application, React, and a
 * Terraform module are handed the same instruction — open with what the system is, then explain how the
 * parts relate — and for two of those three that instruction is wrong. React has no request flow to
 * trace. A Terraform module has no layers. Explaining Kubernetes "end to end" is not an explanation.
 *
 * A profile is what lets the instruction differ. It is deliberately **not** an analysis: every field
 * restates counts, names and detections the graph already recorded, and the same three rules that govern
 * `ArchitectureSummary` govern this:
 *
 * - **Every field is a restatement.** A type comes from routes, manifests, role annotations and
 *   dependency names that the graph holds; a scale comes from file and package counts; a domain comes
 *   from a route path, an environment variable or a role-annotated declaration. Nothing is concluded
 *   from the absence of something else.
 * - **A dimension that cannot be proven is absent, never guessed.** `type` has an `unknown` member and
 *   it is used. A repository whose evidence supports no rule gets `unknown`, and the strategy layer
 *   falls back to scale and domains — both of which are always measurable. Guessing "library" because
 *   nothing else matched would put a fabrication upstream of every sentence in the answer.
 * - **Nothing here is a judgement about quality, suitability or intent.** It says what is present.
 *
 * The profile is also **cheap and total**: it reads only kind-independent parts of the context plus the
 * repository overview where one exists, so a question about a single declaration in a huge repository
 * still knows it is in a huge repository.
 */

export const REPOSITORY_TYPES = [
  'application',
  'service',
  'framework',
  'library',
  'sdk',
  'cli',
  'infrastructure',
  'compiler',
  'monorepo',
  'tooling',
  'unknown',
] as const;

export type RepositoryType = (typeof REPOSITORY_TYPES)[number];

/**
 * How much of the repository an explanation can hold at once.
 *
 * **Measured against what a projection can actually name, not against a file count someone chose.**
 * The distinction the mission draws — explain a small repository completely, never explain a huge one
 * at once — is really a statement about capacity: a repository is "small" when every package, every
 * role-bearing declaration and every route group *fits in the facts a model is given*, and "huge" when
 * not even the list of its packages fits. That is a property this system measures rather than asserts,
 * so it is what the bands are computed from. See `scaleOf`.
 */
export const REPOSITORY_SCALES = ['small', 'medium', 'large', 'huge'] as const;

export type RepositoryScale = (typeof REPOSITORY_SCALES)[number];

/**
 * Structural traits, held as a set rather than as one label.
 *
 * A repository is routinely several of these at once — React is `multi-package` and `modular` and
 * `frontend-heavy` — and forcing one to win would throw away the two that were also true. Each trait is
 * emitted only with its own evidence, and a repository that supports none gets an empty set, which the
 * strategy layer reads as "say nothing about structure".
 */
export const COMPLEXITY_TRAITS = [
  'simple',
  'layered',
  'modular',
  'plugin-oriented',
  'multi-package',
  'multi-service',
  'compiler-pipeline',
  'frontend-heavy',
  'backend-heavy',
  'full-stack',
  'cyclic',
] as const;

export type ComplexityTrait = (typeof COMPLEXITY_TRAITS)[number];

/**
 * Architectural domains, in the vocabulary the mission names.
 *
 * Each is a *responsibility a reader would ask about*, and each is claimed only from evidence that
 * names it: a route path, an environment variable, a detected technology, or a role-annotated
 * declaration. `messaging` and `scheduling` appear here and will frequently be absent — the detection
 * layer has no rule for a message broker, so a repository that plainly uses Kafka will not have
 * `messaging` claimed unless a dependency or an environment variable names it. Being silent about a
 * true thing is the cost of never asserting a false one.
 */
export const DOMAINS = [
  'authentication',
  'authorisation',
  'analytics',
  'rendering',
  'routing',
  'persistence',
  'caching',
  'messaging',
  'scheduling',
  'workers',
  'storage',
  'networking',
  'configuration',
  'testing',
  'build',
  'deployment',
] as const;

export type Domain = (typeof DOMAINS)[number];

/** A claimed dimension and the graph facts that claimed it. */
export interface Evidenced<T> {
  readonly value: T;
  /** What the graph held, in the graph's own words. Empty only where the value is a bare count. */
  readonly evidence: readonly string[];
}

export interface DomainClaim {
  readonly domain: Domain;
  readonly evidence: readonly string[];
}

export interface TraitClaim {
  readonly trait: ComplexityTrait;
  readonly evidence: readonly string[];
}

/**
 * How large the repository is, and what the answer is measured against.
 *
 * Every number here is carried so a reader can check the band rather than trust it, and so a regression
 * in the band boundaries is visible as a changed number rather than as a changed adjective.
 */
export interface ScaleMeasure {
  readonly scale: RepositoryScale;
  readonly files: number;
  readonly declarations: number;
  readonly packages: number;
  /**
   * Distinct things a projection could name — packages, role-bearing declarations, route groups and
   * detected technologies. `null` when the context carries no repository overview, in which case the
   * band comes from `files` alone.
   */
  readonly nameable: number | null;
  /** What a standard-tier projection can name. See `NAMING_CAPACITY`. */
  readonly capacity: number;
}

export interface RepositoryProfile {
  readonly type: Evidenced<RepositoryType>;
  readonly scale: ScaleMeasure;
  readonly traits: readonly TraitClaim[];
  /** Technology categories present, each with the technologies that put it there. */
  readonly stack: readonly Evidenced<string>[];
  readonly domains: readonly DomainClaim[];
  /**
   * The derived packages, largest first — what "the major subsystems" means for a repository that has
   * them. Empty for a context carrying no overview, and for a repository that is one package.
   */
  readonly units: readonly string[];
  /** The architecture summary this was derived from, so a consumer needs only one derivation. */
  readonly architecture: ArchitectureSummary;
  /** Languages in size order, for an identity sentence that opens honestly. */
  readonly languages: readonly { readonly language: string; readonly files: number }[];
  /** How deeply the repository was read. A `universal` profile is a profile of manifests, not of code. */
  readonly depth: string;
  readonly isPolyglot: boolean;
}

/**
 * What a standard-tier projection can name.
 *
 * The sum of the standard-tier caps for the repository-level extractors that emit *names* —
 * `PACKAGES` 18, `ARCHITECTURE` 24, `TECHNOLOGIES` 24 and `REGIONS` 12 in `projection.ts`. A test
 * asserts the two agree, because a cap that changed here and not there would silently redefine what
 * "small" means.
 *
 * It is the standard tier rather than the largest deliberately: the band should describe the repository
 * as most users will actually see it explained, not as the best case a 128k window would allow.
 */
export const NAMING_CAPACITY = 78;

/** How many capacities each band spans. A repository is small when everything nameable fits once. */
const MEDIUM_MULTIPLE = 4;
const LARGE_MULTIPLE = 16;

/**
 * File-count bands, used when no overview is available and as a floor when one is.
 *
 * **Stated plainly as a judgement, because they are one.** The nameable measure above is graph-driven
 * and is what the bands mean; these exist so a symbol-kind context — which carries no overview — still
 * knows whether it is inside React or inside a weekend project, and so a repository of 40,000 mostly
 * unanalysed files is never called "small" because its analysed part was.
 */
const FILE_BANDS: readonly (readonly [RepositoryScale, number])[] = [
  ['small', 250],
  ['medium', 2000],
  ['large', 10_000],
];

const SCALE_ORDER: readonly RepositoryScale[] = ['small', 'medium', 'large', 'huge'];

/**
 * Dependency names that mean a repository is driven from a command line.
 *
 * Declared here for the same reason and on the same terms as `CACHING_TECHNOLOGIES`: this package may
 * import `@traceiq/context` and nothing else, type-only. It is a small, slow-moving set, every entry is
 * an argument parser rather than a heuristic, and a repository that declares one has stated its intent
 * in a manifest — which is evidence, not inference. Anything unlisted simply does not claim `cli`.
 */
const CLI_DEPENDENCIES: ReadonlySet<string> = new Set([
  'commander',
  'yargs',
  'minimist',
  'cac',
  'oclif',
  '@oclif/core',
  'clipanion',
  'meow',
  'inquirer',
  'prompts',
  'click',
  'typer',
  'argparse',
  'docopt',
  'github.com/spf13/cobra',
  'github.com/urfave/cli',
  'github.com/spf13/pflag',
  'clap',
  'structopt',
  'picocli',
  'thor',
]);

/**
 * Package-name stems that name a stage of a compilation pipeline.
 *
 * A compiler is the one repository type whose *shape* is legible from package names alone, because the
 * stages are named after what they are almost universally — a `parser`, a `codegen`, a `traverse`. Two
 * or more distinct stages are required, so a single `src/parser` in a web service claims nothing.
 */
const PIPELINE_STAGES: Readonly<Record<string, string>> = {
  lexer: 'lexing',
  tokenizer: 'lexing',
  tokeniser: 'lexing',
  parser: 'parsing',
  ast: 'syntax tree',
  binder: 'binding',
  checker: 'type checking',
  typecheck: 'type checking',
  transformer: 'transformation',
  traverse: 'transformation',
  optimizer: 'optimisation',
  optimiser: 'optimisation',
  codegen: 'code generation',
  emitter: 'code generation',
  compiler: 'compilation',
  interpreter: 'interpretation',
  // `scanner`, `generator`, `runtime`, `parse`, `emit`, `transform`, `lower`, `syntax` and `vm` were
  // here and are deliberately gone: each is ordinary vocabulary somewhere else. A `scanner` is a
  // security tool, a `generator` is any code generator, and `runtime` appears in most JavaScript
  // repositories that have nothing to do with compilation.
};

/**
 * Package-name stems that mean a repository is built to be extended by someone else's code.
 *
 * **Deliberately narrow, and narrowed twice by measurement.** The first list included `middleware`,
 * `provider`, `driver`, `transform` and `integration`, and on LinkForge — an ordinary URL shortener —
 * it matched `tests/integration` and a dated markdown file in `docs/`, so the prompt instructed the
 * model to explain a web application's *extension points*. Every one of those words is ordinary
 * vocabulary in an application: middleware is a role layer, a provider is a React context, an
 * integration test is a test. What survives is the set of words a repository only uses when it means
 * "someone else's code plugs in here".
 *
 * The other half of that fix is in `traitsOf`, which now matches against packages carrying
 * declarations — so a documentation directory cannot be an extension point whatever it is named.
 */
const EXTENSION_STEMS: readonly string[] = [
  'plugin',
  'plugins',
  'preset',
  'presets',
  'adapter',
  'adapters',
  'loader',
  'loaders',
  'extension',
  'extensions',
];

/**
 * Words in an environment variable, a route path or a declaration name that name a domain.
 *
 * Every entry is a word a *repository author wrote*, so a match is a restatement of something the graph
 * recorded rather than a category this file invented. Ordered so a more specific domain is checked
 * before a broader one — `session` is authentication before it is storage.
 */
const DOMAIN_WORDS: readonly (readonly [Domain, readonly string[]])[] = [
  ['authentication', ['auth', 'authentication', 'login', 'logout', 'signin', 'signup', 'session', 'jwt', 'oauth', 'token', 'password', 'credential', 'identity', 'sso', 'saml']],
  ['authorisation', ['authorisation', 'authorization', 'permission', 'permissions', 'role', 'roles', 'rbac', 'policy', 'policies', 'scope', 'scopes', 'guard', 'acl']],
  ['analytics', ['analytics', 'metric', 'metrics', 'telemetry', 'tracking', 'event', 'events', 'stat', 'stats', 'statistics', 'report', 'reporting', 'dashboard']],
  ['rendering', ['render', 'renderer', 'rendering', 'view', 'views', 'template', 'templates', 'component', 'components', 'layout', 'ui', 'page', 'pages', 'dom']],
  ['routing', ['route', 'router', 'routes', 'routing', 'endpoint', 'endpoints', 'controller', 'handler', 'dispatch', 'url', 'path']],
  ['persistence', ['db', 'database', 'repository', 'repositories', 'model', 'models', 'entity', 'entities', 'schema', 'migration', 'migrations', 'orm', 'dao', 'persistence', 'sql']],
  ['caching', ['cache', 'caching', 'redis', 'memcached', 'ttl', 'invalidate', 'invalidation', 'eviction']],
  ['messaging', ['queue', 'queues', 'broker', 'kafka', 'rabbitmq', 'amqp', 'nats', 'pubsub', 'topic', 'consumer', 'producer', 'sqs', 'sns', 'message', 'messaging']],
  ['scheduling', ['schedule', 'scheduler', 'scheduling', 'cron', 'timer', 'interval', 'periodic', 'tick']],
  ['workers', ['worker', 'workers', 'job', 'jobs', 'task', 'tasks', 'background', 'celery', 'thread', 'pool', 'concurrency']],
  ['storage', ['storage', 'bucket', 'blob', 's3', 'upload', 'uploads', 'file', 'files', 'asset', 'assets', 'media']],
  ['networking', ['http', 'https', 'client', 'request', 'requests', 'socket', 'websocket', 'grpc', 'rpc', 'api', 'fetch', 'proxy', 'network', 'port', 'host']],
  ['configuration', ['config', 'configuration', 'settings', 'env', 'environment', 'option', 'options', 'flag', 'flags']],
];

/** Technology categories that put a domain beyond doubt, because the detection already named one. */
const CATEGORY_DOMAIN: Readonly<Record<string, Domain>> = {
  frontend: 'rendering',
  testing: 'testing',
  build: 'build',
  infrastructure: 'deployment',
};

export function deriveProfile(context: RepositoryContext): RepositoryProfile {
  const architecture = summariseArchitecture(context);
  const overview = context.primary.type === 'repository' ? context.primary.value.overview : null;
  const packages = overview === null ? [] : overview.packages.entries;

  /*
   * Only the units that carry code.
   *
   * A package is derived from a path, so `docs/`, `tests/fixtures/` and a directory holding one
   * markdown file are all packages. Every rule below that reads a *name* — the extension points, the
   * compiler stages, the command directory — is asking what the code is organised into, and a
   * documentation directory answering that question is how LinkForge came to be described as having
   * extension points because it contains `tests/integration`. `declarations > 0` is the graph's own
   * statement that there is code here.
   */
  const packageNames = packages.filter((entry) => entry.declarations > 0).map((entry) => entry.name);
  const dependencies = declaredDependencies(context);
  const regions = context.capabilities.regions;

  const scale = scaleOf(context, architecture, overview);
  const traits = traitsOf(context, architecture, scale, packageNames, regions);
  const type = typeOf(context, architecture, scale, packageNames, dependencies, regions, traits);

  return {
    type,
    scale,
    traits,
    stack: stackOf(architecture),
    domains: domainsOf(context, architecture),
    /*
     * Largest first by declarations, the number the Explorer already computed — so "the major units"
     * means the ones carrying the most code rather than the ones sorting first alphabetically.
     *
     * Source-bearing only, and that filter is a bug fix. A package is derived from a path, so `docs/`
     * is one; LinkForge has `docs/architecture`, which reached `subsystemsOf` and made **"Explain the
     * architecture"** a question about a subsystem called architecture. The whole repository-wide
     * question narrowed itself to a documentation folder, on three of twelve repositories.
     */
    units: [...packages]
      .filter((entry) => entry.declarations > 0)
      .sort((left, right) => right.declarations - left.declarations || left.name.localeCompare(right.name))
      .map((entry) => entry.name),
    architecture,
    languages: architecture.languages,
    depth: context.capabilities.depth,
    isPolyglot: context.capabilities.isPolyglot,
  };
}

/**
 * The names a question may narrow itself to, drawn from what the repository demonstrably contains.
 *
 * **The closed set that makes an `aspect` scope grounded rather than guessed.** "Explain Redis" is a
 * subsystem question only if Redis is in this repository; against a repository without it, the same
 * words are a question the facts cannot answer, and narrowing the whole explanation at it would be the
 * worst possible response. So the candidate names come from the profile — detected technologies, claimed
 * domains, derived packages, role layers and the capability nouns two layers agreed on — and a question
 * matching none of them stays repository-wide.
 *
 * Lowercased, because matching is. Package paths contribute their last segment as well as the whole
 * path: nobody asks about `packages/react-reconciler` by that name, they ask about the reconciler.
 */
export function subsystemsOf(profile: RepositoryProfile): ReadonlySet<string> {
  const names = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim().toLowerCase();

    if (trimmed.length >= 3) {
      names.add(trimmed);
    }
  };

  for (const entry of profile.stack) {
    for (const technology of entry.evidence) {
      add(technology);
    }
  }

  for (const claim of profile.domains) {
    add(claim.domain);
  }

  for (const layer of profile.architecture.layers) {
    add(layer.role);

    for (const member of layer.members) {
      add(member);
    }
  }

  for (const capability of profile.architecture.capabilities) {
    add(capability.noun);
  }

  for (const group of profile.architecture.routeGroups) {
    add(group.prefix.replace(/^\//, ''));
  }

  for (const unit of profile.units) {
    add(unit);

    // Nobody asks about `packages/react-reconciler` by that name; they ask about the reconciler.
    const tail = unit.split('/').at(-1);

    if (tail !== undefined) {
      add(tail);

      for (const word of tail.split(/[-_.]/)) {
        add(word);
      }
    }
  }

  return names;
}

/**
 * How much of the repository fits in an explanation.
 *
 * Two independent measures, and the **larger band wins**. `nameable` is the graph-driven one — the
 * count of distinct things a projection could put a name to, against what a standard tier can carry —
 * and it is what the bands actually mean. `files` is the floor, and it exists because the nameable
 * measure is unavailable for every context kind except `repository` and because a repository can be
 * enormous in files while being small in analysed declarations. Taking the larger of the two can only
 * push an explanation towards more caution, which is the safe direction: a large repository explained
 * as though it were medium overwhelms a reader, while the reverse merely offers a drill-down nobody
 * needed.
 */
function scaleOf(
  context: RepositoryContext,
  architecture: ArchitectureSummary,
  overview: { readonly repository: { readonly files: number; readonly declarations: number }; readonly packages: { readonly total: number } } | null,
): ScaleMeasure {
  const regionFiles = context.capabilities.regions.reduce((sum, region) => sum + region.fileCount, 0);
  const files = Math.max(overview?.repository.files ?? 0, regionFiles);
  const declarations = overview?.repository.declarations ?? 0;
  const packages = overview?.packages.total ?? 0;

  const nameable =
    overview === null
      ? null
      : packages +
        architecture.layers.reduce((sum, layer) => sum + layer.declarations, 0) +
        architecture.routeGroups.length +
        context.technologies.length;

  const byFiles = bandOf(files, FILE_BANDS);
  const byNameable =
    nameable === null
      ? 'small'
      : bandOf(nameable, [
          ['small', NAMING_CAPACITY],
          ['medium', NAMING_CAPACITY * MEDIUM_MULTIPLE],
          ['large', NAMING_CAPACITY * LARGE_MULTIPLE],
        ]);

  const scale = SCALE_ORDER[Math.max(SCALE_ORDER.indexOf(byFiles), SCALE_ORDER.indexOf(byNameable))] ?? 'small';

  return { scale, files, declarations, packages, nameable, capacity: NAMING_CAPACITY };
}

function bandOf(value: number, bands: readonly (readonly [RepositoryScale, number])[]): RepositoryScale {
  for (const [scale, ceiling] of bands) {
    if (value <= ceiling) {
      return scale;
    }
  }

  return 'huge';
}

/**
 * What kind of thing this repository is.
 *
 * **A ranked list of rules, each naming the evidence that fired it, and the first match wins.** Ordered
 * rather than scored for the same reason `intentOf` is: two rules matching one repository must resolve
 * the same way on every run, and a score would invite tuning a number nobody could justify.
 *
 * The order runs from the most structurally distinctive to the least. A repository with no analysed
 * code but a Dockerfile can only be infrastructure; a repository with routes is serving something,
 * whatever else it also is; a repository with neither routes nor a public surface is not going to be
 * confidently classified at all, and `unknown` says so.
 */
function typeOf(
  context: RepositoryContext,
  architecture: ArchitectureSummary,
  scale: ScaleMeasure,
  packageNames: readonly string[],
  dependencies: ReadonlySet<string>,
  regions: RepositoryContext['capabilities']['regions'],
  traits: readonly TraitClaim[],
): Evidenced<RepositoryType> {
  const has = (trait: ComplexityTrait): TraitClaim | undefined => traits.find((claim) => claim.trait === trait);
  const named = (entries: readonly { readonly name: string }[]): string => entries.map((entry) => entry.name).join(', ');

  const hasFrontend = architecture.frontend.length > 0;
  const hasBackend = architecture.backend.length > 0;
  const own = ownRoutes(context);
  const routes = own.length;
  /*
   * Manifest-bearing regions, excluding the ones that are demonstrations.
   *
   * Flask ships `examples/tutorial/pyproject.toml` and `examples/celery/pyproject.toml`, so counting
   * every manifest region made Flask a **monorepo** — which is not wrong about the files and is badly
   * wrong about the repository, and would have opened its explanation with "what the repository holds
   * and how it is divided". An example that is packaged so it can be installed is still an example.
   */
  const manifestRegions = regions.filter(
    (region) => region.ecosystems.length > 0 && isProductionPath(region.path),
  );

  /*
   * Infrastructure first, and it is the one rule that reads an *absence* — deliberately, because the
   * absence here is measured rather than assumed. A region reports its own analysis depth, so
   * "no declarations" from a semantic region means there is no code, while the same from a `universal`
   * region means nobody looked. Only the first is evidence.
   */
  if (architecture.infrastructure.length > 0 && scale.declarations === 0 && !hasBackend && !hasFrontend) {
    return {
      value: 'infrastructure',
      evidence: [
        `built with ${named(architecture.infrastructure)}`,
        'no declarations were found in any analysed region',
      ],
    };
  }

  const pipeline = has('compiler-pipeline');

  if (pipeline !== undefined) {
    return { value: 'compiler', evidence: pipeline.evidence };
  }

  const extension = has('plugin-oriented');

  /*
   * A framework outranks a route, and that ordering is the fix for React.
   *
   * React is organised into 141 packages, several of them extension points, and it also carries five
   * routes — from the little Express servers under `fixtures/flight/server` and its siblings, which
   * exist to exercise Flight and SSR. With the route rule first, React was profiled as an
   * *Express application*, and the guidance told the model to explain where a request enters and what
   * it passes through. A repository built for other people's code to plug into is a framework whatever
   * else it also contains, so this asks first.
   *
   * Both signals are required. A single `src/plugins` directory in an application does not reach here,
   * because the trait needs two extension-point packages that carry declarations.
   */
  if (extension !== undefined && packageNames.length > 1) {
    return {
      value: 'framework',
      evidence: [...extension.evidence, `organised into ${scale.packages} packages`],
    };
  }

  if (routes > 0 && servesItsOwnRoutes(routes, architecture.declaredRouteCount)) {
    const surfaces = surfacesOf(own).join(', ');
    const total = architecture.declaredRouteCount;
    const evidence = [
      `exposes ${routes} route${routes === 1 ? '' : 's'}${surfaces === '' ? '' : ` under ${surfaces}`}`,
      // Said out loud where the two disagree, because the difference is the reason this is a service
      // rather than the framework whose tests declare the rest.
      ...(total > routes ? [`${total - routes} further routes are declared only in tests or examples`] : []),
      ...(hasBackend ? [`served by ${named(architecture.backend)}`] : []),
    ];

    /*
     * An application renders something to a person; a service answers another program. The distinction
     * is exactly which technology categories were detected, and nothing else needs to be inferred from
     * it — the frontend detection carries its own evidence.
     */
    if (hasFrontend) {
      return { value: 'application', evidence: [...evidence, `renders with ${named(architecture.frontend)}`] };
    }

    return { value: 'service', evidence };
  }

  if (isCli(context, dependencies, packageNames)) {
    return {
      value: 'cli',
      evidence: [
        ...[...dependencies].filter((name) => CLI_DEPENDENCIES.has(name)).map((name) => `declares the argument parser ${name}`),
        ...packageNames.filter(isCliPackage).map((name) => `a package at ${name}`),
      ],
    };
  }

  /*
   * How to describe the route situation without saying something false.
   *
   * Everything below this point was reached either because there are no routes at all, or because the
   * routes there are did not survive the share test. "Declares no routes" is true in the first case and
   * a lie in the second, and an evidence field that lies is worse than one that is vague — it is the
   * field a reader checks the claim against.
   */
  const routeNote =
    architecture.declaredRouteCount === 0
      ? 'declares no routes'
      : `declares ${architecture.declaredRouteCount} routes, almost all of them in tests or examples`;

  if (hasFrontend && scale.declarations > 0) {
    return { value: 'library', evidence: [`built with ${named(architecture.frontend)}`, routeNote] };
  }

  /*
   * Tooling before library, but only with a command directory to prove it.
   *
   * The first version of this rule asked for a build or test technology and the absence of everything
   * else — and duly classified Apache Commons Lang, a Java utility library, as tooling because it uses
   * JUnit. Nearly every library in existence has a test runner, so that rule said almost nothing.
   *
   * What separates a tool from a library is that a tool is *run*. A top-level `cli`, `cmd` or `bin`
   * unit is the graph's evidence for that, and it is the same evidence `cli` uses — the difference
   * being that `cli` also found a declared argument parser. A tool with no command directory falls
   * through to `library`, which is the safe direction: the library instruction explains a public
   * surface, and a tool has one.
   */
  if (
    (architecture.build.length > 0 || architecture.testing.length > 0) &&
    !hasBackend &&
    !hasFrontend &&
    architecture.persistence.length === 0 &&
    architecture.cache.length === 0 &&
    scale.declarations > 0 &&
    packageNames.some(isCliPackage)
  ) {
    return {
      value: 'tooling',
      evidence: [
        `built with ${named([...architecture.build, ...architecture.testing])}`,
        `a command directory at ${packageNames.filter(isCliPackage).join(', ')}`,
        `${routeNote}, and no application framework`,
      ],
    };
  }

  if (manifestRegions.length > 1) {
    return {
      value: 'monorepo',
      evidence: [
        `${manifestRegions.length} regions carry their own dependency manifest: ${manifestRegions
          .slice(0, 5)
          .map((region) => (region.path === '' ? '(root)' : region.path))
          .join(', ')}`,
      ],
    };
  }

  /*
   * A library is claimed from a manifest plus declarations plus the absence of a route, which is weaker
   * evidence than everything above it and is why it sits last. `scale.declarations > 0` is what keeps a
   * documentation repository with a package.json out.
   */
  if (manifestRegions.length === 1 && scale.declarations > 0) {
    return {
      value: 'library',
      evidence: [
        `one dependency manifest, in ${manifestRegions[0]?.path === '' ? 'the repository root' : (manifestRegions[0]?.path ?? '')}`,
        `${scale.declarations} declarations; ${routeNote}`,
      ],
    };
  }

  return { value: 'unknown', evidence: [] };
}

/**
 * Whether the repository is driven from a command line.
 *
 * **Both signals are required, and requiring both is a correction rather than caution.** Declaring an
 * argument parser looked like decisive evidence until Flask was profiled: Flask depends on `click`
 * because it ships a `flask run` command, and the rule duly called the best-known Python web framework a
 * command-line tool. Half of a library's dependencies are there for something other than what the
 * library is.
 *
 * So a parser must be joined by a **top-level** unit named for commands. Top-level is what excludes
 * Flask, whose command code sits at `src/flask/cli` — a module inside a library — rather than at
 * `src/cli`, which is where a repository that *is* a command puts it.
 *
 * A command-line tool whose command code lives in no directory named for it is not claimed, and falls
 * through to `library`. That is the intended failure: the library instruction — explain the public
 * surface and how the implementation is organised behind it — is broadly right for a CLI, while the CLI
 * instruction applied to Flask would have forbidden the answer from mentioning routes.
 */
function isCli(
  context: RepositoryContext,
  dependencies: ReadonlySet<string>,
  packageNames: readonly string[],
): boolean {
  const parser = [...dependencies].some((name) => CLI_DEPENDENCIES.has(name));

  return parser && packageNames.some(isCliPackage) && context.capabilities.regions.some((region) => region.ecosystems.length > 0);
}

/**
 * A unit named for commands, at the top of the repository rather than inside something else.
 *
 * At most one directory may precede the segment, so `cli`, `cmd`, `src/cli` and `packages/cli` count
 * while `src/flask/cli` does not.
 */
function isCliPackage(name: string): boolean {
  const segments = name.split('/').filter((segment) => segment !== '');
  const last = segments.at(-1) ?? '';

  return segments.length <= 2 && /^(cli|cmd|bin|commands?)$/.test(last);
}

/**
 * The structural traits the graph supports, each with its own evidence.
 *
 * Multi-valued and independently derived: nothing here excludes anything else, because a repository
 * really can be modular and layered and backend-heavy at once, and a single-label answer would have to
 * throw two of those away.
 */
function traitsOf(
  context: RepositoryContext,
  architecture: ArchitectureSummary,
  scale: ScaleMeasure,
  packageNames: readonly string[],
  regions: RepositoryContext['capabilities']['regions'],
): readonly TraitClaim[] {
  const claims: TraitClaim[] = [];
  const add = (trait: ComplexityTrait, evidence: readonly string[]): void => {
    if (evidence.length > 0) {
      claims.push({ trait, evidence });
    }
  };

  // Layered: three or more of the conventional role layers were annotated. Two is a controller calling
  // a service, which every route handler does; three is a decision about how the code is organised.
  if (architecture.layers.length >= 3) {
    add(
      'layered',
      [architecture.layers.map((layer) => `${layer.role} (${layer.declarations})`).join(', ')],
    );
  }

  if (scale.packages > 1) {
    add('multi-package', [`${scale.packages} derived packages`]);
  }

  // Modular: enough packages that the boundaries are the architecture. The threshold is the same
  // capacity the scale bands use, so "modular" means "more packages than one answer can name".
  if (scale.packages >= 8) {
    add('modular', [`${scale.packages} packages, more than an answer can name at once`]);
  }

  if (scale.packages <= 1 && architecture.layers.length <= 1 && scale.declarations > 0) {
    add('simple', ['one package and at most one role layer']);
  }

  const extensions = packageNames.filter((name) =>
    EXTENSION_STEMS.some((stem) => name.toLowerCase().split(/[/\-_.]/).includes(stem)),
  );

  if (extensions.length >= 2) {
    add('plugin-oriented', [`packages named for extension points: ${extensions.slice(0, 6).join(', ')}`]);
  }

  const stages = pipelineStages(packageNames);

  /*
   * Two **distinct stages**, not two packages.
   *
   * Counting packages was the bug: Plotly Dash ships `dash-generator-test-component-nested` and
   * `dash-generator-test-component-standard`, both matched `generator`, both mapped to the same stage,
   * and a dashboard framework was profiled as a compiler on the strength of two test fixtures with a
   * word in common. A pipeline is evidenced by *different* stages appearing — parsing and code
   * generation — because that is what makes it a pipeline rather than a naming coincidence.
   */
  const distinct = new Set(stages.values());

  if (distinct.size >= 2) {
    add('compiler-pipeline', [
      `packages named for ${distinct.size} distinct compilation stages: ${[...stages.entries()].map(([name, stage]) => `${name} (${stage})`).join(', ')}`,
    ]);
  }

  /*
   * Multi-service: two or more regions that each carry their own manifest *and* a backend technology.
   * Deliberately not called "microservice" — the graph can see that two deployable units exist in one
   * repository, and cannot see whether they are deployed independently, which is what the word means.
   */
  const serviceRegions = regions.filter(
    (region) =>
      region.ecosystems.length > 0 &&
      architecture.backend.some((entry) => entry.region === region.path && region.path !== ''),
  );

  if (serviceRegions.length >= 2) {
    add('multi-service', [
      `${serviceRegions.length} regions each carry a manifest and a backend framework: ${serviceRegions
        .map((region) => region.path)
        .join(', ')}`,
    ]);
  }

  const frontend = architecture.frontend.length > 0;
  const backend = architecture.backend.length > 0 || architecture.persistence.length > 0;

  if (frontend && backend) {
    add('full-stack', [
      `${architecture.frontend.map((entry) => entry.name).join(', ')} in front of ${[...architecture.backend, ...architecture.persistence].map((entry) => entry.name).join(', ')}`,
    ]);
  } else if (frontend) {
    add('frontend-heavy', [`only frontend technologies detected: ${architecture.frontend.map((entry) => entry.name).join(', ')}`]);
  } else if (backend) {
    add('backend-heavy', [
      `only backend and data technologies detected: ${[...architecture.backend, ...architecture.persistence].map((entry) => entry.name).join(', ')}`,
    ]);
  }

  const cycles = context.dependencies.cycles;
  const importCycles = cycles?.totals.import ?? 0;

  if (importCycles > 0) {
    add('cyclic', [`${importCycles} import cycles`]);
  }

  return claims;
}

function pipelineStages(packageNames: readonly string[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();

  for (const name of packageNames) {
    for (const word of name.toLowerCase().split(/[/\-_.]/)) {
      const stage = PIPELINE_STAGES[word];

      if (stage !== undefined && !found.has(name)) {
        found.set(name, stage);
      }
    }
  }

  return found;
}

/** The technology categories present, each carrying the technologies that put it there. */
function stackOf(architecture: ArchitectureSummary): readonly Evidenced<string>[] {
  const entries: readonly (readonly [string, readonly { readonly name: string }[]])[] = [
    ['frontend', architecture.frontend],
    ['backend', architecture.backend],
    ['persistence', architecture.persistence],
    ['cache', architecture.cache],
    ['infrastructure', architecture.infrastructure],
    ['testing', architecture.testing],
    ['build', architecture.build],
  ];

  return entries
    .filter(([, technologies]) => technologies.length > 0)
    .map(([category, technologies]) => ({
      value: category,
      evidence: technologies.map((entry) => entry.name),
    }));
}

/**
 * The domains the repository is organised around, from four independent kinds of evidence.
 *
 * A domain is claimed the moment **one** concrete artefact names it, and the artefact is carried. That
 * is a lower bar than `Capability` in `architecture.ts`, which requires two role layers to agree, and
 * the difference is deliberate: a capability is a claim that the system is *built around* a noun, while
 * a domain is a claim that the responsibility is *present somewhere* — which a single `REDIS_URL` or a
 * single `/auth/login` route settles on its own.
 */
function domainsOf(context: RepositoryContext, architecture: ArchitectureSummary): readonly DomainClaim[] {
  const found = new Map<Domain, string[]>();
  const claim = (domain: Domain, evidence: string): void => {
    const held = found.get(domain) ?? [];

    if (!held.includes(evidence)) {
      held.push(evidence);
    }

    found.set(domain, held);
  };

  /**
   * Which domains were claimed by evidence the graph could place in the repository's own code.
   *
   * Two of the sources below cannot be placed, and both are graph limitations rather than oversights. A
   * repository context's `dependencies.view` is `null` — a dependency view needs one subject node — so
   * external packages arrive as a flat union of every manifest in the tree. Environment variable nodes
   * are *merged by name* across the repository ("materialised from 2 framework read(s)") and carry
   * `fileId: null`, so a variable read in four places has no place at all. Everything else — route
   * groups, role layers, capabilities, detected technologies — is scoped to production code.
   */
  const placeable = new Set<Domain>();
  const unplaceable = new Set<Domain>();

  const match = (text: string, source: string, tier: 'placeable' | 'unplaceable' = 'placeable'): void => {
    const words = new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== ''),
    );

    for (const [domain, vocabulary] of DOMAIN_WORDS) {
      if (vocabulary.some((word) => words.has(word))) {
        claim(domain, source);
        (tier === 'placeable' ? placeable : unplaceable).add(domain);
      }
    }
  };

  for (const group of architecture.routeGroups) {
    match(group.prefix, `the route ${group.example}`);
  }

  for (const name of architecture.configuration) {
    match(name, `the environment variable ${name}`, 'unplaceable');
  }

  for (const layer of architecture.layers) {
    for (const member of layer.members) {
      match(member, `${member}, annotated ${layer.role}`);
    }
  }

  for (const capability of architecture.capabilities) {
    match(capability.noun, `${capability.noun}, named in ${capability.layers.join(' and ')} declarations`);
  }

  // A detected technology settles some domains outright, because the detection has already named the
  // responsibility — a cache is caching, a persistence technology is persistence.
  for (const entry of architecture.persistence) {
    claim('persistence', `${entry.name}, detected`);
  }

  for (const entry of architecture.cache) {
    claim('caching', `${entry.name}, detected`);
  }

  for (const [category, technologies] of [
    ['frontend', architecture.frontend],
    ['testing', architecture.testing],
    ['build', architecture.build],
    ['infrastructure', architecture.infrastructure],
  ] as const) {
    const domain = CATEGORY_DOMAIN[category];

    if (domain !== undefined && technologies.length > 0) {
      claim(domain, `${technologies.map((entry) => entry.name).join(', ')}, detected`);
    }
  }

  if (architecture.routeCount > 0) {
    claim('routing', `${architecture.routeCount} routes, extracted from the framework`);
  }

  for (const name of declaredDependencies(context)) {
    if (CACHING_TECHNOLOGIES.has(name.toLowerCase())) {
      claim('caching', `the declared dependency ${name}`);
      unplaceable.add('caching');
    }

    match(name, `the declared dependency ${name}`, 'unplaceable');
  }

  /*
   * In a repository that is mostly *not* its own code, an unplaceable source cannot establish a domain.
   *
   * **This is the last and subtlest of the `stripe/ai` fictions.** After the technologies, the routes,
   * the configuration and the role layers were all scoped, the repository still reported that it was
   * organised around rendering, persistence, networking, routing and authentication — every one claimed
   * by a dependency name or an environment variable, and every one of those declared or read inside a
   * benchmark fixture. A repository built to hold sample applications declares the whole web and reads
   * everyone's secrets.
   *
   * The condition is a measured majority rather than the mere presence of a demonstration, and that
   * distinction matters: almost every real repository has a `tests` or `docs` directory, and dropping
   * unplaceable claims on that basis would silently cost a genuine service the `persistence` domain
   * whose only evidence is a `DATABASE_URL`. It fires only where most of the analysed source is not the
   * repository's own — measured at 0.34 on `stripe/ai` and above 0.9 on every single-unit repository in
   * the corpus.
   *
   * Like `OWN_ROUTE_SHARE`, the threshold is a **judgement about a ratio** rather than a measurement,
   * and it is stated here so it can be argued with.
   */
  const share = deriveStructure(context).productionShare;

  const claims = [...found.entries()].filter(
    ([domain]) => share >= OWN_CODE_SHARE || placeable.has(domain) || !unplaceable.has(domain),
  );

  return claims
    .map(([domain, evidence]) => ({ domain, evidence: evidence.slice(0, 4) }))
    .sort(
      (left, right) =>
        right.evidence.length - left.evidence.length || DOMAINS.indexOf(left.domain) - DOMAINS.indexOf(right.domain),
    );
}

/**
 * Whether the routes that survived the path filter are a surface or a residue.
 *
 * **A proportion, because the absolute count could not settle it.** Filtering by path took Flask from
 * 134 routes to 13, Gin from 112 to 6 and FastAPI from 598 to 17 — and all three were still profiled
 * as web services on the strength of what remained. What remained was not a surface: it was Gin's own
 * `routergroup.go`, where the `GET` method that *registers* a route is defined, and Flask's internal
 * `add_url_rule` scaffolding. A framework that provides routing will always leak a few routes into an
 * extractor looking for routing.
 *
 * The share is what distinguishes them. A repository serving a surface declares most of its routes in
 * its own code; a repository *demonstrating* routing declares almost all of them in tests and
 * examples, and the handful left over are the machinery rather than the surface. A quarter is
 * demanding enough to exclude 10%, 5% and 3%, and forgiving enough that a genuine service with a
 * heavier end-to-end suite than production surface — three test routes for every real one — is still a
 * service.
 *
 * This is a **judgement about a ratio**, not a measurement, and it is the one threshold in this file
 * that could be argued with. It is stated here so it can be.
 */
const OWN_ROUTE_SHARE = 0.25;

/**
 * The share of analysed source that must be the repository's own before an unplaceable claim is trusted.
 *
 * A half: below it, most of what was read is demonstrations, and a dependency or an environment variable
 * is more likely to belong to one of them than to the repository. See `domainsOf`.
 */
const OWN_CODE_SHARE = 0.5;

function servesItsOwnRoutes(own: number, total: number): boolean {
  return total <= 0 || own / total >= OWN_ROUTE_SHARE;
}

/**
 * The first path segment of each route, largest group first.
 *
 * Derived from the *same filtered set* as the count that cites it, which is a correction rather than a
 * convenience. The count came from the repository's own routes and the surfaces came from all of them,
 * so PetClinic's evidence read "exposes 1 route under /owners (13)" — a sentence contradicting itself
 * inside eleven words, in the one field whose entire job is to let a reader check the claim.
 */
function surfacesOf(routes: readonly RepositoryContext['routes'][number][]): readonly string[] {
  const groups = new Map<string, number>();

  for (const route of routes) {
    const path = route.composition.effectivePath;
    const segment = path.split('/').filter((part) => part !== '')[0];
    const prefix = segment === undefined ? '/' : `/${segment}`;

    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }

  return [...groups.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([prefix, count]) => `${prefix} (${count})`);
}

/**
 * Every ecosystem dependency name the context carries.
 *
 * Read from the external package nodes, whose identities the graph spells `ext:<kind>:<name>` — so the
 * name is recovered by reading the identity rather than by parsing prose.
 */
function declaredDependencies(context: RepositoryContext): ReadonlySet<string> {
  const names = new Set<string>();

  for (const node of context.dependencies.externalPackages) {
    const name = typeof node.externalName === 'string' ? node.externalName : node.name;

    if (typeof name === 'string' && name !== '') {
      names.add(name);
    }
  }

  return names;
}
