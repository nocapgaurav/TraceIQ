import type { RepositoryContext } from '@traceiq/context';

import type { ArchitectureSummary } from './architecture.js';
import { rankComponents, topDeclarations, topPackages, type ComponentImportance } from './importance.js';
import { deriveProfile, type Evidenced, type RepositoryProfile } from './profile.js';
import { deriveStructure, roleOfPath, type RegionRole, type RepositoryArea, type RepositoryCategory } from './structure.js';
import { workflowsOf, type Workflow } from './workflow.js';

/**
 * What the repository is *for*, as far as the graph can establish it.
 *
 * **The profile answers "what kind of thing is this"; this answers "what is it trying to accomplish".**
 * The distinction is the milestone. A profile that says `service, medium, layered, backend-heavy` is a
 * correct description of a shape, and a reader who is handed it still does not know that the service
 * shortens URLs. An identity says the repository is organised around `url` and `analytics`, that a
 * request to `GET /:shortCode` reaches `redirectController`, and that `PrismaUrlRepository` is the most
 * referenced declaration in it — and those three sentences are what a senior engineer would open with.
 *
 * **Nothing here is guessed, and the fields that cannot be proven are absent rather than filled.** The
 * type is `Evidenced<T> | null` throughout for exactly that reason: a repository with no detected cache
 * has `caching: null`, not `caching: 'none detected'`, because the second is a claim about the
 * repository and the first is a statement about the analysis. Purpose and users are the two fields most
 * tempting to invent, so both are **composed from evidenced parts** — a category, a domain, a route
 * surface — and neither is ever free text.
 *
 * **Derived once per context.** Everything below reads the same `RepositoryContext` the projection
 * reads and calls no capability, so it is arithmetic over data already in memory; the `WeakMap` is what
 * keeps that arithmetic from being repeated four times in one request. See `deriveIdentity`.
 */

