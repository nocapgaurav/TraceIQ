/**
 * What a question is *about*, decided from the question alone.
 *
 * **This exists because a repository projection cannot be balanced and complete at the same time.** A
 * `standard` budget holds roughly 5,500 tokens of facts; `facebook/react` has 141 packages, 129 regions,
 * 120 hotspots, 333 dependencies and 37 role-bearing declarations, which is an order of magnitude more
 * than fits. Something must be dropped for every question, and dropping the same things for every
 * question means a question about technologies pays for hotspot rankings it will never use.
 *
 * **Keyword matching, and deliberately not a model.** Three reasons, in order of weight:
 *
 * 1. It must be *deterministic*. Everything below `generate` in this pipeline is reproducible, which is
 *    what makes an unexpected answer investigable by re-running the projection and comparing digests.
 *    A classifier that sampled would put a coin flip upstream of the evidence.
 * 2. It must be *free*. Prompt evaluation on the reference stack runs at 45.75 tokens per second, so a
 *    second model call to decide what the first should read would cost more than the saving.
 * 3. It must be *safe when wrong*. It is — see `INTENTS`. An intent only reorders what a **supplement**
 *    contains; the core facts every answer needs are projected first and identically regardless. A
 *    misclassified question gets a differently-ordered supplement, never a missing repository.
 *
 * Matching is on whole words against a lowercased question, so `packaging` does not match `package` and
 * a question mentioning `services` is not classified by the substring inside `microservices`.
 */

export const INTENTS = [
  /**
   * Where something is, what to read, what to change, what covers it.
   *
   * **The one intent that asks for a *location* rather than an explanation**, and its absence was a
   * measured failure: "what tests should I read first?" classified as `architecture`, so the projection
   * led with role counts and the answer was a repository overview. A reader asking which file to open
   * cannot use any of that. It is first in this list because a locating question mentioning any other
   * vocabulary is still a locating question — "where is the caching implemented" wants a path, not a
   * description of the cache.
   */
  'locate',
  'architecture',
  'technology',
  'hotspots',
  'packages',
  'security',
  'caching',
  'deployment',
  'overview',
] as const;

export type QuestionIntent = (typeof INTENTS)[number];

/**
 * Which parts a given intent wants more of.
 *
 * Names the extractor parts from `projection.ts`. An intent is a **reordering of the supplement**, so
 * every part remains reachable under every intent — a part not listed here is simply projected after
 * the listed ones rather than excluded. That property is what makes a misclassification cheap.
 */
export const INTENT_PARTS: Readonly<Record<QuestionIntent, readonly string[]>> = {
  /**
   * The parts that name things a reader can open.
   *
   * `tests` first because a test question is the commonest form and nothing else carries a test name;
   * then the packages and role layers, which are where "what owns this" is answered; then the routes,
   * which are where a feature is entered.
   */
  /**
   * `onboarding` leads, because the commonest locating question is "where should I start".
   *
   * The evidence an onboarding answer may rest on — documentation, manifest entry points, package
   * boundaries — is exactly what `onboarding` carries, and `hotspots` sits last on purpose: a ranking is
   * an answer to "what does most of the repository point at" and never to "what should I read first".
   */
  locate: ['onboarding', 'tests', 'packages', 'architecture', 'key-artifacts', 'routes', 'regions', 'hotspots'],
  /**
   * `key-artifacts` sits with the code-level architecture parts rather than behind them.
   *
   * On a repository whose services are wired in a compose file and whose build is wired in workflows, the
   * artefacts *are* the architecture — and a projection that reached them only after the role counts and
   * the package listing reached them only on repositories that did not need them.
   */
  architecture: ['architecture', 'key-artifacts', 'routes', 'packages', 'regions', 'cycles', 'composition'],
  technology: ['technologies', 'externalPackages', 'key-artifacts', 'composition', 'regions'],
  hotspots: ['hotspots', 'health', 'cycles', 'impact-summary', 'incomingCalls'],
  packages: ['packages', 'architecture', 'key-artifacts', 'externalPackages', 'cycles'],
  /**
   * Authentication, authorisation, secrets and the surfaces they guard.
   *
   * The parts that carry them are the ones nothing else prioritises: `routes` is where a login
   * endpoint appears, `environmentVariables` is where a secret or a token key appears, and
   * `architecture` is where middleware — the usual home of an auth guard — is named. A question about
   * security used to fall through to `overview` and be answered from package counts.
   */
  security: ['routes', 'environmentVariables', 'architecture', 'externalPackages', 'technologies', 'key-artifacts'],
  /**
   * What makes reads fast, and what it is keyed on.
   *
   * `technologies` carries the cache itself with its responsibility clause; `environmentVariables` is
   * where its connection string lives (`REDIS_URL`); `hotspots` is the closest the graph gets to the
   * hot path a cache would exist to protect.
   */
  caching: ['technologies', 'environmentVariables', 'hotspots', 'externalPackages'],
  /**
   * How it is built and shipped.
   *
   * **`key-artifacts` leads, and that reordering is a substantive fix rather than a preference.** The
   * infrastructure technologies carry their own evidence — a Dockerfile, a Compose file, a workflow — but
   * only as the *name* of the technology and the path that proved it. What a deployment question asks for
   * is what those files declare: the stages, the services, the jobs, and which job the artefact says needs
   * which. Until artefact analysis existed there was no fact carrying any of that, so a deployment answer
   * was assembled from a technology list and an environment variable list, and the two most it could say
   * were "Docker is used" and "these variables are read".
   */
  deployment: ['key-artifacts', 'technologies', 'environmentVariables', 'composition', 'regions'],
  // A balanced question gets the declared order, which is already the balanced one.
  overview: [],
};

