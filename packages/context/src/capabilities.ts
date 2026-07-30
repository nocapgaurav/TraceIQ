import type { ExplainSymbolResult } from '@traceiq/explain';
import type {
  ArchitectureView,
  CycleReport,
  DependencyView,
  FileView,
  HotspotReport,
  Listing,
  PackageSummary,
  PackageView,
  RepositoryOverview,
  SearchQuery,
  SearchResults,
  SymbolView,
} from '@traceiq/explorer';
import type { RepositoryHealthReport } from '@traceiq/health';
import type { ImpactAnalysisResult } from '@traceiq/impact';
import type { RouteExplanation, RouteResult } from '@traceiq/query';
import type { NodeId } from '@traceiq/types';

/**
 * The capabilities this package composes, and nothing more.
 *
 * **The builder is given these; it never constructs them and never sees a graph.** There is no
 * `RepositoryGraphApi` anywhere in this package's public surface, so it cannot traverse, cannot reach a
 * database and cannot open a file — the boundary is enforced by the type, not by a convention.
 *
 * Each interface lists only the operations actually called, so a reader sees the whole consumed surface
 * and a test can count every call. `RepositoryExplorer`, `SymbolExplainer`, `ImpactAnalyzer`,
 * `RepositoryHealthAnalyzer` and `QueryEngine` satisfy them structurally.
 *
 * `RepositoryNavigator` is deliberately absent: it is not in the permitted reuse set, and it is not
 * needed — `QueryEngine.explainRoute` already splits a route's chain into middleware and handler.
 */
export interface ExplorerCapability {
  overview(): RepositoryOverview;
  architecture(): ArchitectureView;
  hotspots(): HotspotReport;
  cycles(): CycleReport;
  browsePackages(): Listing<PackageSummary>;
  browsePackage(name: string): PackageView | null;
  browseFile(id: NodeId): FileView | null;
  browseSymbol(id: NodeId): SymbolView | null;
  dependencies(id: NodeId): DependencyView | null;
  search(query: SearchQuery): SearchResults;
}

export interface ExplainCapability {
  explain(id: NodeId): ExplainSymbolResult | null;
}

export interface ImpactCapability {
  analyze(id: NodeId): ImpactAnalysisResult | null;
}

export interface HealthCapability {
  analyze(): RepositoryHealthReport;
}

export interface QueryCapability {
  explainRoute(routeId: NodeId): RouteExplanation | null;
  findRoutes(): readonly RouteResult[];
}

export interface ContextCapabilities {
  readonly explorer: ExplorerCapability;
  readonly explain: ExplainCapability;
  readonly impact: ImpactCapability;
  readonly health: HealthCapability;
  readonly queries: QueryCapability;
}

/**
 * Counts every capability call one build makes.
 *
 * Wrapping rather than instrumenting each builder keeps the composition free of bookkeeping, and makes
 * "no duplicated assembly" measurable: a build that called the same operation twice shows it here.
 */
export class CountingCapabilities implements ContextCapabilities {
  readonly explorer: ExplorerCapability;
  readonly explain: ExplainCapability;
  readonly impact: ImpactCapability;
  readonly health: HealthCapability;
  readonly queries: QueryCapability;

  readonly calls = new Map<string, number>();

  constructor(inner: ContextCapabilities) {
    const count = <T>(name: string, read: () => T): T => {
      this.calls.set(name, (this.calls.get(name) ?? 0) + 1);

      return read();
    };

    this.explorer = {
      overview: () => count('explorer.overview', () => inner.explorer.overview()),
      architecture: () => count('explorer.architecture', () => inner.explorer.architecture()),
      hotspots: () => count('explorer.hotspots', () => inner.explorer.hotspots()),
      cycles: () => count('explorer.cycles', () => inner.explorer.cycles()),
      browsePackages: () => count('explorer.browsePackages', () => inner.explorer.browsePackages()),
      browsePackage: (name) => count('explorer.browsePackage', () => inner.explorer.browsePackage(name)),
      browseFile: (id) => count('explorer.browseFile', () => inner.explorer.browseFile(id)),
      browseSymbol: (id) => count('explorer.browseSymbol', () => inner.explorer.browseSymbol(id)),
      dependencies: (id) => count('explorer.dependencies', () => inner.explorer.dependencies(id)),
      search: (query) => count('explorer.search', () => inner.explorer.search(query)),
    };

    this.explain = {
      explain: (id) => count('explain.explain', () => inner.explain.explain(id)),
    };

    this.impact = {
      analyze: (id) => count('impact.analyze', () => inner.impact.analyze(id)),
    };

    this.health = {
      analyze: () => count('health.analyze', () => inner.health.analyze()),
    };

    this.queries = {
      explainRoute: (id) => count('queries.explainRoute', () => inner.queries.explainRoute(id)),
      findRoutes: () => count('queries.findRoutes', () => inner.queries.findRoutes()),
    };
  }

  /** Call counts by operation, in alphabetical order so the statistics are deterministic. */
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.calls.entries()].sort((left, right) => left[0].localeCompare(right[0])));
  }

  total(): number {
    return [...this.calls.values()].reduce((sum, count) => sum + count, 0);
  }
}
