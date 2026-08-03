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
  /**
   * What happens, traced in order — as distinct from what exists.
   *
   * **Its absence sent every narration request to the deployment intent.** "Walk me through one important
   * workflow" says `workflow`, which is a word a CI file is called, so the question that most explicitly
   * asks for a sequence was answered from container and pipeline configuration. The two are different
   * questions with different evidence: a narration wants the request flow, the routes, the entry points
   * and the order an artefact *declares*; a deployment question wants what is built and shipped.
   */
  'workflow',
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
 * What kind of evidence a given intent must be answered from.
 *
 * **One table per intent, and it is the only place an intent's retrieval preference is written.** Before
 * this there were two: an ordering here and a share-by-lead in the planner, and neither could express the
 * failure that actually occurred — an ordered part running *second within its own budget group* and
 * receiving nothing at all. Measured on TraceIQ, "explain the architecture" admitted `key-artifacts: 0 of
 * 43` while `hotspots` took ten, because both the architecture summary and the artefacts sit in the
 * `architecture` group and whichever runs first spends the share.
 *
 * So a policy names three things rather than one:
 *
 * - **`priority`** — the evidence families this question is answered *from*. Each is guaranteed a floor
 *   of the supplement before any family competes for the remainder, which is what makes the composition a
 *   property of the question rather than of extractor order. See `PRIORITY_FLOOR` in `projection.ts`.
 * - **`supporting`** — families that may appear but must never dominate. A ranking is the archetype: it
 *   answers "what does most of the repository point at" and is evidence *behind* an answer, never the
 *   answer to a repository-wide question. These are capped hard for this intent.
 * - **`concepts`** — the words that select this intent. Kept here rather than in a second table because
 *   they are also what `focusOf` must refuse to narrow a question to: see `SOFT_FRAME`.
 *
 * A part named in neither list is still projected, behind both, exactly as before — so a
 * misclassification still costs a differently-ordered supplement rather than a missing repository.
 */
export interface EvidencePolicy {
  /** Families this intent is answered from, most direct first. Each gets a floor of the supplement. */
  readonly priority: readonly string[];
  /** Families that may support an answer and must never constitute one. Capped hard for this intent. */
  readonly supporting: readonly string[];
  /** The words that select this intent, and that a question therefore cannot be *about*. */
  readonly concepts: readonly string[];
  /**
   * Words in this intent's vocabulary that name a concrete thing rather than a kind of question.
   *
   * `redis` selects the caching intent *and* is a technology a repository may genuinely contain, so
   * "explain Redis" must still narrow. `caching` selects the same intent and names no thing.
   */
  readonly named?: readonly string[];
}

/**
 * The retrieval policy for every intent.
 *
 * Ordered as `INTENTS` is, and the order of the list itself is the classifier's precedence — the first
 * intent whose vocabulary the question uses wins, so two intents matching one question resolve the same
 * way every time.
 */
