import type { RepositoryContext } from '@traceiq/context';

/**
 * Which part of a repository a fact belongs to, before any fact is composed into prose.
 *
 * **This exists because every fact can be true and the architecture still be fiction.** Asked to
 * explain `stripe/ai`, TraceIQ reported a persistence layer of Mongoose, SQLite, Drizzle ORM and
 * PostgreSQL, a stack of Next.js, React, Flask and Express, and a surface exposing
 * `POST /create-checkout-session`, `POST /pay` and `GET /customer/:email/bookings`. Every one of those
 * detections was correct. Mongoose is in `benchmarks/furever/environment`; PostgreSQL and Drizzle are
 * under the two `benchmarks/saas-starter` fixtures; SQLite is under the two `benchmarks/galtee` ones; Flask is in
 * `benchmarks/card-element-to-checkout/environment/server`. They are **four different sample
 * applications**, written to be graded by a benchmark, and no two of them have ever run in the same
 * process. The repository's own code is `llm/ai-sdk`, `llm/token-meter` and three packages under
 * `tools/`, none of which serves an HTTP route at all.
 *
 * Nothing was wrong with the detections. What was missing was the question **"where was this found?"**,
 * asked before the answer was composed. The graph has always recorded the answer: every technology
 * carries the region it was detected in, and every route carries the file it was registered in.
 *
 * **This module is a consolidation as much as an addition.** The knowledge that a directory named
 * `examples` or `benchmarks` demonstrates a repository rather than constitutes it was already in the
 * codebase three times over — `DEMONSTRATION_PATH` in `profile.ts` decided repository type, `GENERATED_PATH`
 * in `importance.ts` decided ranking, and neither reached the technologies, the entry points or the
 * workflows. One vocabulary, in one place, applied everywhere it matters.
 *
 * **The vocabulary is conventional, never repository-specific.** `examples`, `tests`, `benchmarks`,
 * `fixtures`, `vendor`, `generated` mean the same thing in every ecosystem on earth; that is the same
 * trade `CACHING_TECHNOLOGIES` makes when it declares Redis to be a cache. What is *not* here is any
 * name from any repository in the corpus: `stripe/ai` calls its fixture directories `environment` and
 * `solution`, and neither word appears below — they are caught because they sit under `benchmarks/`,
 * which is a convention rather than a name.
 */

export const REGION_ROLES = [
  /** Code the repository is made of. The only role a repository-wide claim may rest on. */
  'production',
  /** Code that shows how to use the repository. Real, runnable, and not part of it. */
  'example',
  /** Code that exercises the repository. */
  'test',
  /** Code that measures the repository, or that a benchmark measures. */
  'benchmark',
  /** Code a tool wrote. */
  'generated',
  /**
   * Someone else's code, kept in tree.
   *
   * `external` was here and was removed on review: a directory named `external` is at least as likely to
   * be a repository's own integration layer as it is to be vendored code, and the cost of the wrong call
   * is erasing production code from the answer.
   */
  'vendored',
  /** Prose, and the site that publishes it. */
  'documentation',
  /**
   * What builds, tests and releases the repository — not what the repository *is*.
   *
   * **The role whose absence caused the whole milestone.** `microsoft/AI` is an umbrella repository of
   * samples whose only analysable code is four Python scripts under `.ci/scripts`. With no `ci` role they
   * were production code, so they were the repository's most important declarations, its only unit, and
   * the answer to every question asked of it — including "what tests should I read first?" and "how does
   * authentication work?", the latter answered from `set_secret.py`. A CI script can be genuinely
   * important to CI and irrelevant to what the repository is for, and nothing in a fan-in count can tell
   * the two apart.
   */
  'ci',
  /** What ships and provisions the running system. */
  'deployment',
  /** Settings, editor state, schema files — read by tools rather than run by the repository. */
  'configuration',
  /**
   * Code written to be copied, as opposed to code written to be called.
   *
   * Distinct from `example` only in the word used; kept apart because a repository whose *whole purpose*
   * is samples is a different kind of thing from a library that ships a few, and the area map needs to be
   * able to say which. See `categoryOf`.
   */
  'sample',
  /** One-off automation a person runs by hand. */
  'script',
  /** Schema evolution: real code the repository runs once per deployment, and not its architecture. */
  'migration',
] as const;