export interface RepositoryIdentity {
  /** The shape, reused rather than re-derived. */
  readonly profile: RepositoryProfile;
  /**
   * What the top-level map of the repository says it is, independent of what its declarations rank.
   *
   * **Carried beside `profile.type` rather than replacing it, because the two answer different questions
   * from different evidence.** The type reads routes, manifests and role annotations to decide whether the
   * code is a service or a library; this reads the directory map to decide whether there is one coherent
   * codebase here at all. They agree on ordinary repositories. On an umbrella of git submodules whose only
   * analysable code is four CI scripts, the type is `unknown` and this is `umbrella` — and the second is
   * the one a reader needs.
   */
  readonly category: RepositoryCategory;
  readonly categoryEvidence: readonly string[];
  /** The repository's top-level directories, each with its semantic role and size. */
  readonly areas: readonly RepositoryArea[];
  /** What the repository does, composed from its category, its domains and its surface. */
  readonly purpose: Evidenced<string> | null;
  /** Who or what consumes it. A property of the category, stated as such. */
  readonly users: Evidenced<string> | null;
  /** The business domains it is organised around, most-evidenced first. */
  readonly domains: readonly DomainIdentity[];
  /** What happens when it does its job. Empty where no evidence supports one. */
  readonly workflows: readonly Workflow[];
  /** Everything rankable, ordered. The full list; consumers take what they can afford. */
  readonly components: readonly ComponentImportance[];
  /** The highest-ranked declarations — "the important components". */
  readonly critical: readonly ComponentImportance[];
  /** The highest-ranked units — where to start reading. */
  readonly units: readonly ComponentImportance[];
  /**
   * Components ranked *within* each non-production role that has any, so a question can reach them.
   *
   * **The other half of "semantic role is not importance".** `components`, `critical` and `units` are the
   * repository's own code, which is right for every question about what the repository *is* — and leaves
   * a question about CI, deployment or tests with nothing, because those declarations were correctly
   * excluded from the architecture. Each role is ranked against its own peers, so "the most prominent CI
   * script" means something rather than being the lowest-scoring entry in a list of controllers.
   *
   * Computed only for roles that actually carry declarations, so an ordinary application pays for nothing.
   */
  readonly byRole: Readonly<Partial<Record<RegionRole, readonly ComponentImportance[]>>>;
  /** Where control enters: routes, or the units nothing else imports. */
  readonly entryPoints: Evidenced<readonly string[]> | null;
  readonly persistence: Evidenced<readonly string[]> | null;
  readonly caching: Evidenced<readonly string[]> | null;
  /** Packages the repository reaches outside itself, by name. */
  readonly integrations: Evidenced<readonly string[]> | null;
  /** What guards the surface: auth middleware, and the secrets configuration names. */
  readonly security: Evidenced<readonly string[]> | null;
  readonly deployment: Evidenced<readonly string[]> | null;
  readonly testing: Evidenced<readonly string[]> | null;
  /**
   * The test files worth opening, with what each appears to exercise.
   *
   * **Distinct from `testing`, which names the frameworks.** A reader asking what to read first wants
   * paths, and the only test evidence that used to exist anywhere in this layer was a count. Ordered so
   * the tests whose subject the analysis could identify come first — see `testsOf`.
   */
  readonly tests: Evidenced<readonly string[]> | null;
  readonly configuration: Evidenced<readonly string[]> | null;
  /** Where someone else's code plugs in. */
  readonly extensionPoints: Evidenced<readonly string[]> | null;
  /** What a reader should understand before anything else. */
  readonly abstractions: Evidenced<readonly string[]> | null;
  /**
   * Documentation the repository ships, with what each document covers.
   *
   * **A repository telling a reader where to start, in its own words** — which is the strongest onboarding
   * evidence there is and the only kind this layer had none of. The scanner records a README's path, and
   * artefact analysis now records its headings and the files it links to, so this can name a document *and*
   * say what it is about without any of its prose being read.
   */
  readonly documentation: Evidenced<readonly string[]> | null;
  /**
   * What a reader can actually start from, each with the kind of evidence behind it.
   *
   * **Separate from `critical` and `units`, and that separation is the whole of §4.** Those two are ranked
   * by fan-in, route ownership and coupling, which measures how much of the repository points at a thing —
   * and the most-pointed-at declaration is the *worst* possible first file, because it is referenced by
   * everything precisely because it assumes everything. This list is ordered by what a reader can absorb
   * at each point, and every entry names why it qualifies, so a recommendation can be defended rather than
   * asserted.
   *
   * Empty is a real and common answer. A repository with no documentation, no manifest entry point and no
   * route has not told anybody where to start, and the planner reports that instead of substituting a
   * ranking — see `sufficiencyOf`.
   */
  readonly onboarding: readonly OnboardingStep[];
  /** What the health analysis found worth flagging. */
  readonly risks: Evidenced<readonly string[]> | null;
}

/**
 * What kinds of evidence may put something on a reader's path into a repository.
 *
 * A closed vocabulary, ordered from what the repository *states* to what its structure *implies*. Nothing
 * derived from a ranking is here, deliberately: the milestone's rule is that a file must not be recommended
 * because it ranks highly, and the way to hold that line is for rank not to be an admissible kind.
 */
export const ONBOARDING_KINDS = [
  /** Prose the repository ships, and the files it links to. The repository's own words. */
  'documentation',
  /** A `main`, a `bin`, an `exports` — an entry point a manifest declares. */
  'manifest-entry-point',
  /** A route the repository serves, or a unit nothing else imports. */
  'control-entry',
  /** A unit the repository packages separately, which is it declaring its own boundary. */
  'package-boundary',
  /** A workflow the analysis could trace end to end. */
  'workflow',
] as const;

export type OnboardingKind = (typeof ONBOARDING_KINDS)[number];

export interface OnboardingStep {
  readonly kind: OnboardingKind;
  /** What to read, as the graph names it. */
  readonly target: string;
  /** Why this qualifies, in words a reader can check against the facts. */
  readonly why: string;
}

export interface DomainIdentity {
  readonly name: string;
  /** How strongly the repository is organised around it, relative to its other domains. */
  readonly weight: number;
  readonly stars: number;
  /** The declarations that carry it, ranked. */
  readonly members: readonly string[];
  readonly evidence: readonly string[];
}

/**
 * Who consumes each kind of repository.
 *
 * **A property of the category, not a discovery about this repository** — the same trade
 * `CATEGORY_RESPONSIBILITY` makes in `architecture.ts`, for the same reason and with the same honesty.
 * That a library is consumed by other programs is true of every library; it is general knowledge, not a
 * claim the graph is being asked to support. What *is* repository-specific — that this library is
 * consumed over HTTP, or by a build step — would be a claim, and is not made.
 */
