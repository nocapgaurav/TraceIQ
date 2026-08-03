import type { RepositoryContext } from '@traceiq/context';

import { ownRoutes, roleOfPath, type RegionRole } from './structure.js';

/**
 * Which parts of a repository matter more than the others, and by how much.
 *
 * **Everything in a projection currently has equal weight, and that is the last big untruth in it.**
 * A projection lists `PrismaUrlRepository` and `formatDate` as two facts of the same rank, so a model
 * spends the same sentence on each — and a reader who wanted to know what this repository *is* gets a
 * uniform tour. Repositories are not uniform. One declaration handles every redirect in LinkForge and
 * another formats a timestamp, and the graph already knows the difference: it counted the references.
 *
 * **The signals are measured; the weighting is a judgement, and the two are kept visibly apart.** Every
 * signal below is a number a capability already computed — a fan-in, a dependent count, a route
 * linkage. Nothing here counts anything the graph did not. What this file adds is an opinion about
 * which of those numbers matters more, and that opinion is a declared table (`WEIGHTS`) rather than
 * conditionals scattered through a ranking function, so a reviewer can disagree with one line of it.
 *
 * Every score carries the signals that produced it **with their raw values**, so a claim that
 * `UrlService` is the most important declaration in the repository can be checked against "37 incoming
 * references, handles 4 routes, annotated Service" rather than believed on the strength of a number
 * between zero and one.
 *
 * **Scores are relative to one repository and meaningless between two.** Each signal is normalised
 * against the largest value observed in this repository, because "37 references" means something
 * different in a 200-file service and in React. A component scoring 1.0 is the most referenced thing
 * *here*, which is the only question a reader is actually asking.
 */

export interface ImportanceSignal {
  /** What was measured. */
  readonly signal: string;
  /** The raw number the graph reported, before any normalisation. */
  readonly value: number;
  /** The measurement in words, so the score can be checked rather than trusted. */
  readonly detail: string;
}

export interface ComponentImportance {
  /** The graph identifier, or `pkg:<name>` for a derived package. */
  readonly id: string;
  readonly name: string;
  readonly kind: 'declaration' | 'package';
  /** Zero to one, relative to the largest observed in this repository. */
  readonly score: number;
  /** One to five. What a reader sees; the score is what ordered it. */
  readonly stars: number;
  readonly signals: readonly ImportanceSignal[];
}

/**
 * What each signal contributes.
 *
 * **Ordered by how directly the signal answers "would a new engineer need to understand this".**
 *
 * - `route-ownership` is heaviest because it is the strongest statement the graph can make about a
 *   declaration: a request from outside the system arrives *here*. It is also the rarest.
 * - `fan-in` next: the number of other declarations that reference this one is the closest thing to a
 *   measured statement of "everything depends on it".
 * - `role` carries real information — a Service is where behaviour lives and a Model is a shape — but
 *   it is an annotation rather than a measurement, so it weighs less than either.
 * - `coupling` and `dependents` are breadth rather than depth, and a widely-imported utility is
 *   genuinely less interesting to explain than a widely-called service.
 * - `size` is last and lightest on purpose. A large package is not an important one; it is a large
 *   one. It appears at all because between two otherwise equal packages the bigger one is the better
 *   place to start reading.
 */
const WEIGHTS: Readonly<Record<string, number>> = {
  'route-ownership': 0.30,
  'fan-in': 0.25,
  /**
   * Raised from 0.15 after measurement, and this is the one weight that earns an argument.
   *
   * A role is the **only** signal that says what a declaration is *for*; every other one says how much
   * of the repository points at it. Measured on LinkForge, weighting it at 0.15 put `cn` — a class-name
   * helper with 70 references — above every controller and service in the repository. Fan-in is a real
   * measurement and it systematically favours utilities, because a utility is what everything calls.
   */
  role: 0.22,
  coupling: 0.12,
  dependents: 0.10,
  size: 0.08,
};

/**
 * Which signals each kind of component can possibly carry.
 *
 * **The denominator, and getting it wrong was the worst defect in this file.** Scores were first
 * divided by the weight of the signals a component *actually had*, so a declaration whose only
 * evidence was a role annotation scored `0.22 / 0.22` — a perfect one. Measured on LinkForge, that put
 * `analyticsController`, `authController` and `urlController` at five stars on the strength of nothing
 * but their names, ahead of a declaration with seventy recorded references. Having one weak signal is
 * not the same as being certain.
 *
 * Dividing by what the kind could achieve fixes it: a role-only declaration now scores `0.22 / 0.89`,
 * which is the two stars it deserves. Kinds are kept separate so a package is not marked down for
 * lacking a fan-in it could never have.
 */