export const EVIDENCE_POLICY: Readonly<Record<QuestionIntent, EvidencePolicy>> = {
  /**
   * Where something is, and where to begin.
   *
   * `onboarding` leads because the commonest locating question is "where should I start", and what an
   * onboarding answer may rest on — documentation the repository ships, a manifest entry point, a package
   * boundary — is exactly what that part carries. `hotspots` is **supporting**, and that demotion is the
   * §5 fix in the retrieval layer rather than in prose: a fan-in ranking is not a reading order, and a
   * part that cannot license the answer must not be allowed to fill the budget for it.
   */
  locate: {
    priority: ['onboarding', 'tests', 'key-artifacts', 'packages', 'routes', 'architecture'],
    supporting: ['hotspots', 'incomingCalls', 'outgoingCalls', 'impact-summary'],
    concepts: [
      'test', 'tests', 'spec', 'specs', 'covered', 'covers', 'coverage',
      'read', 'reading', 'open', 'find', 'locate', 'located', 'where',
      'file', 'files', 'implemented', 'implementation', 'modify', 'edit', 'debug', 'owns',
    ],
  },
  /**
   * A sequence, and the evidence that establishes one.
   *
   * **Every family here records order or entry, and that is the whole selection rule.** `request-flow`
   * names the layers a request traverses, `routes` names where one enters, `onboarding` carries the entry
   * points a manifest declares, and `key-artifacts` carries `artifact-ordering` — a prerequisite the
   * repository *states* between two of its own parts, which is the only ordering evidence a configuration
   * format ever gives. A ranking records nothing about order at all, which is why it is supporting: an
   * answer that narrated a sequence from a fan-in count would be the `execution-order` claim the
   * entailment guard exists to reject, reached one layer earlier.
   */
  workflow: {
    priority: ['request-flow', 'routes', 'key-artifacts', 'onboarding', 'architecture', 'architecture-summary', 'packages'],
    supporting: ['hotspots', 'cycles', 'impact-summary', 'health'],
    concepts: ['walk', 'walkthrough', 'lifecycle', 'trace', 'traced', 'happens', 'sequence', 'flows'],
  },
  /**
   * The repository as a system: what it is, what it is divided into, and how the parts meet.
   *
   * **Six priority families rather than one lead, because a repository-level answer is exactly the answer
   * that must not come from one place.** `architecture-summary` and `purpose` say what the system is;
   * `areas` and `packages` say what it is divided into; `key-artifacts` says how the pieces are wired
   * where the wiring is in YAML rather than in code; `request-flow` and `routes` say how a request moves
   * where one does. A repository has some subset of those and never all of them, and the floor mechanism
   * spends nothing on a family with no facts — so this list is a preference order, not a template.
   */
  architecture: {
    priority: [
      'purpose',
      'architecture-summary',
      'areas',
      'packages',
      'key-artifacts',
      'architecture',
      'request-flow',
      'routes',
      'regions',
    ],
    supporting: ['hotspots', 'cycles', 'health', 'incomingCalls', 'outgoingCalls', 'impact-summary'],
    concepts: [
      'architecture', 'architectural', 'layer', 'layers', 'structure', 'structured', 'organised',
      'organized', 'service', 'services', 'boundary', 'boundaries', 'design', 'communicate',
      'communication', 'route', 'routes', 'endpoint', 'endpoints', 'controller', 'controllers',
      'entry', 'start', 'first', 'overview',
    ],
  },
  technology: {
    priority: ['technologies', 'externalPackages', 'key-artifacts', 'composition', 'regions'],
    supporting: ['hotspots', 'cycles', 'incomingCalls'],
    concepts: [
      'technology', 'technologies', 'framework', 'frameworks', 'dependency', 'dependencies',
      'library', 'libraries', 'language', 'languages', 'ecosystem', 'ecosystems', 'stack',
      'built', 'written', 'runtime', 'tooling', 'toolchain',
    ],
  },
  /**
   * The one intent for which a ranking *is* the answer, so nothing is demoted.
   *
   * A reader asking which declarations are most referenced has asked for the measurement. What the
   * answer may not do is call the result important — that is `prominence-as-importance`, adjudicated
   * after generation, and it is a claim rule rather than a retrieval rule.
   */
  hotspots: {
    priority: ['hotspots', 'health', 'cycles', 'impact-summary', 'incomingCalls'],
    supporting: [],
    concepts: [
      'hotspot', 'hotspots', 'important', 'central', 'centrality', 'coupled', 'coupling',
      'referenced', 'connected', 'complex', 'complexity', 'risky', 'risk', 'impact', 'cycle',
      'cycles', 'fragile', 'critical',
    ],
  },
  packages: {
    priority: ['packages', 'areas', 'architecture', 'key-artifacts', 'externalPackages', 'regions'],
    supporting: ['hotspots', 'cycles', 'incomingCalls'],
    concepts: ['package', 'packages', 'module', 'modules', 'owns', 'ownership', 'biggest', 'largest', 'component', 'components'],
  },
  /**
   * Authentication, authorisation, secrets and the surfaces they guard.
   *
   * The parts that carry them are the ones nothing else prioritises: `routes` is where a login endpoint
   * appears, `environmentVariables` is where a secret or a token key appears, and `architecture` is where
   * middleware — the usual home of an auth guard — is named. `hotspots` is supporting for the reason it
   * was the whole of the original failure: a file whose *name* contains `secret` ranks, and a ranking of
   * it is not an authentication mechanism.
   */
  security: {
    priority: ['routes', 'architecture', 'environmentVariables', 'externalPackages', 'technologies', 'key-artifacts'],
    supporting: ['hotspots', 'packages', 'cycles', 'incomingCalls'],
    concepts: [
      'auth', 'authentication', 'authenticate', 'authorisation', 'authorization', 'authorise',
      'authorize', 'login', 'logout', 'session', 'sessions', 'credential', 'credentials',
      'password', 'passwords', 'secret', 'secrets', 'permission', 'permissions', 'security',
      'secure',
    ],
    named: ['token', 'tokens', 'jwt', 'oauth', 'rbac'],
  },
  /**
   * What makes reads fast, and what it is keyed on.
   *
   * `technologies` carries the cache itself with its responsibility clause; `environmentVariables` is
   * where its connection string lives. `hotspots` was in the lead list and is now supporting: the hot
   * path a cache *would* protect is not a cache, and offering a ranking to a question about a cache the
   * repository does not have is how the padding this pipeline removes gets back in.
   */
  caching: {
    priority: ['technologies', 'externalPackages', 'environmentVariables', 'key-artifacts'],
    supporting: ['hotspots', 'packages', 'cycles'],
    concepts: ['cache', 'caches', 'cached', 'caching', 'invalidation', 'ttl', 'eviction'],
    named: ['redis', 'memcached'],
  },
  /**
   * How it is built and shipped.
   *
   * **`key-artifacts` leads, and that reordering is a substantive fix rather than a preference.** The
   * infrastructure technologies carry their own evidence — a Dockerfile, a Compose file, a workflow — but
   * only as the *name* of the technology and the path that proved it. What a deployment question asks for
   * is what those files declare: the stages, the services, the jobs, and which job the artefact says needs
   * which.
   */
  deployment: {
    priority: ['key-artifacts', 'artifact-inventory', 'technologies', 'environmentVariables', 'composition', 'regions'],
    supporting: ['hotspots', 'packages', 'cycles', 'incomingCalls'],
    concepts: [
      'deploy', 'deployed', 'deployment', 'ci', 'cd', 'pipeline', 'pipelines', 'workflow',
      'workflows', 'release', 'ship', 'shipping', 'container', 'containers', 'infrastructure',
      'provisioning',
    ],
    named: ['docker', 'dockerfile', 'compose', 'kubernetes', 'k8s'],
  },
  /**
   * A balanced question gets the declared order, which is already the balanced one.
   *
   * `supporting` is still populated: a question that named nothing distinctive is the *last* question that
   * should be answered from a ranking, because nothing in it asked for one.
   */
  overview: {
    priority: [],
    supporting: ['hotspots', 'incomingCalls', 'outgoingCalls', 'impact-summary'],
    concepts: [],
  },
};

