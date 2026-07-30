import type { ExplainSymbolResult } from '@traceiq/explain';
import type {
  CycleReport,
  FileView,
  HotspotReport,
  Listing,
  PackageView,
  RepositoryOverview,
  SearchResults,
  SymbolView,
} from '@traceiq/explorer';
import type { RepositoryHealthReport } from '@traceiq/health';
import type { ImpactAnalysisResult } from '@traceiq/impact';
import type {
  ArchitectureNavigation,
  DependencyNavigation,
  RouteExplanationView,
  RouteSummary,
} from '@traceiq/navigation';
import type { ScanSummary } from '@traceiq/pipeline';

import { counted, fields, heading, indent, list, sections, short, table } from './format.js';

/**
 * One renderer per command.
 *
 * Rendering is the CLI's **only** contribution: every number and every list here was computed by an
 * analysis package. Nothing is recomputed, re-sorted or re-derived — a renderer reads a result object
 * and lays it out.
 *
 * Output is deterministic: no clock, no terminal width, no environment, and every capped list prints
 * `shown of total` so a cap is visible.
 */

/** How many rows a table prints before saying how many more there are. */
const ROWS = 20;

function limited<T>(entries: readonly T[], rows = ROWS): readonly T[] {
  return entries.slice(0, rows);
}

function more(shown: number, total: number): string | null {
  return total > shown ? `... ${total - shown} more` : null;
}

export function renderScan(summary: ScanSummary): string {
  return sections(
    heading(`Scanned ${summary.repository}`),
    fields([
      ['repository', summary.repositoryPath],
      ['database', summary.databasePath],
      ['files', summary.files],
      ['declarations', summary.declarations],
      ['nodes', summary.nodes],
      ['edges', summary.edges],
      ['routes', summary.routes],
      ['environment variables', summary.environmentVariables],
      ['external packages', summary.externalPackages],
      ['call edges', summary.callEdges],
      ['unbound calls', summary.unresolvedCalls],
      ['unresolved references', summary.unresolvedReferences],
    ]),
  );
}

export function renderOverview(overview: RepositoryOverview): string {
  const kinds = Object.entries(overview.graph.nodesByKind)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => [kind, count] as const);

  const relationships = Object.entries(overview.graph.relationshipCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => [type, count] as const);

  return sections(
    heading('Repository'),
    fields([
      ['files', overview.repository.files],
      ['declarations', overview.repository.declarations],
      ['classes', overview.repository.classes],
      ['interfaces', overview.repository.interfaces],
      ['functions', overview.repository.functions],
      ['methods', overview.repository.methods],
      ['routes', overview.repository.routes],
      ['environment variables', overview.repository.environmentVariables],
      ['external packages', overview.repository.externalPackages],
    ]),
    heading('Graph'),
    fields([
      ['nodes', overview.graph.nodes],
      ['edges', overview.graph.edges],
      ['unresolved references', overview.graph.unresolvedReferences],
    ]),
    indent(table([{ header: 'kind' }, { header: 'count', align: 'right' }], kinds)),
    indent(table([{ header: 'relationship' }, { header: 'count', align: 'right' }], relationships)),
    heading('Health'),
    fields([
      ['call graph coverage', overview.health.callGraphCoverage],
      ['reference coverage', overview.health.referenceCoverage],
      ['max call depth', overview.health.maxCallDepth],
      ['declarations in cycles', overview.health.declarationsInCycles],
      ['isolated declarations', overview.health.isolatedDeclarations],
    ]),
    heading(`Packages (${overview.packages.total})`),
    table(
      [{ header: 'package' }, { header: 'files', align: 'right' }, { header: 'declarations', align: 'right' }],
      limited(overview.packages.entries).map((entry) => [entry.name, entry.files, entry.declarations]),
    ),
    more(Math.min(ROWS, overview.packages.entries.length), overview.packages.total),
    renderLimitations(overview.limitations),
  );
}

export function renderArchitecture(architecture: ArchitectureNavigation): string {
  const groups = architecture.architectureTree.entries;

  return sections(
    heading('Architecture'),
    table(
      [{ header: 'group' }, { header: 'category' }, { header: 'count', align: 'right' }],
      groups.map((group) => [group.group, group.category, group.entries.total]),
    ),
    heading('Roles by package'),
    architecture.roleTree.entries.length === 0
      ? '(none)'
      : architecture.roleTree.entries
          .map((role) =>
            sections(
              `${role.role} (${role.total})`,
              indent(
                list(
                  role.packages.entries.map(
                    (entry) => `${entry.name}  ${counted(entry.declarations.entries.length, entry.declarations.total, entry.declarations.truncated)}`,
                  ),
                ),
              ),
            ),
          )
          .join('\n\n'),
    heading('Package dependencies'),
    table(
      [
        { header: 'package' },
        { header: 'depends on', align: 'right' },
        { header: 'depended on by', align: 'right' },
      ],
      limited(architecture.dependencyTree.entries).map((entry) => [
        entry.name,
        entry.dependsOn.total,
        entry.dependedOnBy.total,
      ]),
    ),
    more(Math.min(ROWS, architecture.dependencyTree.entries.length), architecture.dependencyTree.total),
    renderLimitations(architecture.limitations),
  );
}