const CATEGORY_USERS: Readonly<Record<string, string>> = {
  application: 'people using it through its own interface, and programs calling its routes',
  service: 'other programs, over its HTTP surface',
  framework: 'engineers building applications on top of it',
  library: 'other programs that import it',
  sdk: 'programs integrating with the service it wraps',
  cli: 'people running it from a shell',
  infrastructure: 'the engineers who deploy and operate the system it describes',
  compiler: 'the toolchains and engineers that feed source through it',
  monorepo: 'the teams that own its separate units',
  tooling: 'engineers running it over their own code',
};

/** How many of each ranked list an identity carries. Consumers take fewer; none take more. */
const CRITICAL_LIMIT = 8;
const UNIT_LIMIT = 8;
const DOMAIN_LIMIT = 6;

/**
 * Derivations already performed, by context.
 *
 * **A `WeakMap` rather than a cache with a key, because the identity of the input *is* the key.** One
 * request builds one `RepositoryContext` and hands the same object to the projection, the strategy and
 * the planner; without this, ranking React's 141 packages and 120 hotspots would happen four times for
 * one answer. Keyed weakly so a context that goes out of scope takes its identity with it — nothing
 * here should keep a 4 MB context alive.
 *
 * This is the whole of the caching, and it is deliberately modest: identity derivation is arithmetic
 * over data the context already holds, so the thing worth not repeating is the arithmetic. Caching
 * across requests belongs to the layer that owns the graph — which already caches its reads — and
 * would mean holding a derived object against a database this package cannot see.
 */
const CACHE = new WeakMap<RepositoryContext, RepositoryIdentity>();

export function deriveIdentity(context: RepositoryContext): RepositoryIdentity {
  const cached = CACHE.get(context);

  if (cached !== undefined) {
    return cached;
  }

  const identity = compose(context);

  CACHE.set(context, identity);

  return identity;
}

function compose(context: RepositoryContext): RepositoryIdentity {
  const profile = deriveProfile(context);
  const architecture = profile.architecture;
  const components = rankComponents(context);
  const critical = topDeclarations(components, CRITICAL_LIMIT);
  const units = topPackages(components, UNIT_LIMIT);
  const workflows = workflowsOf(context);
  const domains = domainsOf(profile, components);

  const list = (values: readonly string[], evidence: readonly string[]): Evidenced<readonly string[]> | null =>
    values.length === 0 ? null : { value: values, evidence };

  const technologyNames = (entries: readonly { readonly name: string }[]): readonly string[] =>
    entries.map((entry) => entry.name);

  const structure = deriveStructure(context);

  return {
    profile,
    category: structure.category,
    categoryEvidence: structure.categoryEvidence,
    areas: structure.areas,
    purpose: purposeOf(profile, domains, architecture),
    users:
      profile.type.value === 'unknown'
        ? null
        : {
            value: CATEGORY_USERS[profile.type.value] ?? '',
            evidence: [`it is ${profile.type.value === 'application' ? 'an' : 'a'} ${profile.type.value}`],
          },
    domains,
    workflows,
    components,
    critical,
    units,
    byRole: rankedByRole(context),
    entryPoints: entryPointsOf(architecture, units),
    persistence: list(technologyNames(architecture.persistence), ['detected from the manifest and the source']),
    caching: list(technologyNames(architecture.cache), ['detected from the manifest and the source']),
    integrations: integrationsOf(context),
    security: securityOf(architecture),
    deployment: list(technologyNames(architecture.infrastructure), ['detected from build and deployment files']),
    testing: list(technologyNames(architecture.testing), ['detected from the manifest']),
    tests: list(
      architecture.testFiles.slice(0, 8).map((test) => test.path),
      architecture.testFiles.length === 0
        ? []
        : [
            `${architecture.testFiles.length} test files the repository's own code declares; ${
              architecture.testFiles.filter((test) => test.covers.length > 0).length
            } have a subject the analysis could identify by name`,
          ],
    ),
    configuration: list(architecture.configuration.slice(0, 12), [
      `${architecture.configuration.length} environment variables are read`,
    ]),
    extensionPoints: extensionPointsOf(profile),
    abstractions: abstractionsOf(critical),
    risks: risksOf(context),
    documentation: documentationOf(context),
    onboarding: onboardingOf(context, { units, workflows, structure }),
  };
}