/**
 * The words that select each intent, in priority order.
 *
 * Ordered rather than scored: the first intent with a match wins, so two intents matching one question
 * resolve the same way every time. `technology` precedes `architecture` because "what frameworks does
 * the architecture use" is a technology question wearing an architecture word, and dependencies answer
 * it while role counts do not.
 */
const KEYWORDS: readonly (readonly [QuestionIntent, readonly string[]])[] = [
  /**
   * First, because a question asking where to look is asking that whatever else it names.
   *
   * The vocabulary is the vocabulary of *navigating* a repository rather than of understanding it:
   * reading, opening, finding, changing, adding, debugging, owning. `test` and its relatives are here
   * rather than under a testing intent because "what tests cover this" is a locating question — the
   * reader wants files — while "what test framework is used" is a technology question and says
   * `framework`, which `technology` matches further down.
   *
   * **`which`, `start`, `look`, `add` and `fix` were tried here and removed.** Each is a word people use
   * when navigating and also when doing something else entirely, and the existing suite caught the first
   * one immediately: "Which modules are most referenced?" is an importance question, and `which` made it
   * a locating one. The words that survived are the ones that have no other job.
   */
  [
    'locate',
    [
      'test', 'tests', 'spec', 'specs', 'covered', 'covers', 'coverage',
      'read', 'reading', 'open', 'find', 'locate', 'located', 'where',
      'file', 'files', 'implemented', 'implementation', 'modify', 'edit', 'debug', 'owns',
    ],
  ],
  /**
   * First, because a security question mentioning any other vocabulary is still a security question.
   *
   * "How does authentication work in this architecture" is not an architecture question that happens
   * to say authentication; the answer a reader wants is the login route, the middleware and the token
   * secret, none of which role counts contain.
   */
  [
    'security',
    [
      'auth', 'authentication', 'authenticate', 'authorisation', 'authorization', 'authorise',
      'authorize', 'login', 'logout', 'session', 'sessions', 'token', 'tokens', 'jwt', 'oauth',
      'credential', 'credentials', 'password', 'passwords', 'secret', 'secrets', 'permission',
      'permissions', 'security', 'secure', 'rbac',
    ],
  ],
  /**
   * Before `technology`, because "explain caching" and "explain deployment" are questions about a
   * *responsibility*, and the technology intent would answer them with the whole stack.
   */
  [
    'caching',
    ['cache', 'caches', 'cached', 'caching', 'redis', 'memcached', 'invalidation', 'ttl', 'eviction'],
  ],
  [
    'deployment',
    [
      'deploy', 'deployed', 'deployment', 'docker', 'dockerfile', 'compose', 'kubernetes', 'k8s',
      'ci', 'cd', 'pipeline', 'pipelines', 'workflow', 'workflows', 'release', 'ship', 'shipping',
      'container', 'containers', 'infrastructure', 'provisioning',
    ],
  ],
  [
    'technology',
    [
      'technology', 'technologies', 'framework', 'frameworks', 'dependency', 'dependencies',
      'library', 'libraries', 'language', 'languages', 'ecosystem', 'ecosystems', 'stack',
      'built', 'written', 'runtime', 'tooling', 'toolchain',
    ],
  ],
  [
    'hotspots',
    [
      'hotspot', 'hotspots', 'important', 'central', 'centrality', 'coupled', 'coupling',
      'referenced', 'connected', 'complex', 'complexity', 'risky', 'risk', 'impact', 'cycle',
      'cycles', 'fragile', 'critical',
    ],
  ],
  [
    'architecture',
    [
      'architecture', 'architectural', 'layer', 'layers', 'structure', 'structured', 'organised',
      'organized', 'service', 'services', 'boundary', 'boundaries', 'design', 'communicate',
      'communication', 'route', 'routes', 'endpoint', 'endpoints', 'controller', 'controllers',
      'entry', 'start', 'first', 'overview',
    ],
  ],
  /**
   * After `architecture`, and that ordering is a bug fix rather than a preference.
   *
   * "Explain the architecture and how modules communicate" was classified `packages`, because
   * `modules` sat in this list and this list was checked first — so the one question most obviously
   * about architecture received a package listing. The word `modules` is genuinely ambiguous; the
   * words below it are not, and an explicit architecture word should win over an ambiguous one.
   */
  [
    'packages',
    ['package', 'packages', 'module', 'modules', 'owns', 'ownership', 'biggest', 'largest', 'component', 'components'],
  ],
];