export function renderPackages(packages: Listing<{ name: string; files: number; declarations: number; dependencies: number; dependents: number }>): string {
  return sections(
    heading(`Packages (${packages.total})`),
    table(
      [
        { header: 'package' },
        { header: 'files', align: 'right' },
        { header: 'declarations', align: 'right' },
        { header: 'deps', align: 'right' },
        { header: 'dependents', align: 'right' },
      ],
      packages.entries.map((entry) => [
        entry.name,
        entry.files,
        entry.declarations,
        entry.dependencies,
        entry.dependents,
      ]),
    ),
  );
}

export function renderPackage(view: PackageView): string {
  const kinds = Object.entries(view.statistics.declarationsByKind).map(([kind, count]) => [kind, count] as const);
  const roles = Object.entries(view.roles)
    .filter(([, nodes]) => nodes.length > 0)
    .map(([role, nodes]) => [role, nodes.length] as const);

  return sections(
    heading(view.name),
    fields([
      ['files', view.statistics.files],
      ['declarations', view.statistics.declarations],
    ]),
    kinds.length === 0 ? null : indent(table([{ header: 'kind' }, { header: 'count', align: 'right' }], kinds)),
    roles.length === 0 ? null : sections(heading('Roles'), table([{ header: 'role' }, { header: 'count', align: 'right' }], roles)),
    heading('Files'),
    list(limited(view.files.entries).map((file) => short(file.id))),
    more(Math.min(ROWS, view.files.entries.length), view.files.total),
    heading('Dependencies'),
    table(
      [{ header: 'package' }, { header: 'edges', align: 'right' }],
      view.dependencies.entries.map((entry) => [entry.name, entry.edges.total]),
    ),
    heading('Dependents'),
    table(
      [{ header: 'package' }, { header: 'edges', align: 'right' }],
      view.dependents.entries.map((entry) => [entry.name, entry.edges.total]),
    ),
    heading('External packages'),
    list(view.externalPackages.entries.map((entry) => short(entry.id))),
    renderLimitations(view.limitations),
  );
}

export function renderFile(view: FileView): string {
  const kinds = Object.entries(view.statistics.declarationsByKind).map(([kind, count]) => [kind, count] as const);

  return sections(
    heading(short(view.file.id)),
    fields([
      ['package', view.packageName],
      ['declarations', view.statistics.declarations],
      ['imports', view.statistics.imports],
      ['exports', view.statistics.exports],
      ['fan-in', view.statistics.fanIn],
      ['fan-out', view.statistics.fanOut],
    ]),
    kinds.length === 0 ? null : indent(table([{ header: 'kind' }, { header: 'count', align: 'right' }], kinds)),
    heading(`Declarations (${counted(Math.min(ROWS, view.declarations.entries.length), view.declarations.total, view.declarations.total > ROWS)})`),
    table(
      [{ header: 'kind' }, { header: 'name' }],
      limited(view.declarations.entries).map((entry) => [entry.kind, entry.name]),
    ),
    more(Math.min(ROWS, view.declarations.entries.length), view.declarations.total),
    heading('Imports'),
    list(limited(view.imports.entries).map((entry) => short(entry.target?.id ?? entry.edge.targetId))),
    more(Math.min(ROWS, view.imports.entries.length), view.imports.total),
    heading('External packages'),
    list(view.externalPackages.entries.map((entry) => short(entry.id))),
    view.environmentVariables.total === 0
      ? null
      : sections(heading('Environment variables'), list(view.environmentVariables.entries.map((entry) => entry.name))),
    view.routes.total === 0
      ? null
      : sections(heading('Routes'), list(view.routes.entries.map((entry) => `${entry.method} ${entry.path}`))),
  );
}