/** The artefact digests the overview carries, or nothing where no repository overview was supplied. */
function digestsOf(context: RepositoryContext): readonly ArtifactDigestLike[] {
  if (context.primary.type !== 'repository') {
    return [];
  }

  const overview = context.primary.value.overview as { readonly keyArtifacts?: { readonly entries?: readonly ArtifactDigestLike[] } };

  return overview.keyArtifacts?.entries ?? [];
}

/**
 * One artefact digest, as this module reads it.
 *
 * Declared structurally rather than imported from the Explorer, for the reason nothing in this package
 * imports a `@traceiq` module: the boundary is what makes it provable that repository intelligence does not
 * leak up here. The context carries the data; this states the shape it reads.
 */
interface ArtifactDigestLike {
  readonly path: string;
  readonly kind: string;
  readonly names: readonly string[];
  readonly reaches: readonly { readonly type: string; readonly path: string }[];
}

/** Documentation the repository ships, with the sections each document declares. */
function documentationOf(context: RepositoryContext): Evidenced<readonly string[]> | null {
  const documents = digestsOf(context).filter((digest) => digest.kind === 'documentation');

  if (documents.length === 0) {
    return null;
  }

  return {
    value: documents.slice(0, 6).map((digest) => digest.path),
    evidence: documents.slice(0, 3).map((digest) => {
      const headings = digest.names
        .filter((name) => name.startsWith('heading '))
        .map((name) => name.slice('heading '.length));

      return `${digest.path}${headings.length === 0 ? ' — no headings were extracted' : ` covers ${headings.slice(0, 5).join('; ')}`}`;
    }),
  };
}

/**
 * The path into the repository, ordered by what a reader can absorb rather than by what ranks.
 *
 * **The `critical` list is deliberately absent, and its absence is the fix.** Asked what to read first about
 * an umbrella repository, the pipeline used to answer with the most-referenced declaration — a CI script
 * that stores a secret — because that is what fan-in ranked. The measurement was right and the
 * recommendation was wrong, and no amount of prompting fixes a route assembled from the wrong list.
 *
 * Each step carries the *kind* of evidence behind it, so an answer can say why it recommends something and
 * the entailment guard can check that a recommendation had any evidence at all.
 */