/**
 * Which parts a given intent wants more of.
 *
 * Derived from `EVIDENCE_POLICY` rather than declared beside it, so an intent's retrieval preference is
 * written once. Names the extractor parts from `projection.ts`. An intent is a **reordering of the
 * supplement**, so every part remains reachable under every intent — a part not listed here is simply
 * projected after the listed ones rather than excluded.
 */
export const INTENT_PARTS: Readonly<Record<QuestionIntent, readonly string[]>> = Object.fromEntries(
  INTENTS.map((intent) => [intent, EVIDENCE_POLICY[intent].priority]),
) as Readonly<Record<QuestionIntent, readonly string[]>>;

/**
 * The order in which intents are tried, and the vocabulary of each.
 *
 * Ordered rather than scored: the first intent with a match wins, so two intents matching one question
 * resolve the same way every time. `technology` precedes `architecture` because "what frameworks does
 * the architecture use" is a technology question wearing an architecture word, and dependencies answer
 * it while role counts do not.
 *
 * The words themselves live on `EVIDENCE_POLICY`, because they are needed twice: once to select the
 * intent and once to stop `focusOf` narrowing a question to the word that classified it. Two copies of a
 * vocabulary is two chances for them to disagree.
 */
const PRECEDENCE: readonly QuestionIntent[] = [
  'locate',
  'security',
  'caching',
  /*
   * Before `deployment`, because a narration request says `workflow` and a CI file is called one.
   *
   * The vocabulary that selects this intent is narration vocabulary — `walk`, `trace`, `lifecycle` — and
   * a question using it is asking for a sequence whatever noun it hangs on. A question about CI says `ci`,
   * `deploy` or `release` and reaches the deployment intent below, which is where it belongs.
   */
  'workflow',
  'deployment',
  'technology',
  'hotspots',
  'architecture',
  /*
   * After `architecture`, and that ordering is a bug fix rather than a preference.
   *
   * "Explain the architecture and how modules communicate" was classified `packages`, because `modules`
   * sat in this list and this list was checked first — so the one question most obviously about
   * architecture received a package listing. The word `modules` is genuinely ambiguous; the architecture
   * words are not, and an explicit architecture word should win over an ambiguous one.
   */
  'packages',
];

/** Every word of an intent's vocabulary — the kinds of question it names and the things it names. */
function vocabularyOf(intent: QuestionIntent): readonly string[] {
  const policy = EVIDENCE_POLICY[intent];

  return [...policy.concepts, ...(policy.named ?? [])];
}

/**
 * The words that select each intent, in priority order.
 *
 * Assembled from the policy table so the classifier and the frame guard read one vocabulary.
 */
const KEYWORDS: readonly (readonly [QuestionIntent, readonly string[]])[] = PRECEDENCE.map((intent) => [
  intent,
  vocabularyOf(intent),
]);