export function renderSymbol(view: SymbolView): string {
  const explain = view.explain;

  return sections(
    heading(short(explain.declaration.node.id)),
    fields([
      ['kind', explain.kind],
      ['file', explain.sourceFile?.path ?? '(unknown)'],
      ['line', explain.locations[0]?.startLine ?? 0],
      ['package', view.packageName ?? '(none)'],
      ['confidence', explain.confidence],
      ['enclosing', explain.enclosingDeclaration?.declaration?.name ?? '(file level)'],
      ['roles', explain.declaration.roles.map((entry) => entry.role).join(', ') || '(none)'],
    ]),
    renderCallSection('Callers', explain.incomingCalls.map((entry) => short(entry.edge.sourceId))),
    renderCallSection('Callees', explain.outgoingCalls.map((entry) => short(entry.edge.targetId))),
    renderCallSection('References', explain.references.map((entry) => `${entry.edge.type}  ${short(entry.edge.sourceId)}`)),
    view.children.total === 0
      ? null
      : sections(heading(`Children (${view.children.total})`), list(limited(view.children.entries).map((entry) => `${entry.kind}  ${entry.name}`))),
    heading('Impact'),
    fields([
      ['directly affected', view.impact.directlyAffected],
      ['indirectly affected', view.impact.indirectlyAffected],
      ['max depth', view.impact.maxDepth],
      ['routes affected', view.impact.routesAffected],
    ]),
    heading('Health'),
    fields([
      ['fan-in', view.health.fanIn],
      ['fan-out', view.health.fanOut],
      ['isolated', String(view.health.isolated)],
      ['in cycle', String(view.health.inCycle)],
      ['recursive', String(view.health.recursive)],
    ]),
    renderEnvironment(explain),
    renderLimitations(explain.limitations),
  );
}

export function renderImpact(result: ImpactAnalysisResult): string {
  return sections(
    heading(`Impact of changing ${short(result.target.node.id)}`),
    fields([
      ['kind', result.target.node.kind],
      ['directly affected', result.directlyAffected.length],
      ['indirectly affected', result.indirectlyAffected.length],
      ['unknown', result.unknown.length],
      ['max depth', result.statistics.maxDepth],
      ['nodes visited', result.statistics.nodesVisited],
    ]),
    heading(`DIRECT (${result.directlyAffected.length})`),
    table(
      [{ header: 'depth', align: 'right' }, { header: 'via' }, { header: 'node' }],
      limited(result.directlyAffected).map((entry) => [entry.depth, entry.via.type, short(entry.node.id)]),
    ),
    more(Math.min(ROWS, result.directlyAffected.length), result.directlyAffected.length),
    heading(`INDIRECT (${result.indirectlyAffected.length})`),
    table(
      [{ header: 'depth', align: 'right' }, { header: 'via' }, { header: 'node' }],
      limited(result.indirectlyAffected).map((entry) => [entry.depth, entry.via.type, short(entry.node.id)]),
    ),
    more(Math.min(ROWS, result.indirectlyAffected.length), result.indirectlyAffected.length),
    heading(`UNKNOWN (${result.unknown.length})`),
    table(
      [{ header: 'scope' }, { header: 'reason' }, { header: 'text' }],
      limited(result.unknown.filter((entry) => entry.scope === 'declaration')).map((entry) => [
        entry.scope,
        entry.result.reference.reason,
        entry.result.reference.text,
      ]),
    ),
    result.routesAffected.length === 0
      ? null
      : sections(
          heading(`Routes affected (${result.routesAffected.length})`),
          list(result.routesAffected.map((entry) => `${entry.route.method} ${entry.route.path}`)),
        ),
    renderLimitations(result.limitations),
  );
}

export function renderRoutes(routes: Listing<RouteSummary>): string {
  return sections(
    heading(`Routes (${routes.total})`),
    table(
      [{ header: 'method' }, { header: 'path' }, { header: 'handlers', align: 'right' }, { header: 'composed' }],
      routes.entries.map((entry) => [entry.method, entry.path, entry.handlers, String(entry.composed)]),
    ),
  );
}