export type RegionRole = (typeof REGION_ROLES)[number];

export interface RegionScope {
  /** The region path; `''` is the repository root. */
  readonly path: string;
  readonly role: RegionRole;
  /** Why this role, in the words of whatever decided it. */
  readonly why: string;
  readonly language: string | null;
  readonly sourceFiles: number;
  /** Whether the region carries a manifest of its own — the strongest signal of an independent unit. */
  readonly packaged: boolean;
}

/**
 * One top-level directory, with what it is and how much of the repository it holds.
 *
 * **The evidence a repository has when it has no code.** `microsoft/AI` yields one analysable region and
 * twelve declarations, all of them CI scripts — so everything downstream that reads declarations described
 * a repository of CI scripts. What it actually *is* is visible one level up: `ai100-samples`,
 * `ai200-architectures`, `ai300-practices`, `submodules`, `AzureDeployment`, `utilities`, `.ci`. The
 * package listing already carried every one of those directories with its file count; nothing read them as
 * a map of the repository.
 *
 * Derived from the packages listing rather than from the filesystem, so it costs nothing and stays inside
 * the boundary: this package reads a `RepositoryContext` and nothing else.
 */
export interface RepositoryArea {
  /** The top-level directory name; `''` for files at the repository root. */
  readonly name: string;
  readonly role: RegionRole;
  readonly files: number;
  readonly declarations: number;
  /** Whether anything under it was analysed deeply enough to yield declarations. */
  readonly analysed: boolean;
}

/**
 * What kind of repository the *shape* says this is, before any declaration is ranked.
 *
 * Deliberately a small vocabulary and deliberately separate from `RepositoryType` in `profile.ts`, which
 * answers a different question from different evidence: that one reads routes, manifests, role
 * annotations and dependency names to decide whether the code is a service or a library; this one reads
 * the top-level directory map to decide whether there is a single coherent codebase here at all.
 *
 * They agree on most repositories and disagree on exactly the ones that matter — a repository of samples
 * whose only code is CI has no `RepositoryType` evidence worth the name, and its area map is unambiguous.
 */
export const REPOSITORY_CATEGORIES = [
  /** One coherent codebase. Whatever `profile.ts` says it is, it is one of them. */
  'codebase',
  /** Several independently packaged units in one tree. */
  'monorepo',
  /** A container for material meant to be read or copied: samples, architectures, walkthroughs. */
  'collection',
  /** Its own code is what builds, ships or provisions something else. */
  'infrastructure',
  /** A tree of pointers to other repositories. */
  'umbrella',
  /** The shape settles nothing. */
  'unknown',
] as const;

export type RepositoryCategory = (typeof REPOSITORY_CATEGORIES)[number];

export interface RepositoryStructure {
  readonly regions: readonly RegionScope[];
  /** The top-level map of the repository, largest first. */
  readonly areas: readonly RepositoryArea[];
  /** What the shape of the tree says this is. Independent of what its declarations rank. */
  readonly category: RepositoryCategory;
  /** Why that category, in words a reader can check against the areas. */
  readonly categoryEvidence: readonly string[];
  /** The regions a repository-wide statement may rest on. */
  readonly production: readonly RegionScope[];
  /** Everything else, with the role that excluded it, so an answer can still name it *as* an example. */
  readonly incidental: readonly RegionScope[];
  /**
   * Whether the production code is one unit or several that do not import one another.
   *
   * `several` is the case that must never be narrated as one runtime: a repository holding four
   * independently packaged applications has four architectures, and describing them as one is the
   * failure this module exists to prevent.
   */
  readonly composition: 'single' | 'several' | 'unknown';
  /** What share of analysed source is production code. Low means most of the repository is a showcase. */
  readonly productionShare: number;
}

