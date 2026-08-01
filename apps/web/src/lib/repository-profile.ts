import type {
  AnalysisDepth,
  Overview,
  PackageSummary,
  Role,
  TechnologySummary,
} from '@/types/api';

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

/** One region, reduced to what the Overview shows about it. */
export interface AnalysedRegion {
  /** `'repository root'` for the root region, so the label never renders empty. */
  readonly label: string;
  readonly language: string | null;
  readonly depth: AnalysisDepth;
  readonly files: number;
  readonly sourceFiles: number;
  /** The API's own words for why analysis stopped where it did. Shown verbatim. */
  readonly reason: string;
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
  /**
   * How deeply each part of the repository was analysed.
   *
   * **The UI showed none of this, and that was the gap behind every "why is this page empty?".** A
   * region at `universal` depth has no declarations, no calls and no types — and a reader shown zero of
   * each with no explanation reasonably concludes the code has no dependencies. The reason string comes
   * from the API so the explanation is the analysis's own, not the interface's guess at it.
   */
  readonly regions: readonly AnalysedRegion[];
  /** The deepest analysis reached anywhere, with what that means for the reader. */
  readonly depth: Derived<AnalysisDepth>;
}

/**
 * What each depth means for what a reader may expect on the page.
 *
 * Fixed text, one per depth, so the explanation of an empty panel is the same wherever it appears.
 */
export const DEPTH_MEANING: Readonly<Record<AnalysisDepth, string>> = {
  universal: 'files, languages, manifests and declared dependencies only — no declarations, calls or types',
  structural: 'declarations and structure, but no resolved references between them',
  semantic: 'declarations, imports, calls and types, resolved',
  framework: 'declarations, imports, calls and types, plus the routes a framework registers',
};

/** The message the UI shows wherever a value is `null`. One string, so every gap reads identically. */
export const UNAVAILABLE = 'Available after Repository Intelligence generation.';

const ROOT_GROUP = 'repository root';

export function deriveProfile(overview: Overview): RepositoryProfile {
  const { repository, architecture, packages, graph } = overview;
  const directories = groupByDirectory(packages.entries);
  const monorepo = isMonorepo(packages.entries, directories);

  const shape = describeShape(overview, monorepo, directories);

  return {
    name: null,
    shape,
    description: describe(overview, shape.value, directories),
    purpose: null,
    architectureStyle: architectureStyle(architecture.roleCounts, monorepo, packages.total),
    languages: languages(overview),
    frameworks: frameworks(
      overview.technologies ?? [],
      repository.routes,
      repository.environmentVariables,
    ),
    mainPackages: mainPackages(packages.entries),
    entryPoints: entryPoints(repository.routes, architecture.roleCounts),
    importantDirectories: directories,
    stack: stack(repository, graph, overview.capabilities),
    regions: regionsOf(overview),
    depth: {
      value: overview.capabilities.depth,
      evidence: DEPTH_MEANING[overview.capabilities.depth],
    },
  };
}


/**
 * A display name for a language the scanner reported.
 *
 * The API uses lower-case identifiers — `typescript`, `cpp`, `csharp` — and a reader expects the names
 * the ecosystems use. A lookup for the ones whose casing is not simply capitalised, and capitalisation
 * for the rest, so a language added to the scanner still renders sensibly without a change here.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  go: 'Go',
  rust: 'Rust',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'Ruby',
  swift: 'Swift',
  scala: 'Scala',
  shell: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  markdown: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  terraform: 'Terraform',
  dockerfile: 'Dockerfile',
  make: 'Make',
  gradle: 'Gradle',
  protobuf: 'Protobuf',
  graphql: 'GraphQL',
};

function regionsOf(overview: Overview): readonly AnalysedRegion[] {
  return overview.capabilities.regions.map((region) => ({
    label: region.path === '' ? ROOT_GROUP : region.path,
    language: region.primaryLanguage === null ? null : languageName(region.primaryLanguage),
    depth: region.depth,
    files: region.fileCount,
    sourceFiles: region.sourceFileCount,
    reason: region.reason,
  }));
}

/**
 * Exported because two derivations need the same display name.
 *
 * The Overview's profile and the repository identity header both render a language, and letting each
 * spell `cpp` its own way is how one page ends up saying "C++" and another "Cpp".
 */
export function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * The languages the repository is written in, by file count.
 *
 * **This replaced a hardcoded `['TypeScript']`.** The old value came with the evidence "the analysis
 * reads TypeScript projects only, so every analysed file is TypeScript" — true when written, and false
 * from the moment discovery became universal. A Flask repository was shown, on the first page a reader
 * sees, as a TypeScript project. Nothing else in the product stated anything as wrong as that.
 *
 * `capabilities.languages` is the scanner's own count, identified by file extension. Presented as
 * evidence rather than proof, which is what the confidence on those graph facts already says.
 */
function languages(overview: Overview): Derived<readonly string[]> {
  const counted = overview.capabilities.languages;

  if (counted.length === 0) {
    return { value: [], evidence: 'the scan recorded no files with a recognised language' };
  }

  return {
    value: counted.map((entry) => languageName(entry.language)),
    evidence: `file counts by extension across ${plural(
      counted.reduce((total, entry) => total + entry.files, 0),
      'file',
    )}`,
  };
}