export function renderRoute(view: RouteExplanationView): string {
  return sections(
    heading(`${view.method} ${view.route.path}`),
    fields([
      ['written path', view.route.path],
      ['effective path', view.route.effectivePath],
      ['prefix composed', String(view.route.composed)],
      ['handlers', view.route.handlers],
    ]),
    heading('Chain'),
    table(
      [{ header: 'position' }, { header: 'ordinal', align: 'right' }, { header: 'declaration' }],
      view.chain.map((step) => [step.position, step.ordinal ?? '', short(step.declaration?.id ?? '(unlinked)')]),
    ),
    view.unresolvedHandlers.length === 0
      ? null
      : sections(
          heading(`Unlinked handlers (${view.unresolvedHandlers.length})`),
          list(view.unresolvedHandlers.map((entry) => `${entry.text}  (${entry.reason})`)),
        ),
    heading('Reached'),
    fields([
      ['controllers', view.controllers.map((entry) => entry.ref.name).join(', ') || '(none)'],
      ['services', view.services.map((entry) => entry.ref.name).join(', ') || '(none)'],
      ['repositories', view.repositories.map((entry) => entry.ref.name).join(', ') || '(none)'],
    ]),
    view.environmentVariables.total === 0
      ? null
      : sections(heading('Environment variables'), list(view.environmentVariables.entries.map((entry) => entry.name))),
    view.externalPackages.total === 0
      ? null
      : sections(heading('External packages'), list(view.externalPackages.entries.map((entry) => short(entry.id)))),
    heading('Call graph'),
    fields([
      ['callers', view.callGraph.callers],
      ['callees', view.callGraph.callees],
      ['reached', view.callGraph.reached],
      ['max depth', view.callGraph.maxDepth],
    ]),
    heading('Health'),
    fields([
      ['handlers linked', view.health.handlersLinked],
      ['handlers unlinked', view.health.handlersUnlinked],
      ['isolated handlers', view.health.isolatedHandlers],
    ]),
    renderLimitations(view.limitations),
  );
}

export function renderHealth(report: RepositoryHealthReport): string {
  const findings = report.findings.map((finding) => [
    finding.category,
    finding.code,
    finding.nodeCount,
    finding.confidence,
  ] as const);

  return sections(
    heading('Repository health'),
    fields([
      ['files', report.summary.files],
      ['declarations', report.summary.declarations],
      ['nodes', report.summary.graph.nodes],
      ['edges', report.summary.graph.edges],
      ['unresolved references', report.summary.graph.unresolvedReferences],
    ]),
    heading('Metrics'),
    fields([
      ['declarations per file', report.metrics.averageDeclarationsPerFile],
      ['references per declaration', report.metrics.averageReferencesPerDeclaration],
      ['graph density', report.metrics.graphDensity],
      ['call graph coverage', report.metrics.callGraphCoverage],
      ['reference coverage', report.metrics.referenceCoverage],
      ['max call depth', report.metrics.maxCallDepth],
    ]),
    heading('Call graph'),
    fields([
      ['call edges', report.callGraphHealth.callEdges],
      ['unresolved calls', report.callGraphHealth.unresolvedCalls],
      ['entry points', report.callGraphHealth.entryPoints],
      ['recursive declarations', report.callGraphHealth.recursive.count],
      ['cycles', report.callGraphHealth.cycles.length],
      ['clusters', report.callGraphHealth.clusters.count],
      ['largest cluster', report.callGraphHealth.clusters.largest],
    ]),
    heading('Dependencies'),
    fields([
      ['isolated declarations', report.dependencyHealth.isolated.count],
      ['without incoming reference', report.dependencyHealth.withoutIncoming.count],
      ['without outgoing reference', report.dependencyHealth.withoutOutgoing.count],
    ]),
    heading(`Findings (${report.findings.length})`),
    table(
      [{ header: 'category' }, { header: 'finding' }, { header: 'nodes', align: 'right' }, { header: 'confidence' }],
      findings,
    ),
    renderLimitations(report.limitations),
  );
}

export function renderSearch(results: SearchResults): string {
  const group = (name: string, entries: Listing<{ id: string; kind: string; name: string }>): string | null =>
    entries.total === 0
      ? null
      : sections(
          heading(`${name} (${counted(Math.min(ROWS, entries.entries.length), entries.total, entries.total > ROWS)})`),
          table(
            [{ header: 'kind' }, { header: 'identifier' }],
            limited(entries.entries).map((entry) => [entry.kind, short(entry.id)]),
          ),
          more(Math.min(ROWS, entries.entries.length), entries.total),
        );

  if (results.total === 0) {
    return sections(heading('Search'), fields([['match', results.match]]), '(no results)');
  }

  return sections(
    heading(`Search (${results.total})`),
    fields([['match', results.match]]),
    group('Declarations', results.declarations),
    group('Files', results.files),
    group('Routes', results.routes),
    group('Environment variables', results.environmentVariables),
    group('External packages', results.externalPackages),
  );
}