/**
 * Which directory names mean which role.
 *
 * **`sample` and `samples` are deliberately absent, and that absence was measured.** Spring PetClinic
 * lives at `src/main/java/org/springframework/samples/petclinic/owner/` — `samples` is part of the Java
 * package name of a real application — so including it discounted all fourteen of PetClinic's owner
 * routes and reported that the repository exposed one. A word that is ordinary vocabulary inside a
 * namespace cannot be used to disqualify what lives under it, and the cross-repository validation holds
 * that line now.
 *
 * **`fixtures` and the compound-segment suffix are both regressions the corpus caught.** Consolidating
 * three scattered patterns into this table dropped `fixtures?`, and React immediately acquired a
 * workflow again — traced through `fixtures/flight/server/global.js`, the little Express server that
 * exists to exercise Flight. Separately, FastAPI kept six route workflows because its example routes live
 * in `docs_src/`, and a pattern anchored on the whole segment does not match a role word carrying a
 * suffix. The optional `[_-]…` tail covers `docs_src`, `test_utils` and `example_app` — snake and kebab
 * compounds of a role word are the same statement about the directory as the bare word is.
 *
 * **`starter`, `template`, `scaffold`, `site`, `perf` and `deps` were tried and removed**, and the
 * compound tail is why. Each is a weak convention on its own, and with a suffix each becomes a plausible
 * production package: `template-engine` in a templating library, `site-config` in a static-site generator,
 * `deps-graph` in a build tool. Erasing a repository's own code from its answer is the worse error of the
 * two, so a word earns its place here only if it is unambiguous with a suffix attached.
 */
const ROLE_WORDS: readonly (readonly [RegionRole, RegExp])[] = [
  ['generated', /(^|\/)\.?(generated|gen|__generated__|\.next|flow-typed|typings|@types)([_-][\w-]+)?(\/|$)/i],
  ['vendored', /(^|\/)\.?(node_modules|vendor|vendored|third_party|thirdparty|submodules?)([_-][\w-]+)?(\/|$)/i],
  /*
   * CI before everything, because CI directories contain everything.
   *
   * `.ci/scripts`, `.github/workflows`, `.azure-pipelines/steps` — each would match `script`, and each is
   * CI. The leading dot is optional in the pattern because the convention is spelt both ways, and the
   * provider names are the ones that appear at a repository root rather than an exhaustive list.
   */
  ['ci', /(^|\/)\.?(ci|github|circleci|gitlab-ci|azure-pipelines|azure_pipelines|travis|jenkins|buildkite|appveyor|woodpecker|drone)([_-][\w-]+)?(\/|$)/i],
  ['benchmark', /(^|\/)\.?(benchmarks?|bench|performance)([_-][\w-]+)?(\/|$)/i],
  ['example', /(^|\/)\.?(examples?|demos?|playground)([_-][\w-]+)?(\/|$)/i],
  ['test', /(^|\/)\.?(tests?|testing|__tests__|spec|specs|testdata|fixtures?|e2e)([_-][\w-]+)?(\/|$)/i],
  ['documentation', /(^|\/)\.?(docs?|website|documentation|images?|assets?|media|screenshots?)([_-][\w-]+)?(\/|$)/i],
  ['deployment', /(^|\/)\.?(deploy|deployment|deployments|infra|infrastructure|terraform|helm|charts?|k8s|kubernetes|ansible|pulumi|cloudformation)([_-][\w-]+)?(\/|$)/i],
  ['migration', /(^|\/)\.?(migrations?|alembic|liquibase|flyway)([_-][\w-]+)?(\/|$)/i],
  ['configuration', /(^|\/)(\.vscode|\.idea|\.devcontainer|\.husky|config|configs|conf)([_-][\w-]+)?(\/|$)/i],
  ['script', /(^|\/)\.?(scripts?|tooling|automation)([_-][\w-]+)?(\/|$)/i],
];

/**
 * Role words that are safe at the top of a repository and unsafe inside a namespace.
 *
 * **`samples` is the whole reason this list is separate.** Spring PetClinic lives at
 * `src/main/java/org/springframework/samples/petclinic/owner/` — `samples` is part of a Java package name
 * — so putting it in `ROLE_WORDS` discounted all fourteen of its owner routes. But `microsoft/AI`'s
 * `ai100-samples`, `ai200-architectures` and `ai300-practices` are top-level directories, and there the
 * word is the repository telling you what it holds.
 *
 * The position is the discriminator. A first path segment is a statement about the repository; the same
 * word six segments deep is somebody's domain vocabulary. Nothing else here changes.
 */
