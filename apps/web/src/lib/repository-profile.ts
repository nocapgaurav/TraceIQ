import type { Overview, PackageSummary, Role } from '@/types/api';

/**
 * "What is this repository?", assembled from the overview payload.
 *
 * **This is presentation, not analysis.** Every value below is a grouping, a count or a sentence built
 * from figures `/overview` already computed. Nothing here inspects code, infers a relationship or applies
 * a convention-based heuristic — that work belongs to the analysis packages, and doing it in the browser
 * would put repository intelligence in the interface, which the architecture forbids.
 *
 * The consequence is that several fields simply cannot be filled today. They report that rather than
 * guessing: a field is either a `Derived` value carrying the evidence behind it, or `null`, and the UI
 * renders `null` as "Available after Repository Intelligence generation."
 */

/** A value the UI may show, together with the figures it was built from. */
export interface Derived<T> {
  readonly value: T;
  /** Why this is true, in one phrase. Shown to the reader — a claim without evidence is not shown. */
  readonly evidence: string;
}

/** `null` means "not determinable from what the API exposes today", never "zero" and never "unknown". */
export type Maybe<T> = Derived<T> | null;

export interface DirectoryGroup {
  readonly name: string;
  readonly packages: number;
  readonly files: number;
  readonly declarations: number;
}

export interface StackItem {
  readonly label: string;
  readonly detail: string;
}

export interface RepositoryProfile {
  /**
   * Always `null`. No endpoint reports the analysed repository's name or root path — `/version` carries
   * the database path, and every other `name` in the payload is a package, file or declaration. Naming it
   * would mean inventing one.
   */
  readonly name: null;
  /** A short label for the kind of project this is, e.g. "TypeScript monorepo". */
  readonly shape: Derived<string>;
  readonly description: Derived<string>;
  /**
   * Always `null`. What a repository is *for* is not recoverable from structure; it is the thing
   * Repository Intelligence generation is meant to produce.
   */
  readonly purpose: null;
  readonly architectureStyle: Maybe<string>;
  readonly languages: Derived<readonly string[]>;
  readonly frameworks: Maybe<readonly string[]>;
  readonly mainPackages: readonly PackageSummary[];
  readonly entryPoints: Maybe<readonly string[]>;
  readonly importantDirectories: readonly DirectoryGroup[];
  readonly stack: readonly StackItem[];
}

/** The message the UI shows wherever a value is `null`. One string, so every gap reads identically. */
export const UNAVAILABLE = 'Available after Repository Intelligence generation.';

const ROOT_GROUP = 'repository root';

export function deriveProfile(overview: Overview): RepositoryProfile {
  const { repository, architecture, packages, graph } = overview;
  const directories = groupByDirectory(packages.entries);
  const monorepo = isMonorepo(packages.entries, directories);

  const shape: Derived<string> = {
    value: monorepo ? 'TypeScript monorepo' : 'TypeScript project',
    evidence: monorepo
      ? `${packages.total} derived packages across ${describeList(directories.map((entry) => entry.name))}`
      : `${packages.total} derived package${packages.total === 1 ? '' : 's'}`,
  };

  return {
    name: null,
    shape,
    description: describe(overview, shape.value, directories),
    purpose: null,
    architectureStyle: architectureStyle(architecture.roleCounts, monorepo, packages.total),
    languages: {
      // Not a detection. TraceIQ's scanner reads TypeScript projects and nothing else, so every file in
      // any graph it produced is TypeScript by construction. Saying so is honest; claiming to have
      // detected it would not be.
      value: ['TypeScript'],
      evidence: 'the analysis reads TypeScript projects only, so every analysed file is TypeScript',
    },
    frameworks: frameworks(repository.routes, repository.environmentVariables),
    mainPackages: mainPackages(packages.entries),
    entryPoints: entryPoints(repository.routes, architecture.roleCounts),
    importantDirectories: directories,
    stack: stack(repository, graph),
  };
}

/**
 * One sentence describing the repository, built only from counts.
 *
 * Deliberately plain. It is not a model-written summary and must not read like one — a reader who cannot
 * tell the difference would trust it more than its provenance warrants.
 */
function describe(overview: Overview, shape: string, directories: readonly DirectoryGroup[]): Derived<string> {
  const { repository, packages, graph } = overview;
  const where = directories.length > 1 ? ` organised under ${describeList(directories.map((entry) => entry.name))}` : '';
  const relationships =
    graph.edges === 0 ? '' : ` The analysis resolved ${plural(graph.edges, 'relationship')} between them.`;

  return {
    // `shape` is not lower-cased: it begins with "TypeScript", which is a proper noun and stays capitalised
    // mid-sentence.
    value:
      `A ${shape} of ${plural(packages.total, 'package')}${where}, ` +
      `holding ${plural(repository.files, 'file')} and ${plural(repository.declarations, 'declaration')}.` +
      relationships,
    evidence: 'counts reported by /overview',
  };
}

/**
 * Whether to call this a monorepo.
 *
 * Two or more directory groups each holding a package, or several packages under one. Packages are
 * derived from path segments, so this describes the layout on disk and nothing more.
 */
function isMonorepo(entries: readonly PackageSummary[], directories: readonly DirectoryGroup[]): boolean {
  const grouped = directories.filter((entry) => entry.name !== ROOT_GROUP);

  return grouped.length > 1 || entries.length > 3;
}

/**
 * Architecture style, from the role annotations the analysis recorded.
 *
 * Roles are the only structural vocabulary the API exposes that speaks to *style*. Where the analysis
 * found none of the layering roles there is nothing to report, and the field degrades — a repository
 * without recorded Controllers or Services is not thereby "unlayered", it is unmeasured.
 */