export function renderDependencies(view: DependencyNavigation): string {
  return sections(
    heading(`Dependencies of ${view.subject.name}`),
    fields([
      ['subject', view.subject.kind],
      ['files', view.subject.files.total],
    ]),
    heading('DIRECT'),
    fields([
      ['dependencies', view.directDependencies.total],
      ['dependents', view.reverseDependencies.total],
      ['imports out/in', `${view.importGraph.outgoing.total}/${view.importGraph.incoming.total}`],
      ['references out/in', `${view.referenceGraph.outgoing.total}/${view.referenceGraph.incoming.total}`],
      ['calls out/in', `${view.callGraph.outgoing.total}/${view.callGraph.incoming.total}`],
    ]),
    heading('INDIRECT'),
    fields([
      ['dependency closure', view.closure.total],
      ['reverse closure', view.reverseClosure.total],
      ['cycles', view.cycles.length],
      ['connected component', view.connectedComponent.total],
    ]),
    heading('Closure'),
    table(
      [{ header: 'depth', align: 'right' }, { header: 'node' }],
      limited(view.closure.entries).map((entry) => [entry.depth, short(entry.node.id)]),
    ),
    more(Math.min(ROWS, view.closure.entries.length), view.closure.total),
    view.cycles.length === 0
      ? null
      : sections(
          heading(`Cycles (${view.cycles.length})`),
          list(view.cycles.map((cycle) => `${cycle.kind}: ${cycle.nodes.map((entry) => short(entry.id)).join(' -> ')}`)),
        ),
    renderLimitations(view.limitations),
  );
}

export function renderCycles(report: CycleReport): string {
  const group = (name: string, cycles: readonly { nodes: readonly { id: string }[] }[]): string | null =>
    cycles.length === 0
      ? null
      : sections(
          heading(`${name} (${cycles.length})`),
          list(limited(cycles).map((cycle) => cycle.nodes.map((entry) => short(entry.id)).join(' -> '))),
          more(Math.min(ROWS, cycles.length), cycles.length),
        );

  return sections(
    heading('Cycles'),
    fields([
      ['import', report.totals.import],
      ['call', report.totals.call],
      ['reference', report.totals.reference],
      ['inheritance', report.totals.inheritance],
      ['largest', report.largest?.nodes.length ?? 0],
    ]),
    group('Import cycles', report.importCycles.entries),
    group('Call cycles', report.callCycles.entries),
    group('Reference cycles', report.referenceCycles.entries),
    group('Inheritance cycles', report.inheritanceCycles.entries),
    renderLimitations(report.limitations),
  );
}

export function renderHotspots(report: HotspotReport): string {
  const metrics = (name: string, entries: Listing<{ node: { id: string }; fanIn: number; fanOut: number }>): string =>
    sections(
      heading(name),
      table(
        [{ header: 'fan-in', align: 'right' }, { header: 'fan-out', align: 'right' }, { header: 'node' }],
        limited(entries.entries, 10).map((entry) => [entry.fanIn, entry.fanOut, short(entry.node.id)]),
      ),
    );

  return sections(
    heading('Hotspots'),
    metrics('Most referenced', report.mostReferenced),
    metrics('Largest fan-out', report.largestFanOut),
    metrics('Most connected files', report.mostConnectedFiles),
    heading('Distribution'),
    table(
      [{ header: 'measure' }, { header: 'min', align: 'right' }, { header: 'median', align: 'right' }, { header: 'p90', align: 'right' }, { header: 'max', align: 'right' }],
      [
        ['fan-in', report.fanIn.min, report.fanIn.median, report.fanIn.p90, report.fanIn.max],
        ['fan-out', report.fanOut.min, report.fanOut.median, report.fanOut.p90, report.fanOut.max],
      ],
    ),
    report.largestStronglyConnectedComponent === null
      ? null
      : sections(
          heading('Largest strongly connected component'),
          list(report.largestStronglyConnectedComponent.nodes.map((entry) => short(entry.id))),
        ),
  );
}

function renderCallSection(name: string, entries: readonly string[]): string {
  return sections(
    heading(`${name} (${entries.length})`),
    list(limited(entries)),
    more(Math.min(ROWS, entries.length), entries.length) ?? '',
  );
}

function renderEnvironment(explain: ExplainSymbolResult): string | null {
  return explain.environmentVariables.length === 0
    ? null
    : sections(
        heading('Environment variables'),
        list(explain.environmentVariables.map((entry) => `${entry.node.name}  (${entry.reads.length} read${entry.reads.length === 1 ? '' : 's'})`)),
      );
}

/**
 * Limitations, as codes with their fixed text.
 *
 * Always printed when present. A result that cannot tell you something should say so where you read
 * it, not in documentation you have to go and find.
 */
function renderLimitations(
  limitations: readonly { code: string; detail: string; affected: number | null }[],
): string | null {
  return limitations.length === 0
    ? null
    : sections(
        heading('Limitations'),
        list(limitations.map((entry) => `${entry.code}${entry.affected === null ? '' : ` (${entry.affected})`}: ${entry.detail}`)),
      );
}