const KIND_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  declaration: ['route-ownership', 'fan-in', 'role', 'coupling'],
  package: ['dependents', 'size'],
};

/** The largest score a component of this kind could reach. See `KIND_SIGNALS`. */
function ceilingFor(kind: string): number {
  return (KIND_SIGNALS[kind] ?? []).reduce((sum, signal) => sum + (WEIGHTS[signal] ?? 0), 0);
}

/**
 * What each role contributes, before normalisation.
 *
 * A Controller is the edge of the system and a Repository is where state is reached — both are places
 * an explanation has to go. A Model is a shape rather than a behaviour, and a Test is not part of what
 * the repository does at all, so it scores nothing and can only be ranked by its other signals.
 */
const ROLE_WEIGHT: Readonly<Record<string, number>> = {
  Controller: 1,
  Service: 0.9,
  Repository: 0.85,
  Middleware: 0.6,
  Model: 0.4,
  /*
   * Zero when the question is about the repository's code, and the only signal a test has when it is not.
   *
   * A test is never a component of the architecture, which is what the zero says. But a question that
   * asks *for* tests ranks within the test role alone — see `rankComponents`'s `roles` option — and there
   * every candidate carries this same weight, so the ordering falls to the measured signals beside it and
   * the weight itself cancels. What it must not do is leave a test with no signal at all, which kept test
   * declarations out of the ranking entirely and answered a test question with the `tests` package.
   */
  Test: 0.3,
};

/** Five bands, so a reader sees a rank rather than a number they would have to calibrate. */
export function starsOf(score: number): number {
  if (score >= 0.75) {
    return 5;
  }

  if (score >= 0.5) {
    return 4;
  }

  if (score >= 0.3) {
    return 3;
  }

  if (score >= 0.15) {
    return 2;
  }

  return 1;
}

/**
 * Paths holding code the repository is not made of.
 *
 * **Fan-in is a real measurement and generated code is where it lies.** LinkForge's three most
 * referenced declarations are `XOR`, `SelectSubset` and `cn` — the first two are Prisma type helpers
 * emitted into `src/generated`, referenced 66 and 57 times because every generated query type uses
 * them. They are genuinely the most-referenced declarations in the repository and they are not
 * components of it: nobody maintaining LinkForge needs to understand `SelectSubset`, and an answer
 * that opens with it has been misled by an honest number.
 *
 * The path is the evidence, and it is the graph's own — a node carries the file it was declared in.
 * This excludes nothing a person wrote; a directory called `generated` or `vendor` is a statement by
 * the repository about its own contents.
 *
 * `flow-typed`, `typings` and `@types` were added for the same reason after React ranked
 * `flow-typed/environments` as its single most important unit, on 46 packages importing it. Type
 * stubs for other people's libraries are declarations, they are imported constantly, and nobody
 * introducing an engineer to React would begin there.
 */
/**
 * Whether a declaration lives in code that is not a component of the repository.
 *
 * **Widened from generated code to every incidental role, and `stripe/ai` is why.** The generated and
 * vendored exclusion above was already the right idea; it was simply not the whole set. `stripe/ai`'s
 * most-referenced declarations are `Salon`, `SalonSchema` and `SettingsProvider`, all of them inside
 * `benchmarks/furever/environment` — a sample pet-grooming application written to be graded. They are
 * honestly the most-referenced declarations in the tree and nobody maintaining `stripe/ai` needs to
 * understand any of them. That is the identical failure `SelectSubset` produced, arriving from a
 * benchmark instead of a code generator.
 *
 * The vocabulary now lives in `structure.ts` so the ranking, the technologies, the routes and the
 * repository type all agree about what the repository is made of. A test is excluded here for the same
 * reason: "the components a new engineer must understand" is not a list of test helpers. Tests remain
 * fully available to the questions that ask for them — see the `locate` intent — because being excluded
 * from a ranking is not being excluded from the graph.
 */
function isIncidental(fileId: unknown, eligible: readonly RegionRole[]): boolean {
  return typeof fileId === 'string' && !eligible.includes(roleOfPath(fileId.replace(/^file:/, '')));
}

interface Accumulator {
  readonly id: string;
  readonly name: string;
  readonly kind: 'declaration' | 'package';
  readonly raw: Map<string, ImportanceSignal>;
}

/**
 * Every component the repository context can speak about, ranked.
 *
 * Declarations and packages are ranked in **one list against one another**, deliberately. A reader
 * asking what matters in a repository does not want two lists to reconcile — and the two are directly
 * comparable here because every signal is normalised within its own kind before the weights are
 * applied, so a package's dependent count is not competing with a declaration's fan-in on a raw scale.
 */