/**
 * The vocabulary that classified *this* question, which is therefore how it was asked.
 *
 * **The general form of a failure that had been fixed one word at a time.** `QUESTION_VOCABULARY` below
 * lists words that describe a question's shape and was extended by hand whenever one of them turned out
 * to also be a directory name. An intent's own concepts are the same kind of word — `deployment`,
 * `caching`, `pipeline` all *classify* a question — and they were not on the list, so on TraceIQ "How
 * does deployment work?" narrowed to a subsystem called `deployment` and was planned as a question about
 * one part of the repository.
 *
 * **Only the selected intent's concepts, and that restriction is what keeps the guard from removing a
 * real subject.** "Where is caching implemented?" is a *locating* question, so `caching` is not what
 * classified it — it is what the reader wants located, and it must stay the focus. "Explain caching" is a
 * caching question, so the same word is the question's own kind and the intent already routes its
 * evidence. The word is identical; what differs is the job it did in the sentence, and the classifier
 * already knows which job that was.
 *
 * Named technologies are excluded even for their own intent: `redis` selects the caching intent and is
 * also a thing a repository genuinely contains, so "explain Redis" must still narrow. That distinction is
 * declared on the policy.
 */
function conceptFrameOf(question: string): ReadonlySet<string> {
  return new Set(EVIDENCE_POLICY[intentOf(question)].concepts);
}

/**
 * Verbs and nouns that are how somebody *asks*, in any repository.
 *
 * **The failure this closes was the worst of the observed set.** TraceIQ has a package called
 * `packages/explain`, whose last segment is a subsystem name, so **"Explain the architecture"** — the
 * single most repository-wide question there is — resolved a focus of `explain`, was scoped to one
 * aspect, planned as a subsystem question at focused depth, and allocated 70% of its evidence to
 * components. It then produced a module-level explanation with invented architectural language. Nothing
 * about the failure is specific to TraceIQ: `describe`, `review`, `compare`, `build`, `test` and `guide`
 * are all ordinary package names, and every one of them is also how a question opens.
 *
 * Unlike `QUESTION_VOCABULARY`, membership here is **conditional on the word's position** — see
 * `framed`. "Explain the architecture" uses `explain` as a verb; "how does the explain package work"
 * uses it as a noun, and the determiner in front of it is the difference. That keeps the guard from
 * making a genuinely named subsystem unaskable.
 */
const ASKING_VERBS: ReadonlySet<string> = new Set([
  'explain', 'explains', 'explained', 'explaining',
  'describe', 'describes', 'described', 'describing',
  'show', 'shows', 'tell', 'tells', 'list', 'lists', 'outline', 'outlines',
  'summarise', 'summarize', 'summarised', 'summarized',
  'walk', 'walks', 'walkthrough', 'trace', 'traces',
  'understand', 'understands', 'understanding',
  'learn', 'learns', 'learning', 'teach',
  'review', 'reviews', 'compare', 'compares', 'analyse', 'analyze', 'analysis',
  'help', 'helps', 'guide', 'guides', 'introduce', 'introduction', 'intro',
  'explore', 'explores', 'navigate', 'navigates', 'browse',
  'work', 'works', 'working', 'use', 'uses', 'used', 'using',
  'make', 'makes', 'give', 'gives', 'get', 'gets', 'know', 'knows',
  'want', 'wants', 'need', 'needs', 'ask', 'asks', 'answer', 'answers',
  'query', 'queries', 'search', 'searches',
]);

/** Words that mark the token after them as a noun naming a thing, rather than a verb doing the asking. */
const DETERMINERS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'its', 'their', 'our', 'your', 'my', 'each', 'every',
]);


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
  const tokens = question.match(/[a-z0-9]+/g) ?? [];
  const concepts = conceptFrameOf(input.question);
  const usable = new Set(tokens.filter((token, index) => !framed(token, tokens[index - 1], concepts)));

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
        ? usable.has(parts[0] ?? '')
        : new RegExp(`\\b${parts.map(escape).join('[^a-z0-9]+')}\\b`).test(question) &&
          parts.some((part) => usable.has(part));

    if (mentioned && (best === null || name.length > best.length)) {
      best = name;
    }
  }

  return best;
}

/**
 * Whether this occurrence of a word is part of how the question was *asked*.
 *
 * **Position, not membership, and that is what keeps the guard from over-reaching.** A concept word is
 * always frame: `deployment`, `caching` and `architecture` classify a question wherever they appear, and
 * a repository that happens to name a directory after one of them has not made "how does deployment
 * work?" a question about that directory. An asking verb is frame only where it is *used* as a verb —
 * and in English the reliable marker of the alternative is a determiner in front of it. "Explain the
 * architecture" is asking; "how does the explain package work" is naming.
 *
 * The two together are the general form of a rule that had previously been extended one word at a time,
 * and every word in both sets is a word of ordinary English rather than of any particular repository.
 */
function framed(token: string, previous: string | undefined, concepts: ReadonlySet<string>): boolean {
  if (concepts.has(token)) {
    return true;
  }

  return ASKING_VERBS.has(token) && !(previous !== undefined && DETERMINERS.has(previous));
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