/**
 * Classifies one question.
 *
 * Falls back to `overview`, which is the balanced projection — so a question using none of the
 * vocabulary above loses nothing it would otherwise have had.
 */
export function intentOf(question: string): QuestionIntent {
  const words = new Set(question.toLowerCase().match(/[a-z]+/g) ?? []);

  for (const [intent, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => words.has(keyword))) {
      return intent;
    }
  }

  return 'overview';
}

/**
 * How much of the repository a question is asking about — a different axis from what it is *about*.
 *
 * **`intentOf` and this answer two questions that a single classifier kept confusing.** "Explain the
 * architecture" and "explain UrlService" are both architecture-intent: they want the same *kind* of
 * facts. They want wildly different *amounts* of answer, and until that was a separate decision, both
 * received a repository-wide explanation — which is right for the first and useless for the second.
 *
 * Three values, and the two narrow ones are only ever reached by matching something the repository
 * demonstrably contains:
 *
 * - **`entity`** — the context already has a subject. A `symbol`, `file`, `package`, `route` or
 *   `impact` context was built because a caller resolved the question to one thing, and that resolution
 *   is a stronger statement of scope than any reading of the question text could be.
 * - **`aspect`** — the question names a technology or a domain the *profile* carries. This is the case
 *   that has to be grounded rather than guessed: "explain Redis" is a subsystem question when Redis is
 *   in the repository and a question with no answer when it is not, and the difference is exactly
 *   whether the profile names it. See `focusOf`.
 * - **`whole`** — everything else, which is the repository-wide question the depth rules were written
 *   for.
 *
 * Failing towards `whole` is the safe direction, and it is the direction this fails in: an unrecognised
 * subsystem name yields a broader answer that still contains the subsystem, while a wrongly narrowed
 * question yields an answer about the wrong thing.
 */
export const QUESTION_SCOPES = ['whole', 'aspect', 'entity'] as const;

export type QuestionScope = (typeof QUESTION_SCOPES)[number];

/** Context kinds that were built because a caller had already resolved the question to one subject. */
const RESOLVED_KINDS: ReadonlySet<string> = new Set(['symbol', 'file', 'package', 'route', 'impact']);

