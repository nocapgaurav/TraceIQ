import type { AnalysisJob, Overview } from '@/types/api';

/**
 * Which repository is this, and what is known about it?
 *
 * **Where the facts come from, and why.** The graph stores a repository name, but for anything analysed
 * from GitHub that name is the temporary workspace directory — `traceiq-analysis-Stvy8L` — because the
 * scanner derives it from the directory it was handed. The analysis record is the only place the real
 * `owner/name` exists, so that is what is read.
 *
 * The consequence is stated rather than hidden: identity is known for a repository analysed through the
 * GitHub flow, and unknown for one scanned by path from the CLI. Analyses live in the API's memory, so a
 * restart also loses it. Every field degrades independently instead of the whole block disappearing.
 *
 * Nothing here is inferred from a name. "React" is not assumed to be a UI library, and no description is
 * written — those would be invention, which is the one thing this product does not do.
 */
export interface IdentityField {
  readonly label: string;
  readonly value: string;
  /** Why this is known. Shown next to the value, so a claim never appears without its basis. */
  readonly evidence: string;
}

export interface RepositoryIdentity {
  /** `react`, or null when the repository was not analysed from GitHub. */
  readonly name: string | null;
  readonly owner: string | null;
  readonly githubUrl: string | null;
  /** Everything determinable, in display order. Undeterminable fields are absent, not blank. */
  readonly fields: readonly IdentityField[];
  /** Named fields that could not be determined, so the UI can say so once rather than per field. */
  readonly unknown: readonly string[];
  /** True when nothing at all identifies the repository — the CLI-scanned case. */
  readonly anonymous: boolean;
}

/**
 * The analysis that produced the graph currently loaded.
 *
 * The most recent **succeeded** one. A failed analysis left the previous graph in place, so it says
 * nothing about what is loaded now.
 */
export function latestAnalysis(entries: readonly AnalysisJob[] | undefined): AnalysisJob | null {
  return entries?.find((entry) => entry.status === 'succeeded' && entry.slug !== null) ?? null;
}

export function deriveIdentity(analysis: AnalysisJob | null, overview: Overview): RepositoryIdentity {
  const fields: IdentityField[] = [];
  const unknown: string[] = [];

  const owner = analysis?.slug?.split('/')[0] ?? null;
  const name = analysis?.slug?.split('/')[1] ?? null;

  if (owner !== null) {
    fields.push({ label: 'Owner', value: owner, evidence: 'from the analysed GitHub URL' });
  }

  if (analysis?.htmlUrl != null) {
    fields.push({ label: 'GitHub', value: analysis.htmlUrl, evidence: 'the repository that was analysed' });
  }

  /*
   * Language is a property of the analysis, not a detection.
   *
   * The scanner reads TypeScript projects and refuses anything else — a repository detected as anything
   * other than TypeScript fails before a graph exists. So every loaded graph is TypeScript by
   * construction, and saying so is honest where claiming to have detected it would not be.
   */
  fields.push({
    label: 'Language',
    value: 'TypeScript',
    evidence: 'the analysis reads TypeScript projects only',
  });

  /*
   * Visibility, where it is genuinely knowable.
   *
   * The analysis workflow accepts public GitHub repositories and nothing else: a private one fails at
   * the clone. So a repository that produced this graph through that flow is public — not a guess, a
   * consequence. Scanned from a path, visibility is simply not a question the graph can answer.
   */
  if (analysis !== null) {
    fields.push({
      label: 'Visibility',
      value: 'Public',
      evidence: 'only public repositories can be analysed',
    });
  } else {
    unknown.push('Visibility');
  }

  /*
   * Framework.
   *
   * Route extraction understands Express conventions and no others, so recorded routes mean Express was
   * recognised. With none recorded nothing follows — a repository may use a framework this version does
   * not read — so the field degrades rather than claiming "none".
   */
  if (overview.repository.routes > 0) {
    fields.push({
      label: 'Framework',
      value: 'Express',
      evidence: `${overview.repository.routes} HTTP routes recorded; route extraction reads Express conventions`,
    });
  } else {
    unknown.push('Framework');
  }

  // The scanner detects the package manager from the lockfile, but nothing carries it into the graph, so
  // no endpoint can report it. Named as unknown rather than omitted, so the gap is visible.
  unknown.push('Package manager');

  return {
    name,
    owner,
    githubUrl: analysis?.htmlUrl ?? null,
    fields,
    unknown,
    anonymous: analysis === null,
  };
}

export interface SummaryFact {
  readonly text: string;
  readonly evidence: string;
}

/**
 * The Analysis Summary: what this run actually established.
 *
 * Every line is a count the API reported or a shape read directly off those counts. A fact that is zero
 * is **left out rather than shown as zero** — "0 HTTP routes detected" is noise, and the absence of a
 * recorded route is not a finding about the repository.
 */
export function analysisSummary(overview: Overview): readonly SummaryFact[] {
  const { repository, packages, graph, architecture } = overview;
  const facts: SummaryFact[] = [];

  if (packages.total > 0) {
    facts.push({ text: `${plural(packages.total, 'package')}`, evidence: 'derived from file paths' });
  }

  facts.push({ text: `${plural(repository.files, 'file')}`, evidence: 'analysed into the graph' });
  facts.push({ text: `${plural(repository.declarations, 'declaration')}`, evidence: 'classes, interfaces, functions, methods and more' });

  if (graph.edges > 0) {
    facts.push({ text: `${plural(graph.edges, 'relationship')} resolved`, evidence: 'edges in the repository graph' });
  }

  /*
   * The layering, only when the analysis actually annotated every tier of it.
   *
   * "Controller → Service → Repository" is a claim about how the code is arranged, so it is made only
   * where all three roles were recorded. Two out of three is reported as the two that were found.
   */
  const layers = (['Controller', 'Service', 'Repository'] as const).filter(
    (role) => (architecture.roleCounts[role] ?? 0) > 0,
  );

  if (layers.length > 1) {
    facts.push({
      text: `${layers.join(' → ')} architecture`,
      evidence: layers.map((role) => `${count(architecture.roleCounts[role] ?? 0)} ${role}`).join(', '),
    });
  }

  if (repository.routes > 0) {
    facts.push({ text: `${plural(repository.routes, 'HTTP route')} detected`, evidence: 'registered in the repository' });
  }

  if (repository.environmentVariables > 0) {
    facts.push({
      text: `${plural(repository.environmentVariables, 'environment variable')} read`,
      evidence: 'read through process.env',
    });
  }

  if (repository.externalPackages > 0) {
    facts.push({ text: `${plural(repository.externalPackages, 'external package')}`, evidence: 'reached from this repository' });
  }

  return facts;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(value: number, singular: string): string {
  return `${count(value)} ${singular}${value === 1 ? '' : 's'}`;
}