export function rankComponents(
  context: RepositoryContext,
  options: { readonly roles?: readonly RegionRole[] } = {},
): readonly ComponentImportance[] {
  if (context.primary.type !== 'repository') {
    return [];
  }

  /*
   * Which semantic roles are eligible for this ranking, and why the default is production alone.
   *
   * **Semantic role is not importance, and this parameter is where the two are kept apart.** The ranking
   * measures structural prominence — fan-in, route ownership, coupling — and those numbers are just as
   * real for a CI script as for a controller. What differs is whether the question is about CI. So the
   * measurement is unchanged and the *eligible set* moves: asked about architecture, only the
   * repository's own code competes; asked what handles deployment, the CI and deployment code competes
   * instead, and is scored against its own peers rather than against application code it would always
   * lose to.
   *
   * Normalising within the eligible set is the reason this is a parameter rather than a filter applied
   * afterwards. Every score is relative to the largest value observed *here*, so ranking CI scripts
   * alongside a service's controllers would report the most prominent CI script as one star and tell a
   * reader nothing about CI.
   */
  const eligible = options.roles ?? ['production'];
  const permitted = (path: unknown): boolean =>
    typeof path !== 'string' || eligible.includes(roleOfPath(path.replace(/^file:/, '')));

  const { overview, architecture, hotspots } = context.primary.value;
  const found = new Map<string, Accumulator>();

  const record = (
    id: string,
    name: string,
    kind: 'declaration' | 'package',
    signal: string,
    value: number,
    detail: string,
  ): void => {
    if (value <= 0) {
      return;
    }

    const held = found.get(id) ?? { id, name, kind, raw: new Map<string, ImportanceSignal>() };
    const existing = held.raw.get(signal);

    // The largest observation wins. A declaration appearing in both `mostReferenced` and `largestFanIn`
    // is one declaration with one fan-in, not two contributions of it.
    if (existing === undefined || value > existing.value) {
      held.raw.set(signal, { signal, value, detail });
    }

    found.set(id, held);
  };

  // ---- measured: how much of the repository points at this declaration -------------------------
  for (const listing of [hotspots.mostReferenced, hotspots.largestFanIn]) {
    for (const metric of listing?.entries ?? []) {
      if (isIncidental(metric.node.fileId, eligible)) {
        continue;
      }

      record(
        metric.node.id,
        metric.node.name,
        'declaration',
        'fan-in',
        metric.fanIn,
        `${metric.fanIn} distinct declarations reference it`,
      );
    }
  }

  for (const metric of hotspots.mostCoupled?.entries ?? []) {
    if (isIncidental(metric.node.fileId, eligible)) {
      continue;
    }

    record(
      metric.node.id,
      metric.node.name,
      'declaration',
      'coupling',
      metric.fanIn + metric.fanOut,
      `${metric.fanIn} in and ${metric.fanOut} out`,
    );
  }

  // ---- measured: a request from outside the system arrives here --------------------------------
  const routesPerHandler = new Map<string, { count: number; name: string; example: string }>();

  /*
   * Declarations annotated Middleware, which cannot be the end of a request.
   *
   * **A middleware is by definition not what answers.** Measured on LinkForge, the framework extractor
   * linked only the rate limiters — `createLimit`, `loginLimit`, `redirectLimit` — because the
   * controllers beside them in `router.post('/', createLimit, createUrlController)` could not be
   * resolved. Each limiter was then the last linked handler on its route, collected the heaviest
   * signal there is, and the four most important declarations in a URL shortener were reported as its
   * rate limiters.
   *
   * Where the terminal handler is annotated Middleware, the real handler was not linked and there is
   * no route ownership to award. The middleware keeps its role signal, which is what it actually has.
   */
  const isMiddleware = new Set((architecture.middleware?.entries ?? []).map((entry) => entry.id));

  // Only the routes the repository serves. Route ownership is the heaviest signal there is, so a handler
  // that answers nothing but a benchmark fixture's route must not collect it — which is how a sample
  // application's controllers came to be the most important declarations in a repository of libraries.
  for (const route of eligible.includes('production') ? ownRoutes(context) : []) {
    // The **last** handler is the one that answers; the ones before it are middleware, and middleware
    // running on every route would otherwise out-score the handler that does the work.
    //
    // Read defensively: a route whose handlers the extractor could not link carries none, and a
    // context assembled by a caller that predates the field carries the property undefined. Neither
    // is an error — it is a route with no handler evidence, and it contributes nothing here.
    const handler = [...(route.handlers ?? [])].reverse().find((entry) => entry.declaration !== null)?.declaration;

    if (handler === undefined || handler === null || isMiddleware.has(handler.id)) {
      continue;
    }

    const held = routesPerHandler.get(handler.id) ?? {
      count: 0,
      name: handler.name,
      example: `${route.method} ${route.composition.effectivePath}`,
    };

    held.count += 1;
    routesPerHandler.set(handler.id, held);
  }

  for (const [id, held] of routesPerHandler) {
    record(id, held.name, 'declaration', 'route-ownership', held.count, `handles ${held.count} routes, e.g. ${held.example}`);
  }

  // ---- annotated: what the declaration is for --------------------------------------------------
  for (const [role, listing] of [
    ['Controller', architecture.controllers],
    ['Service', architecture.services],
    ['Repository', architecture.repositories],
    ['Middleware', architecture.middleware],
    ['Model', architecture.models],
    ['Test', architecture.tests],
  ] as const) {
    for (const declaration of listing?.entries ?? []) {
      /*
       * A role annotation on a sample application's declaration is a real annotation about code the
       * repository is not made of.
       *
       * The measured signals above were already filtered and this one was not, so a fixture's `Salon`
       * model kept a role signal and stayed in the ranking after its fan-in had been discounted. Every
       * signal has to answer the same question about the same declaration or the filtering leaks.
       */
      if (
        isIncidental(declaration.fileId, eligible) ||
        isIncidental(declaration.id.slice(declaration.id.indexOf(':') + 1), eligible)
      ) {
        continue;
      }

      record(
        declaration.id,
        declaration.name,
        'declaration',
        'role',
        ROLE_WEIGHT[role] ?? 0,
        `annotated ${role}`,
      );
    }
  }

  // ---- measured: how much of the repository imports this unit -----------------------------------
  for (const entry of overview.packages?.entries ?? []) {
    // A generated or demonstration package is not a unit anyone reads, for the same reason such a
    // declaration is not a component. `src/generated` is one of LinkForge's largest packages by
    // declaration count, and `benchmarks/furever` is by far `stripe/ai`'s.
    if (!permitted(entry.name)) {
      continue;
    }

    record(`pkg:${entry.name}`, entry.name, 'package', 'dependents', entry.dependents, `${entry.dependents} packages import it`);
    record(`pkg:${entry.name}`, entry.name, 'package', 'size', entry.declarations, `${entry.declarations} declarations`);
  }

  return score([...found.values()]);
}