/**
 * Words that are how a question is *asked*, never what it is about.
 *
 * **A guard against the narrowing being turned against the broadest questions there are.** LinkForge
 * derives a package from every path, including `docs/architecture`; that package reached the candidate
 * set, the word `architecture` matched, and "Explain the architecture" — the single most
 * repository-wide question anyone asks — was narrowed to a documentation folder. Three of twelve
 * validated repositories did this.
 *
 * Filtering the units to source-bearing packages fixes that particular case. This exists because the
 * general case survives it: a real code directory named `architecture`, `overview` or `design` would
 * hijack the same questions, and no amount of filtering by declaration count would catch it. These
 * words are the vocabulary of asking, so they can never be the answer to what is being asked about.
 *
 * Drawn from the intent keyword lists rather than invented here — the words that select the
 * `architecture`, `packages` and `overview` intents are exactly the words that describe a question's
 * *shape*.
 */
const QUESTION_VOCABULARY: ReadonlySet<string> = new Set([
  'architecture',
  'architectural',
  'structure',
  'design',
  'overview',
  'summary',
  'repository',
  'repo',
  'project',
  'codebase',
  'system',
  'application',
  'app',
  'component',
  'components',
  'module',
  'modules',
  'package',
  'packages',
  'layer',
  'layers',
  'boundary',
  'boundaries',
  'src',
  'source',
  'lib',
  'docs',
  'doc',
  'documentation',
  'test',
  'tests',
  'example',
  'examples',
  /*
   * Adverbs of sequence and place, which are how a question is *positioned* rather than what it is
   * about — and which are also, unhelpfully, the names of real technologies.
   *
   * Validation caught the exact case: LinkForge has a Next.js frontend, so `next` is a subsystem the
   * repository demonstrably contains, and "what should I look at next?" — the closing question of a
   * thirty-turn session — was narrowed to a focused answer about Next.js. A question genuinely about
   * that framework says `Next.js`, and one that says `next` on its own at the end of a sentence never
   * is. The same reasoning the rest of this list rests on, applied to a second part of speech.
   */
  'next',
  'first',
  'last',
  'now',
  'here',
  'again',
  'else',
]);

export interface ScopeInput {
  readonly question: string;
  /** The context kind the caller asked for. */
  readonly kind: string;
  /**
   * Names the repository demonstrably contains — technologies, domains, packages, role layers.
   *
   * Supplied by the profile rather than derived here, so an `aspect` scope is always a claim about
   * something the graph holds. An empty set can only produce `whole`, which is what a caller with no
   * profile in hand should get.
   */
  readonly subsystems?: Iterable<string>;
}

export function scopeOf(input: ScopeInput): QuestionScope {
  if (RESOLVED_KINDS.has(input.kind)) {
    return 'entity';
  }

  return focusOf(input) === null ? 'whole' : 'aspect';
}

/**
 * The subsystem a question named, confirmed against what the repository contains.
 *
 * Longest match wins, so "explain the Redis cache" resolves to `redis` rather than to `cache` when both
 * are present — the more specific name is the one the reader actually asked about. Matching is on whole
 * words against a lowercased question, and a multi-word subsystem must appear as a phrase, so `url`
 * does not match inside `curl` and `build system` does not match a question that says only `build`.
 *
 * Returns `null` rather than a best guess. A question naming nothing the repository contains has not
 * narrowed its scope, and inventing a focus from it would aim the whole answer at a subsystem the
 * facts cannot support.
 */
export function focusOf(input: ScopeInput): string | null {
  const question = input.question.toLowerCase();
  const words = new Set(question.match(/[a-z0-9]+/g) ?? []);

  let best: string | null = null;

  for (const raw of input.subsystems ?? []) {
    const name = raw.trim().toLowerCase();

    if (name.length < 3 || QUESTION_VOCABULARY.has(name)) {
      continue;
    }

    const parts = name.match(/[a-z0-9]+/g) ?? [];

    if (parts.length === 0) {
      continue;
    }

    // A single token must be a whole word in the question; a multi-token name must appear as a phrase,
    // because its tokens scattered across a sentence are not a mention of it.
    const mentioned =
      parts.length === 1
        ? words.has(parts[0] ?? '')
        : new RegExp(`\\b${parts.map(escape).join('[^a-z0-9]+')}\\b`).test(question);

    if (mentioned && (best === null || name.length > best.length)) {
      best = name;
    }
  }

  return best;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