/**
 * What kind of project this is, named after what it is actually written in.
 *
 * Three cases, and the distinction between them is the point. A polyglot repository is not a
 * "TypeScript monorepo" with extra files in it — the languages sit in different regions, and saying so
 * is the honest description. A region's primary language is the scanner's, by file count.
 */
function describeShape(
  overview: Overview,
  monorepo: boolean,
  directories: readonly DirectoryGroup[],
): Derived<string> {
  const { capabilities, packages } = overview;
  const layout = monorepo ? 'monorepo' : 'project';

  const primaries = [
    ...new Set(
      capabilities.regions
        .map((region) => region.primaryLanguage)
        .filter((language): language is string => language !== null),
    ),
  ];

  const where =
    directories.length > 1
      ? `${packages.total} derived packages across ${describeList(directories.map((entry) => entry.name))}`
      : `${packages.total} derived package${packages.total === 1 ? '' : 's'}`;

  if (primaries.length === 0) {
    return {
      value: `${layout} with no dominant source language`,
      evidence: `${where}; no region has a dominant source language`,
    };
  }

  if (capabilities.isPolyglot) {
    return {
      value: `polyglot ${layout} (${describeList(primaries.map(languageName))})`,
      evidence: `${capabilities.regions.length} technology regions, whose primary languages are ${describeList(
        primaries.map(languageName),
      )}`,
    };
  }

  return {
    value: `${languageName(primaries[0] as string)} ${layout}`,
    evidence: where,
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
    // `shape` is not lower-cased: it begins with a language name, which is a proper noun and stays
    // capitalised mid-sentence.
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
 * **This used to say "framework extraction reports these outcomes; it does not name the framework".**
 * That was true and it was a gap: a reader was shown "HTTP routing (16 routes registered)" for a
 * Spring Boot service and left to work out what it was. The API names them now, with the files that
 * prove each, so the interface reports the detection rather than paraphrasing its side effects.
 *
 * The rule the old comment stated still holds and is why this reads rather than derives: putting a
 * lookup table of package names in the browser would move detection into the interface. Every name
 * here came from the API, and so did every reason.
 */
function frameworks(
  technologies: readonly TechnologySummary[],
  routes: number,
  environmentVariables: number,
): Maybe<readonly string[]> {
  // Frontend and backend only. A reader asking what a repository *is* is not asking which test
  // runner it uses, and the full list is on the technology section below.
  const named = technologies
    .filter((entry) => entry.category === 'frontend' || entry.category === 'backend')
    .map((entry) => (entry.regionPath === '' ? entry.name : `${entry.name} (${entry.regionPath})`));

  const found = [...new Set(named)];

  if (routes > 0) {
    found.push(`HTTP routing (${plural(routes, 'route')} registered)`);
  }

  if (environmentVariables > 0) {
    found.push(`environment configuration (${plural(environmentVariables, 'variable')} read)`);
  }

  return found.length === 0
    ? null
    : {
        value: found,
        evidence:
          named.length === 0
            ? 'framework extraction reports these outcomes; no framework was named'
            : 'each framework is named by a manifest entry or a marker file in the repository',
      };
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
function stack(
  repository: Overview['repository'],
  graph: Overview['graph'],
  capabilities: Overview['capabilities'],
): readonly StackItem[] {
  const items: StackItem[] = [];

  // The languages the scan counted, not a constant. This row led with the chip `TypeScript` and the
  // detail "the only language the analysis reads" — which was true once and then described a Spring
  // repository. Found by opening the page, not by a test.
  for (const entry of capabilities.languages.slice(0, 3)) {
    items.push({
      label: languageName(entry.language),
      detail: `${format(entry.files)} ${entry.files === 1 ? 'file' : 'files'}, identified by extension`,
    });
  }

  items.push(
    { label: `${format(repository.files)} files`, detail: 'analysed into the graph' },
    {
      label: `${format(repository.declarations)} declarations`,
      detail: 'classes, interfaces, functions, methods and more',
    },
  );

  // A standard-library module, in whichever language. `builtin` and `node` were the only kinds when
  // this was written; `stdlib` covers Python, Java and Go, and omitting it reported zero for all three.
  const runtime =
    (repository.externalsByKind.builtin ?? 0) +
    (repository.externalsByKind.node ?? 0) +
    (repository.externalsByKind.stdlib ?? 0);

  // Every dependency ecosystem, summed, with the kinds named in the detail rather than assumed to be
  // npm. A Maven or Go dependency counted for nothing here.
  const ecosystems = Object.entries(repository.externalsByKind).filter(
    ([kind]) => kind !== 'builtin' && kind !== 'node' && kind !== 'stdlib' && kind !== 'outside-analysis',
  );
  const packages = ecosystems.reduce((total, [, count]) => total + count, 0);

  if (runtime > 0) {
    items.push({ label: 'Standard library', detail: `${format(runtime)} modules imported` });
  }

  if (packages > 0) {
    items.push({
      label: `${format(packages)} packages`,
      detail: `external dependencies reached from this repository, from ${ecosystems
        .map(([kind]) => kind)
        .join(', ')}`,
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