const TOP_LEVEL_ROLE_WORDS: readonly (readonly [RegionRole, RegExp])[] = [
  ['sample', /^(samples?|starters?|templates?|cookbooks?|recipes?|tutorials?|walkthroughs?|labs?|katas?|exercises?)$/i],
  ['sample', /^[\w]+[-_](samples?|architectures?|practices?|tutorials?|examples?|demos?|labs?|walkthroughs?)$/i],
  ['deployment', /^[\w]*[-_]?deployments?$/i],
  ['documentation', /^(wiki|guides?|manual|handbook|articles?|blog|notebooks?)$/i],
];

/** Build output, which is generated whether or not a directory says so. */
const BUILD_OUTPUT = /(^|\/)(dist|build|out|target|lib-esm|coverage)(\/|$)/i;

/**
 * The role of one path.
 *
 * **The first matching word wins, and the order is by how strongly the word disqualifies.** A path such
 * as `benchmarks/furever/environment/tests` is a test inside a benchmark inside a repository, and which
 * of the two it is called changes nothing: neither is production. What matters is only that it is not,
 * so the ordering is chosen to give the most informative label rather than to resolve a conflict.
 *
 * Exported because the same question is asked of a *file* path by the callers that hold files rather
 * than regions — a route's registration file, a declaration's location.
 */
export function roleOfPath(path: string): RegionRole {
  const cleaned = path.replace(/^file:/, '');

  if (BUILD_OUTPUT.test(cleaned)) {
    return 'generated';
  }

  /*
   * The first segment gets its own vocabulary, checked first.
   *
   * A word at the top of a repository is a statement about the repository; the same word inside a package
   * namespace is somebody's domain vocabulary. `AzureDeployment` is matched here as one camel-cased word
   * rather than by splitting it, which is why the pattern allows a prefix.
   */
  const top = cleaned.split('/')[0] ?? '';

  for (const [role, pattern] of TOP_LEVEL_ROLE_WORDS) {
    if (pattern.test(top) || pattern.test(camelSplit(top))) {
      return role;
    }
  }

  for (const [role, pattern] of ROLE_WORDS) {
    if (pattern.test(cleaned)) {
      return role;
    }
  }

  return 'production';
}

/**
 * A camel-cased directory name as separate words, so `AzureDeployment` can match a `deployment` rule.
 *
 * Only used for the top-level vocabulary, where a directory name is a deliberate label rather than a
 * generated path. Applying it everywhere would make `UserDeploymentService.java` a deployment directory.
 */