/**
 * Normalise within kind, weight, and rank.
 *
 * **Within kind, because the two kinds do not share a scale.** A package's dependent count tops out in
 * the tens while a declaration's fan-in can reach the hundreds, and normalising them together would
 * rank every package below every declaration for reasons that are about arithmetic rather than about
 * the repository.
 */
function score(components: readonly Accumulator[]): readonly ComponentImportance[] {
  const peak = new Map<string, number>();

  for (const component of components) {
    for (const signal of component.raw.values()) {
      const key = `${component.kind}\u0000${signal.signal}`;

      peak.set(key, Math.max(peak.get(key) ?? 0, signal.value));
    }
  }

  const scored = components.map((component): ComponentImportance => {
    let total = 0;

    for (const signal of component.raw.values()) {
      const top = peak.get(`${component.kind}\u0000${signal.signal}`) ?? 0;
      const weight = WEIGHTS[signal.signal] ?? 0;

      total += top === 0 ? 0 : (signal.value / top) * weight;
    }

    // Divided by what a component of this kind could achieve, never by what this one happened to
    // carry. See `KIND_SIGNALS` for the defect that distinction fixes.
    const ceiling = ceilingFor(component.kind);
    const normalised = ceiling === 0 ? 0 : total / ceiling;

    return {
      id: component.id,
      name: component.name,
      kind: component.kind,
      score: Math.round(normalised * 1000) / 1000,
      stars: starsOf(normalised),
      signals: [...component.raw.values()].sort(
        (left, right) => (WEIGHTS[right.signal] ?? 0) - (WEIGHTS[left.signal] ?? 0),
      ),
    };
  });

  return scored.sort(
    (left, right) =>
      right.score - left.score ||
      // More kinds of evidence beats the same score reached from one signal.
      right.signals.length - left.signals.length ||
      left.id.localeCompare(right.id),
  );
}

/** The highest-ranked declarations, which is what "the important components" means to a reader. */
export function topDeclarations(
  components: readonly ComponentImportance[],
  limit: number,
): readonly ComponentImportance[] {
  return components.filter((component) => component.kind === 'declaration').slice(0, limit);
}

export function topPackages(
  components: readonly ComponentImportance[],
  limit: number,
): readonly ComponentImportance[] {
  return components.filter((component) => component.kind === 'package').slice(0, limit);
}