function architectureStyle(
  roles: Readonly<Record<Role, number>>,
  monorepo: boolean,
  packages: number,
): Maybe<string> {
  const layering = (['Controller', 'Service', 'Repository'] as const).filter((role) => (roles[role] ?? 0) > 0);
  const layout = monorepo ? `modular monorepo, ${packages} packages` : 'single package';

  if (layering.length === 0) {
    return monorepo
      ? { value: layout, evidence: 'derived from the package layout; no layering roles were recorded' }
      : null;
  }

  return {
    value: `${layout} with ${describeList(layering.map((role) => role.toLowerCase()))} layering`,
    evidence: `${describeList(layering.map((role) => `${format(roles[role])} ${role}`))} annotated by the analysis`,
  };
}

/**
 * Frameworks.
 *
 * The API reports the *outcomes* of framework extraction — routes and environment variables — but never
 * names the framework itself. So this states what was found and stops there; putting a lookup table of
 * package names in the browser would be moving detection into the interface.
 */
function frameworks(routes: number, environmentVariables: number): Maybe<readonly string[]> {
  const found: string[] = [];

  if (routes > 0) {
    found.push(`HTTP routing (${plural(routes, 'route')} registered)`);
  }

  if (environmentVariables > 0) {
    found.push(`environment configuration (${plural(environmentVariables, 'variable')} read)`);
  }

  return found.length === 0
    ? null
    : { value: found, evidence: 'framework extraction reports these outcomes; it does not name the framework' };
}

/** The largest packages by declaration count. Ties break by name, so the order is stable. */
function mainPackages(entries: readonly PackageSummary[]): readonly PackageSummary[] {
  return [...entries]
    .sort((left, right) => right.declarations - left.declarations || left.name.localeCompare(right.name))
    .slice(0, 6);
}

/**
 * Entry points.
 *
 * Routes and Controllers are the two the analysis actually records. File-name conventions — `index.ts`,
 * `main.ts`, `bin/` — would find more, and are exactly the inference this layer must not make.
 */
function entryPoints(routes: number, roles: Readonly<Record<Role, number>>): Maybe<readonly string[]> {
  const found: string[] = [];

  if (routes > 0) {
    found.push(plural(routes, 'HTTP route'));
  }

  if (roles.Controller > 0) {
    found.push(plural(roles.Controller, 'controller'));
  }

  return found.length === 0
    ? null
    : { value: found, evidence: 'routes and controller roles recorded by the analysis' };
}

/**
 * Packages grouped by their first path segment.
 *
 * Package names are themselves derived from paths, so this is a second grouping of the same convention —
 * `apps/api` and `apps/web` sit under `apps`. A name with no separator is a file at the repository root
 * and is grouped as such rather than becoming a directory of its own.
 */
export function groupByDirectory(entries: readonly PackageSummary[]): readonly DirectoryGroup[] {
  const groups = new Map<string, { packages: number; files: number; declarations: number }>();

  for (const entry of entries) {
    const separator = entry.name.indexOf('/');
    const key = separator === -1 ? ROOT_GROUP : entry.name.slice(0, separator);
    const current = groups.get(key) ?? { packages: 0, files: 0, declarations: 0 };

    groups.set(key, {
      packages: current.packages + 1,
      files: current.files + entry.files,
      declarations: current.declarations + entry.declarations,
    });
  }

  return [...groups.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    // Largest first, then alphabetical — the same input always produces the same order.
    .sort((left, right) => right.declarations - left.declarations || left.name.localeCompare(right.name));
}

/**
 * The compact pills under the hero.
 *
 * Only what the payload states outright. "39 npm packages" is a count the analysis made; naming them
 * would need a repository-wide list of externals that no endpoint returns.
 */
function stack(repository: Overview['repository'], graph: Overview['graph']): readonly StackItem[] {
  const items: StackItem[] = [
    { label: 'TypeScript', detail: 'the only language the analysis reads' },
    { label: `${format(repository.files)} files`, detail: 'analysed into the graph' },
    { label: `${format(repository.declarations)} declarations`, detail: 'classes, interfaces, functions, methods and more' },
  ];

  // `externalsByKind` is an open record, so every lookup is `number | undefined`. Bound once each, rather
  // than guarded and then read again — the second read would not be narrowed by the first.
  const runtime = (repository.externalsByKind.builtin ?? 0) + (repository.externalsByKind.node ?? 0);
  const npm = repository.externalsByKind.npm ?? 0;

  if (runtime > 0) {
    items.push({ label: 'Node.js', detail: `${format(runtime)} runtime modules imported` });
  }

  if (npm > 0) {
    items.push({
      label: `${format(npm)} npm packages`,
      detail: 'external dependencies reached from this repository',
    });
  }

  if (repository.routes > 0) {
    items.push({ label: `${format(repository.routes)} routes`, detail: 'HTTP routes the repository registers' });
  }

  if (graph.edges > 0) {
    items.push({ label: `${format(graph.edges)} relationships`, detail: 'edges in the repository graph' });
  }

  return items;
}

/** "a, b and c" — an Oxford-comma-free list, because these are read as prose. */
function describeList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }

  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A fixed locale, so the same graph reads identically on every machine. */
function format(value: number): string {
  return value.toLocaleString('en-US');
}

/** "1 route" but "12 routes". These strings are read as prose, so the agreement has to be right. */
function plural(value: number, singular: string): string {
  return `${format(value)} ${singular}${value === 1 ? '' : 's'}`;
}