function camelSplit(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Whether a path is code the repository is made of. */
export function isProductionPath(path: string): boolean {
  return roleOfPath(path) === 'production';
}

/**
 * Structures already derived, by context.
 *
 * The same `WeakMap`-on-the-input pattern `deriveIdentity` uses, for the same reason: one request hands
 * the same context to the architecture summary, the profile, the identity and the planner, and this is
 * arithmetic over data already in memory.
 */
const CACHE = new WeakMap<RepositoryContext, RepositoryStructure>();

export function deriveStructure(context: RepositoryContext): RepositoryStructure {
  const cached = CACHE.get(context);

  if (cached !== undefined) {
    return cached;
  }

  const structure = compose(context);

  CACHE.set(context, structure);

  return structure;
}

function compose(context: RepositoryContext): RepositoryStructure {
  const regions: RegionScope[] = context.capabilities.regions.map((region) => {
    const role = roleOfPath(region.path);

    return {
      path: region.path,
      role,
      why:
        role === 'production'
          ? 'no directory in its path marks it as a demonstration, a test or generated'
          : `its path names a ${role} directory`,
      language: region.primaryLanguage ?? null,
      sourceFiles: region.sourceFileCount,
      packaged: region.ecosystems.length > 0,
    };
  });

  const production = regions.filter((region) => region.role === 'production');
  const incidental = regions.filter((region) => region.role !== 'production');

  /*
   * A repository that is *only* demonstrations is described by them.
   *
   * Reachable, and the safe direction matters: a repository of nothing but examples has an architecture
   * — the examples' — and reporting that it has none would be a worse answer than reporting theirs. The
   * filtering exists to stop a showcase outvoting the code beside it, not to erase a repository that is
   * a showcase.
   */
  const areas = areasOf(context);
  const category = categoryOf(context, areas, regions);

  if (production.length === 0) {
    const structure: RepositoryStructure = {
      regions,
      areas,
      category: category.category,
      categoryEvidence: category.evidence,
      production: regions,
      incidental: [],
      composition: compositionOf(regions),
      productionShare: 1,
    };

    return structure;
  }

  const productionSource = production.reduce((sum, region) => sum + region.sourceFiles, 0);
  const allSource = regions.reduce((sum, region) => sum + region.sourceFiles, 0);

  return {
    regions,
    areas,
    category: category.category,
    categoryEvidence: category.evidence,
    production,
    incidental,
    composition: compositionOf(production),
    productionShare: allSource === 0 ? 0 : Math.round((productionSource / allSource) * 100) / 100,
  };
}

/**
 * The repository's top-level directories, with what each is and how big it is.
 *
 * Built by folding the packages listing up to its first path segment. The listing is the only place the
 * graph records a directory that contains no analysable code — `AzureDeployment/Identity`, `.docs`,
 * `ai300-practices` — and those are precisely the directories a repository of samples is made of.
 *
 * Files at the repository root fold into one area named `''`, which the renderers show as "the repository
 * root": a `README.md` and a `LICENSE` are not an area of a repository, and listing them separately would
 * put five one-file entries at the top of the map.
 */
function areasOf(context: RepositoryContext): readonly RepositoryArea[] {
  if (context.primary.type !== 'repository') {
    return [];
  }

  const held = new Map<string, { files: number; declarations: number }>();

  for (const entry of context.primary.value.overview.packages.entries) {
    const name = entry.name.split('/')[0] ?? '';
    /*
     * A root-level file folds into the root area rather than becoming an area of its own.
     *
     * `LICENSE`, `NOTICE` and `CHANGELOG` carry no extension, and treating them as directories put a
     * one-file area called `LICENSE` in the middle of the repository's map. A top-level entry is a file
     * when it has an extension or is one of the extensionless names the convention spells in capitals.
     */
    /*
     * A root entry holding one file and nothing analysable folds into the root as well.
     *
     * The two patterns above catch `LICENSE` and `config.yml` and miss `.DS_Store`, `.npmrc` and every
     * other dot-prefixed root file — whose only dot is the first character, so neither an extension test
     * nor a capitals test sees one. Rather than enumerate the conventions, this asks what an area *is*:
     * a place with something in it. One file and no declarations is not a part of a repository anyone
     * navigates to, and it was reaching the map, the guidance and the prompt as `.DS_Store (production, 1
     * files)`. A genuine one-file directory is still counted, in the root aggregate.
     */
    const trivial = !entry.name.includes('/') && entry.files <= 1 && entry.declarations === 0;
    const looksLikeFile =
      !entry.name.includes('/') && (/\.[a-z0-9]+$/i.test(entry.name) || /^[A-Z][A-Z0-9_.-]*$/.test(entry.name));
    const key = looksLikeFile || trivial ? '' : name;
    const sum = held.get(key) ?? { files: 0, declarations: 0 };

    sum.files += entry.files;
    sum.declarations += entry.declarations;
    held.set(key, sum);
  }

  return [...held.entries()]
    .map(([name, sum]) => ({
      name,
      role: name === '' ? ('production' as RegionRole) : roleOfPath(name),
      files: sum.files,
      declarations: sum.declarations,
      analysed: sum.declarations > 0,
    }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

/**
 * What the shape of the tree says the repository is.
 *
 * **Read from the areas rather than from the declarations, which is the entire point.** A repository whose
 * every analysable declaration is a CI script is not a CI tool if nine tenths of its directories are
 * samples; it is a collection of samples that happens to have CI. The declarations cannot see that and the
 * area map cannot miss it.
 *
 * Ordered by how strongly the evidence commits. Every branch carries its own evidence line, and the
 * fallthrough is `unknown` rather than a guess — the same discipline `RepositoryType` follows.
 */
function categoryOf(
  context: RepositoryContext,
  areas: readonly RepositoryArea[],
  regions: readonly RegionScope[],
): { readonly category: RepositoryCategory; readonly evidence: readonly string[] } {
  const named = areas.filter((area) => area.name !== '');

  if (named.length === 0) {
    return { category: 'unknown', evidence: [] };
  }

  const files = named.reduce((sum, area) => sum + area.files, 0);
  const share = (roles: readonly RegionRole[]): number =>
    files === 0 ? 0 : named.filter((area) => roles.includes(area.role)).reduce((sum, area) => sum + area.files, 0) / files;

  const describe = (roles: readonly RegionRole[]): string =>
    named
      .filter((area) => roles.includes(area.role))
      .slice(0, 4)
      .map((area) => `${area.name} (${area.role})`)
      .join(', ');

  const productionCode = named
    .filter((area) => area.role === 'production')
    .reduce((sum, area) => sum + area.declarations, 0);

  /*
   * A declared submodule is a statement that part of the repository lives somewhere else.
   *
   * **The only evidence `microsoft/AI` leaves behind, and it is decisive.** Its `ai100-samples`,
   * `ai200-architectures` and `submodules` directories are git submodule mount points: on any clone that
   * did not initialise them they contain zero files, so the scanner correctly sees nothing and the
   * packages listing correctly omits them. What survives is `.gitmodules` — one file, in the listing,
   * saying the repository is a tree of pointers. Without reading it the honest conclusion from the
   * remaining files is "94% CI and deployment", which is true of what was scanned and wrong about the
   * repository.
   *
   * The category it produces carries that caveat rather than hiding it: an umbrella repository's contents
   * were, by construction, not analysed.
   */
  const submodules = areas.some((area) => area.name === '' ) &&
    context.primary.type === 'repository' &&
    context.primary.value.overview.packages.entries.some((entry) => entry.name === '.gitmodules');

  const vendored = share(['vendored']);
  const showcase = share(['sample', 'example', 'documentation']);
  const operational = share(['ci', 'deployment', 'configuration', 'script']);

  /*
   * A tree of pointers is not a codebase.
   *
   * Checked first because a repository made of submodules can look like anything else once the submodules
   * are cloned, and what the analysis actually read is a directory of empty mount points.
   */
  if (productionCode === 0 && (submodules || vendored >= 0.4)) {
    return {
      category: 'umbrella',
      evidence: [
        ...(submodules
          ? ['the repository declares git submodules, so part of it lives in other repositories that this analysis did not read']
          : [`${Math.round(vendored * 100)}% of top-level files are in ${describe(['vendored'])}`]),
        'no top-level directory of the repository’s own code carries a declaration',
      ],
    };
  }

  if (showcase >= 0.4 && productionCode === 0) {
    return {
      category: 'collection',
      evidence: [
        `${Math.round(showcase * 100)}% of top-level files are in ${describe(['sample', 'example', 'documentation'])}`,
        'no top-level directory of the repository’s own code carries a declaration',
      ],
    };
  }

  if (operational >= 0.5 && productionCode === 0) {
    return {
      category: 'infrastructure',
      evidence: [
        `${Math.round(operational * 100)}% of top-level files are in ${describe(['ci', 'deployment', 'configuration', 'script'])}`,
        'no top-level directory of the repository’s own code carries a declaration',
      ],
    };
  }

  const packaged = regions.filter((region) => region.packaged && region.role === 'production');

  if (packaged.length > 1) {
    return {
      category: 'monorepo',
      evidence: [`${packaged.length} separately packaged regions of the repository’s own code`],
    };
  }

  if (productionCode > 0) {
    return {
      category: 'codebase',
      evidence: [`${productionCode} declarations in top-level directories of the repository’s own code`],
    };
  }

  return { category: 'unknown', evidence: ['no top-level directory carries analysed code'] };
}

/**
 * Whether the production regions are one unit or several independent ones.
 *
 * **A manifest is what makes a region independent**, because it is the region declaring its own
 * dependencies — which is the same thing as declaring that it does not get them from a parent. Two or
 * more separately packaged production regions is therefore a repository holding several units, and an
 * answer that narrates them as one runtime is inventing the connection between them.
 *
 * `unknown` where nothing is packaged: a repository with no manifest anywhere has told us nothing about
 * its own boundaries, and guessing `single` there would be the same overreach in the other direction.
 */
function compositionOf(production: readonly RegionScope[]): RepositoryStructure['composition'] {
  const packaged = production.filter((region) => region.packaged);

  if (packaged.length === 0) {
    return 'unknown';
  }

  return packaged.length > 1 ? 'several' : 'single';
}

/**
 * One technology, and whether the repository as a whole may be described by it.
 *
 * The partition is the whole point. `repositoryWide` is what an architecture sentence may rest on;
 * `incidental` is still citable, still true, and may only ever be described **as** what it is — a
 * technology used by an example, in that example.
 */
export interface ScopedTechnologies {
  readonly repositoryWide: readonly ContextTechnologyLike[];
  readonly incidental: readonly (ContextTechnologyLike & { readonly role: RegionRole })[];
}

interface ContextTechnologyLike {
  readonly name: string;
  readonly category: string;
  readonly regionPath: string;
  readonly evidence: string;
}

/**
 * Technologies split by whether they were found in code the repository is made of.
 *
 * A technology detected at the repository root is repository-wide by construction — the root manifest,
 * the Dockerfile, the workflow file are statements about the whole repository. Everything else is
 * attributed to the region it was found in, and a region that is a benchmark or an example cannot lend
 * its stack to the repository.
 *
 * **This is the single change that dissolves the fact soup.** With it, `stripe/ai` has no persistence
 * layer, because none of its own five packages declares one — which is true, and was true before, and
 * was unsayable while a fixture's `mongoose` counted as the repository's.
 */
export function scopedTechnologies(
  context: RepositoryContext,
  structure: RepositoryStructure,
): ScopedTechnologies {
  const roleOf = new Map(structure.regions.map((region) => [region.path, region.role]));

  const repositoryWide: ContextTechnologyLike[] = [];
  const incidental: (ContextTechnologyLike & { readonly role: RegionRole })[] = [];

  for (const technology of context.technologies) {
    // The root is a statement about the repository: its manifest, its Dockerfile, its workflow.
    if (technology.regionPath === '') {
      repositoryWide.push(technology);

      continue;
    }

    // The region's own role where the region is known, and the path's role where it is not — a
    // technology may be attributed to a directory the region list did not enumerate.
    const role = roleOf.get(technology.regionPath) ?? roleOfPath(technology.regionPath);

    if (role === 'production') {
      repositoryWide.push(technology);
    } else {
      incidental.push({ ...technology, role });
    }
  }

  return { repositoryWide, incidental };
}

/**
 * File-naming conventions that mark a test where the language puts tests beside the code.
 *
 * **Directories are not enough, and Go is why.** Go's convention is `router_test.go` in the same
 * directory as `router.go`, so Gin's test routes sit in no directory named for tests: 100 of its 112
 * routes survived a directory filter and Gin was still profiled as a web service. Java, Python, Ruby
 * and JavaScript each have their own spelling of the same convention, and all of them are in the file
 * path the graph already holds.
 */
const DEMONSTRATION_FILE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(go|py|rb)|[^/]+Tests?\.(java|kt|cs)|[^/]+\.(test|spec)\.[jt]sx?)$/i;

/**
 * Routes the repository actually serves, as opposed to routes its tests, examples and fixtures declare.
 *
 * **This is what separates a framework from a service, and nothing else in the graph does.** Flask's
 * repository yields 134 routes and Gin's 112 — every one real, extracted from real decorators and real
 * handler registrations, and every one inside a test or an example. Counting them made the two
 * best-known micro-frameworks in Python and Go into web services.
 *
 * It lived in `profile.ts`, where it decided repository *type* and nothing else. Every other consumer of
 * routes — the entry points, the workflows, the route groups — counted all of them, which is how
 * `stripe/ai` came to expose a checkout surface it does not have. Moved here so there is one answer to
 * "does the repository serve this route".
 *
 * A route whose file cannot be named is **kept**: absence of evidence is not evidence, and the safe
 * direction is to believe a route is real.
 */
export function ownRoutes(context: RepositoryContext): RepositoryContext['routes'] {
  /*
   * Answered once, not once per route.
   *
   * "Could this repository have registered a route at all" is a property of the repository, and FastAPI
   * has 598 of them — evaluating it inside the filter meant rebuilding the region map six hundred times
   * per call, five times per request.
   */
  let serves: boolean | null = null;

  return context.routes.filter((route) => {
    const entry = route as {
      readonly node?: { readonly fileId?: unknown };
      readonly handlers?: readonly { readonly declaration?: { readonly id?: unknown } | null }[];
    };

    /*
     * The route's own file, and failing that its handlers'.
     *
     * **Two sources because the first is frequently absent, which was the second root cause of the
     * `stripe/ai` failure.** Filtering on the registration file alone removed the persistence soup and
     * left the routes: eleven of `stripe/ai`'s sixteen route nodes carry `fileId: null`, so every one of
     * them was kept by the rule that absence of evidence is not evidence — and the repository still
     * reported a checkout surface. The handler declarations were sitting right there with
     * `sym:benchmarks/galtee-basic/solution/server.js#...` in their identifiers.
     *
     * The safe direction is unchanged: a route with neither a file nor a linked handler is still kept,
     * because then there genuinely is no evidence either way.
     */
    const paths: string[] = [];

    if (typeof entry.node?.fileId === 'string') {
      paths.push(entry.node.fileId.replace(/^file:/, ''));
    }

    for (const handler of entry.handlers ?? []) {
      const id = handler.declaration?.id;

      if (typeof id === 'string') {
        // `sym:path/to/file.ts#Declaration` — the path is everything between the prefix and the chain.
        paths.push(id.slice(id.indexOf(':') + 1).split('#')[0] ?? '');
      }
    }

    /*
     * No file, no handler — so the question becomes whether the repository could have registered it.
     *
     * **The third root cause, and it is a graph limitation rather than a rule.** The graph merges route
     * nodes by method and path: `stripe/ai`'s `GET /` is one node "materialised from 4 framework
     * registration(s)" across four different sample applications, with `fileId: null` and no linked
     * handler, because there is no single file to name. Five of its sixteen routes are like this, and the
     * "absence of evidence is not evidence" rule kept every one — so the repository still reported a
     * payment surface after both of the other fixes.
     *
     * What settles it is a different fact entirely: **a route needs a framework to register it.** If no
     * production region declares a backend framework, then nothing in the repository's own code could
     * have registered this route, and the registrations the graph merged must all have come from the
     * demonstrations. That is an inference from an absence, which this codebase does sparingly — and it
     * is sound here because the absence is measured: the detector examined every production manifest and
     * found no server framework in any of them.
     *
     * Where a production region *does* declare one, the route is kept, and Flask, Gin, LinkForge and
     * PetClinic are unaffected.
     */
    if (paths.length === 0) {
      serves ??= couldServeRoutes(context);

      return serves;
    }

    // Every piece of evidence must agree the route is the repository's own. One handler inside a
    // fixture is enough to say the route belongs to the fixture.
    return paths.every((path) => path !== '' && isProductionPath(path) && !DEMONSTRATION_FILE.test(path));
  });
}

/**
 * Whether any of the repository's own code declares something that registers routes.
 *
 * Deliberately narrow: it asks only whether a **backend framework** was detected in a production region
 * or at the repository root. It is used for exactly one decision — whether to believe an unattributed
 * route — and a false negative there costs a route the answer does not mention, while a false positive
 * costs the fictional architecture this whole module exists to prevent.
 */
function couldServeRoutes(context: RepositoryContext): boolean {
  const { repositoryWide } = scopedTechnologies(context, deriveStructure(context));

  return repositoryWide.some((technology) => technology.category === 'backend');
}