function onboardingOf(
  context: RepositoryContext,
  parts: {
    readonly units: readonly ComponentImportance[];
    readonly workflows: readonly Workflow[];
    readonly structure: ReturnType<typeof deriveStructure>;
  },
): readonly OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  const digests = digestsOf(context);

  for (const digest of digests) {
    if (digest.kind !== 'documentation' || steps.length >= ONBOARDING_LIMIT) {
      continue;
    }

    const headings = digest.names
      .filter((name) => name.startsWith('heading '))
      .map((name) => name.slice('heading '.length));

    steps.push({
      kind: 'documentation',
      target: digest.path,
      why:
        headings.length === 0
          ? 'documentation the repository ships'
          : `documentation the repository ships, covering ${headings.slice(0, 4).join('; ')}`,
    });

    // The files a document links to are the ones it is telling a reader about, which is a stronger
    // statement about where to start than anything the graph's own structure can make.
    for (const reach of digest.reaches) {
      if (reach.type === 'DOCUMENTS' && steps.length < ONBOARDING_LIMIT) {
        steps.push({
          kind: 'documentation',
          target: reach.path,
          why: `linked from ${digest.path}, so the repository's own documentation points at it`,
        });
      }
    }
  }

  for (const digest of digests) {
    if (digest.kind !== 'package-manifest' || steps.length >= ONBOARDING_LIMIT) {
      continue;
    }

    for (const name of digest.names) {
      // Only the manifest's declared entry points. A script target is how to *run* the repository rather
      // than where to start reading it.
      if (steps.length >= ONBOARDING_LIMIT || !/^setting (main|module|types|bin|exports):/.test(name)) {
        continue;
      }

      const declared = name.replace(/^setting \w+:\s*/, '');
      const directory = digest.path.includes('/') ? digest.path.slice(0, digest.path.lastIndexOf('/')) : '';
      const target = declared.startsWith('.')
        ? [directory, declared.replace(/^\.\//, '')].filter((part) => part !== '').join('/')
        : declared;

      /*
       * An entry point into a build output is not a place to start reading, and skipping it was measured.
       *
       * Every published package in a monorepo declares `main: ./dist/index.js`, so an onboarding route
       * assembled from manifests recommended a compiled bundle — twice, once per package — as the second
       * thing a new engineer should open. The manifest is not wrong: `dist/index.js` genuinely is where the
       * package is entered *at runtime*. It is the wrong answer to a question about reading, and
       * `roleOfPath` already knows a build directory when it sees one.
       */
      if (roleOfPath(target) === 'generated') {
        continue;
      }

      steps.push({
        kind: 'manifest-entry-point',
        target,
        why: `declared as an entry point by ${digest.path}`,
      });
    }
  }

  const identityEntries = entryPointsOf(deriveProfile(context).architecture, parts.units);

  if (identityEntries !== null) {
    for (const entry of identityEntries.value) {
      if (steps.length < ONBOARDING_LIMIT) {
        steps.push({
          kind: 'control-entry',
          target: entry,
          why: identityEntries.evidence[0] ?? 'where control enters the repository',
        });
      }
    }
  }

  /*
   * A separately packaged unit is the repository declaring its own boundary.
   *
   * Admissible where a *ranking* is not, and the difference is what the evidence says. That a directory
   * carries its own manifest is a statement the repository made; that a declaration has the highest fan-in
   * is a measurement of the graph. The `why` states which of the two this is, so an answer built on it can
   * be read for what it is worth.
   */
  for (const region of parts.structure.production) {
    if (region.packaged && region.path !== '' && steps.length < ONBOARDING_LIMIT) {
      steps.push({
        kind: 'package-boundary',
        target: region.path,
        why: 'the repository packages this directory separately, declaring it as a unit of its own',
      });
    }
  }

  const workflow = parts.workflows[0];

  if (workflow !== undefined && steps.length < ONBOARDING_LIMIT) {
    steps.push({
      kind: 'workflow',
      target: workflow.name,
      why: 'the one thing the analysis could trace end to end, once the parts have names',
    });
  }

  return diversified(steps);
}

/**
 * How many steps a route may hold. Beyond this a reader is being handed a listing again.
 *
 * `ONBOARDING_PER_KIND` is the more important of the two. A repository with a README, a graph
 * specification, a progress log and four package READMEs produced a four-step route of nothing but
 * documents — every step admissible, and the whole thing one instruction repeated: "read the docs". A route
 * is only a route if its steps differ, so each kind of evidence contributes at most twice and the rest
 * follow behind.
 */
const ONBOARDING_LIMIT = 8;
const ONBOARDING_PER_KIND = 2;

/**
 * The steps reordered so the first few differ in kind, without dropping any.
 *
 * A stable partition rather than a sort: the first two of each kind keep their order at the front, and
 * everything beyond a kind's second entry follows behind in its original order. So a reader given four
 * steps gets documentation, then an entry point, then a boundary — and a caller that wants the whole list
 * still has it.
 */
function diversified(steps: readonly OnboardingStep[]): readonly OnboardingStep[] {
  const seen = new Map<OnboardingKind, number>();
  const lead: OnboardingStep[] = [];
  const rest: OnboardingStep[] = [];

  for (const step of steps) {
    const taken = seen.get(step.kind) ?? 0;

    seen.set(step.kind, taken + 1);
    (taken < ONBOARDING_PER_KIND ? lead : rest).push(step);
  }

  return [...lead, ...rest].slice(0, ONBOARDING_LIMIT);
}

/**
 * What the repository is trying to accomplish, in one sentence assembled from evidenced parts.
 *
 * **Assembled, never written.** Each clause is a field that already carries its own evidence — the
 * category from the type rules, the domains from the layer agreement, the surface from the route
 * groups — and the sentence is the concatenation. That is why it can be cited: every clause in it is
 * defensible on its own, and a clause whose evidence is missing simply does not appear.
 *
 * It stops short of naming a product. A repository organised around `url` with a redirect route is a
 * URL shortener, and that conclusion belongs to the reader — the same line `architecture.ts` draws for
 * capabilities, held here because this is the sentence most likely to be quoted back as fact.
 */
function purposeOf(
  profile: RepositoryProfile,
  domains: readonly DomainIdentity[],
  architecture: ArchitectureSummary,
): Evidenced<string> | null {
  if (profile.type.value === 'unknown' && domains.length === 0) {
    return null;
  }

  const clauses: string[] = [];
  const evidence: string[] = [];

  if (profile.type.value !== 'unknown') {
    clauses.push(`${/^[aeiou]/i.test(profile.type.value) ? 'an' : 'a'} ${profile.type.value}`);
    evidence.push(...profile.type.evidence);
  }

  if (domains.length > 0) {
    const named = domains.slice(0, 3).map((domain) => domain.name);

    clauses.push(`organised around ${named.join(', ')}`);
    evidence.push(...domains.slice(0, 3).flatMap((domain) => domain.evidence.slice(0, 1)));
  }

  if (architecture.routeGroups.length > 0) {
    const surface = architecture.routeGroups
      .slice(0, 3)
      .map((group) => group.prefix)
      .join(', ');

    clauses.push(`exposing ${surface}`);
    evidence.push(`route groups ${surface}, e.g. ${architecture.routeGroups[0]?.example ?? ''}`);
  } else if (profile.units.length > 0) {
    clauses.push(`built from ${profile.units.slice(0, 3).join(', ')}`);
    evidence.push(`the largest units by declaration count`);
  }

  return clauses.length === 0 ? null : { value: clauses.join(', '), evidence };
}

/**
 * The domains, weighted by how much of the repository's important code carries them.
 *
 * **The weight is what makes this more than the profile's domain list.** The profile says
 * authentication is present; this says authentication is the third most significant thing this
 * repository does, because the declarations naming it rank lower than the ones naming `url`. That
 * ordering comes from `rankComponents`, so it is the same measured fan-in and route ownership the rest
 * of the identity rests on rather than a second opinion about significance.
 */
function domainsOf(
  profile: RepositoryProfile,
  components: readonly ComponentImportance[],
): readonly DomainIdentity[] {
  const capabilities = profile.architecture.capabilities;

  if (capabilities.length === 0) {
    // No two role layers agreed on a noun. The profile's domain claims still stand — they rest on
    // routes, environment variables and detections — but they carry no members to weigh.
    return profile.domains.slice(0, DOMAIN_LIMIT).map((claim) => ({
      name: claim.domain,
      weight: 0,
      stars: 1,
      members: [],
      evidence: claim.evidence,
    }));
  }

  const scoreOf = new Map(components.map((component) => [component.name, component.score]));

  /*
   * The **sum** of the members' scores, not the best of them.
   *
   * Taking the best looked right and measured nothing. Every controller in a repository handles a
   * comparable number of routes and carries the same role, so every controller normalises to very
   * nearly 1.0 — and a domain's weight became "does this domain have a controller", which every domain
   * does. LinkForge ranked `analytics` above `url` on an alphabetical tie-break, with the fan-in that
   * actually separates them (40 references against 12) discarded before the comparison.
   *
   * Summing is also what the field claims to measure: how much of the repository's important code
   * carries this domain. A domain with a saturated controller, a heavily-referenced service and a
   * repository outweighs one with a saturated controller and two quiet members, which is the ordering
   * a reader wants and the one the graph supports.
   */
  const totals = capabilities.map((capability) =>
    capability.members.reduce((sum, member) => sum + (scoreOf.get(member) ?? 0), 0),
  );
  const peak = Math.max(...totals, 0);

  const weighted = capabilities.map((capability, index) => {
    // Normalised against the strongest domain in this repository, for the same reason component scores
    // are: a total of 2.8 means nothing until it is compared with the largest total here.
    const weight = peak === 0 ? 0 : (totals[index] ?? 0) / peak;

    return {
      name: capability.noun,
      weight: Math.round(weight * 1000) / 1000,
      stars: starsFor(weight),
      members: [...capability.members].sort(
        (left, right) => (scoreOf.get(right) ?? 0) - (scoreOf.get(left) ?? 0) || left.localeCompare(right),
      ),
      evidence: [`named in ${capability.layers.join(' and ')} declarations: ${capability.members.join(', ')}`],
    };
  });

  return weighted
    .sort((left, right) => right.weight - left.weight || left.name.localeCompare(right.name))
    .slice(0, DOMAIN_LIMIT);
}

function starsFor(weight: number): number {
  if (weight >= 0.75) {
    return 5;
  }

  if (weight >= 0.5) {
    return 4;
  }

  if (weight >= 0.3) {
    return 3;
  }

  if (weight >= 0.15) {
    return 2;
  }

  return 1;
}

/**
 * Where control enters.
 *
 * Routes where there are routes — a request from outside is the least ambiguous entry there is. Where
 * there are none, the units **nothing else imports**: a package with dependents is reached from inside
 * the repository, so a package with none is either an entry point or dead, and the graph cannot tell
 * those apart. The field says which claim it is making.
 */
function entryPointsOf(
  architecture: ArchitectureSummary,
  units: readonly ComponentImportance[],
): Evidenced<readonly string[]> | null {
  /*
   * The route groups are already scoped to the repository's own routes.
   *
   * Worth stating here because this field is the one that reached a reader most directly: asked what
   * `stripe/ai` exposes, the identity answered with `POST /create-checkout-session`,
   * `GET /customer/:email/bookings` and `POST /pay` — three routes from three unrelated benchmark
   * fixtures, presented as one surface. `summariseArchitecture` now groups only `ownRoutes`, so a
   * repository whose every route lives in a fixture correctly falls through to the unimported-unit
   * branch below.
   */
  if (architecture.routeGroups.length > 0) {
    return {
      value: architecture.routeGroups.slice(0, 6).map((group) => group.example),
      evidence: [`${architecture.routeCount} routes the repository's own code registers`],
    };
  }

  const unimported = units.filter((unit) =>
    unit.signals.every((signal) => signal.signal !== 'dependents' || signal.value === 0),
  );

  return unimported.length === 0
    ? null
    : {
        value: unimported.slice(0, 6).map((unit) => unit.name),
        evidence: ['no other package in the repository imports these; they are entry points or unused'],
      };
}

/** External packages the repository actually reaches, which is what an integration is. */
function integrationsOf(context: RepositoryContext): Evidenced<readonly string[]> | null {
  const names = context.dependencies.externalPackages
    .map((node) => (typeof node.externalName === 'string' ? node.externalName : node.name))
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .filter((name) => !name.startsWith('.'));

  const distinct = [...new Set(names)].sort();

  return distinct.length === 0
    ? null
    : {
        value: distinct.slice(0, 12),
        evidence: [`${distinct.length} external packages are referenced from the source`],
      };
}

/**
 * What guards the surface.
 *
 * Two independent kinds of evidence, and the field appears only if one of them exists: middleware
 * declarations whose names are about authentication or authorisation, and the environment variables
 * that name a secret. Neither is a claim that the repository is *secure* — that is a judgement the
 * graph cannot make and this does not attempt.
 */
function securityOf(architecture: ArchitectureSummary): Evidenced<readonly string[]> | null {
  const guard = /(auth|login|logout|session|token|jwt|oauth|permission|role|guard|cors|helmet|csrf|rbac|secure)/i;

  const middleware =
    architecture.layers
      .find((layer) => layer.role === 'Middleware')
      ?.members.filter((member) => guard.test(member)) ?? [];

  const secrets = architecture.configuration.filter((name) => /(secret|token|key|password|credential|jwt|auth)/i.test(name));

  /*
   * A secret-shaped variable name is not, on its own, an access-control mechanism.
   *
   * **The failure this closes is the milestone's own example.** One validated repository reads nine
   * variables whose names contain `SECRET`, `KEY` or `TOKEN` — payment credentials and model-provider
   * credentials, every one of them read inside a benchmark fixture — and this field reported all nine as
   * "what guards the surface", on a repository that exposes no surface at all. A credential the code
   * *sends* is not a guard the code *applies*, and the difference is invisible to a name.
   *
   * Middleware named for access control is direct evidence and stands alone: a declaration annotated
   * `Middleware` and called `requireAuth` is a guard, whatever else is true. Secrets are only ever
   * corroborating, so they are reported only where there is a surface for them to be guarding —
   * meaning the repository's own code registers at least one route. Where neither holds, the field is
   * `null`, and the honest consequence is that an authentication question is answered with "the
   * analysis does not establish one".
   */
  const guarded = middleware.length > 0;
  const hasSurface = architecture.routeCount > 0;

  if (!guarded && !(secrets.length > 0 && hasSurface)) {
    return null;
  }

  const reported = guarded ? [...middleware, ...(hasSurface ? secrets : [])] : secrets;

  return {
    value: reported,
    evidence: [
      ...(guarded ? [`middleware named for access control: ${middleware.join(', ')}`] : []),
      ...(hasSurface && secrets.length > 0
        ? [`environment variables naming a secret, on a repository that serves ${architecture.routeCount} of its own routes: ${secrets.join(', ')}`]
        : []),
    ],
  };
}

/** The packages someone else's code plugs into, taken from the trait that already proved it. */
function extensionPointsOf(profile: RepositoryProfile): Evidenced<readonly string[]> | null {
  const claim = profile.traits.find((trait) => trait.trait === 'plugin-oriented');

  if (claim === undefined) {
    return null;
  }

  return {
    value: profile.units.filter((unit) => /(plugin|preset|adapter|loader|extension)/i.test(unit)).slice(0, 8),
    evidence: claim.evidence,
  };
}

/**
 * What to understand first.
 *
 * The top-ranked declarations, restated as abstractions rather than as a leaderboard: a reader asking
 * "what are the important concepts" wants the names plus *why each one is important*, and the signals
 * already carry that.
 */
function abstractionsOf(critical: readonly ComponentImportance[]): Evidenced<readonly string[]> | null {
  if (critical.length === 0) {
    return null;
  }

  return {
    value: critical.slice(0, 5).map((component) => component.name),
    evidence: critical
      .slice(0, 5)
      .map((component) => `${component.name}: ${component.signals.map((signal) => signal.detail).join('; ')}`),
  };
}

/** What the health analysis flagged. Its codes, not a re-judgement of them. */
function risksOf(context: RepositoryContext): Evidenced<readonly string[]> | null {
  const findings = context.health.report?.findings ?? [];
  const cycles = context.dependencies.cycles?.totals.import ?? 0;

  const values = [
    ...findings.slice(0, 5).map((finding) => `${finding.code} (${finding.nodeCount} nodes)`),
    ...(cycles > 0 ? [`${cycles} import cycles`] : []),
  ];

  return values.length === 0
    ? null
    : { value: values, evidence: ['reported by the health analyser over this graph'] };
}

/** One identity as the few lines a prompt can afford. See `repositoryGuidance`. */
export function renderIdentity(identity: RepositoryIdentity): readonly string[] {
  const lines: string[] = [];

  if (identity.purpose !== null) {
    lines.push(`It is ${identity.purpose.value}.`);
  }

  if (identity.users !== null && identity.users.value !== '') {
    lines.push(`Used by ${identity.users.value}.`);
  }

  if (identity.domains.length > 0) {
    lines.push(
      `Organised around ${identity.domains
        .slice(0, 4)
        .map((domain) => `${domain.name}${domain.members.length === 0 ? '' : ` (${domain.members.slice(0, 3).join(', ')})`}`)
        .join('; ')}.`,
    );
  }

  return lines;
}

/**
 * Components ranked within each non-production role, for the questions that ask about those roles.
 *
 * Only roles the repository actually has declarations in are computed, and each is capped: a reader
 * asking what handles deployment wants the handful that do, not a leaderboard.
 */
function rankedByRole(context: RepositoryContext): Readonly<Partial<Record<RegionRole, readonly ComponentImportance[]>>> {
  const byRole: Partial<Record<RegionRole, readonly ComponentImportance[]>> = {};

  for (const role of ['ci', 'deployment', 'test', 'script', 'configuration', 'example', 'sample', 'migration'] as const) {
    const ranked = rankComponents(context, { roles: [role] });

    if (ranked.length > 0) {
      byRole[role] = ranked.slice(0, ROLE_LIMIT);
    }
  }

  return byRole;
}

/** How many components one role is worth naming. Beyond this a reader is reading a list again. */
const ROLE_LIMIT = 6;
