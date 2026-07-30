import type { RepositoryGraphApi } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import { ExplorerContext } from './explorer-context.js';
import { searchOf } from './search.js';
import type {
  ArchitectureView,
  CycleReport,
  DependencyView,
  FileView,
  HotspotReport,
  Listing,
  OperationProfile,
  PackageSummary,
  PackageView,
  Profiled,
  RepositoryOverview,
  SearchQuery,
  SearchResults,
  SymbolView,
} from './types.js';
import {
  architectureViewOf,
  cycleReportOf,
  dependencyViewOf,
  fileViewOf,
  hotspotReportOf,
  overviewOf,
  packageSummariesOf,
  packageViewOf,
  symbolViewOf,
} from './views.js';
import { listing } from './listing.js';

/**
 * The read layer of TraceIQ.
 *
 * Ten navigation operations over one repository graph. Every future interface — CLI, REST API, web
 * UI, AI assistant — consumes this, and nothing else needs to know how the graph is stored.
 *
 * **Everything returned already exists in the graph.** Nothing is predicted, ranked, scored or
 * generated, and no relationship is inferred beyond what the graph states. The one derivation is the
 * package unit, which is a documented projection of file paths and says so.
 *
 * **It reuses rather than reimplements.** Explain Symbol assembles a symbol, Impact Analysis walks
 * the dependents closure, Repository Health computes the whole-graph index, metrics and algorithms.
 * Every one of them is constructed over a single memoising graph adapter, so three capabilities
 * reading the same node cost one read.
 *
 * **State is a cache, never a fact.** An instance holds one immutable revision, so repeated calls
 * return identical results; construct a new explorer to read a new revision.
 */
export class RepositoryExplorer {
  readonly #context: ExplorerContext;

  constructor(api: RepositoryGraphApi) {
    this.#context = new ExplorerContext(api);
  }

  /** Repository, architecture, package, graph and health summaries in one response. */
  overview(): RepositoryOverview {
    return overviewOf(this.#context);
  }

  /** A file with its declarations, wiring, routes, configuration and relationship counts. */
  browseFile(id: NodeId): FileView | null {
    return fileViewOf(this.#context, id);
  }

  /**
   * A declaration with everything recorded about it, plus navigation.
   *
   * Carries the whole `ExplainSymbolResult` rather than a copy of selected fields, so assembly lives
   * in one place. The explorer adds what Explain Symbol does not: children, an impact summary, a
   * health summary and the package.
   */
  browseSymbol(id: NodeId): SymbolView | null {
    return symbolViewOf(this.#context, id);
  }

  /** Every derived package, alphabetically. */
  browsePackages(): Listing<PackageSummary> {
    return listing(packageSummariesOf(this.#context));
  }

  /** One package: its files, cross-boundary dependencies and dependents, wiring and roles. */
  browsePackage(name: string): PackageView | null {
    return packageViewOf(this.#context, name);
  }

  /** Direct relationships and both transitive closures for a declaration or a file. */
  dependencies(id: NodeId): DependencyView | null {
    return dependencyViewOf(this.#context, id);
  }

  /** Grouped views by architectural role and by declaration kind. */
  architecture(): ArchitectureView {
    return architectureViewOf(this.#context);
  }

  /** Every import, call, reference and inheritance cycle, listed rather than counted. */
  cycles(): CycleReport {
    return cycleReportOf(this.#context);
  }

  /** The most connected declarations and files, and the largest strongly connected component. */
  hotspots(): HotspotReport {
    return hotspotReportOf(this.#context);
  }

  /** Exact or prefix search. Alphabetical, never ranked. */
  search(query: SearchQuery): SearchResults {
    return searchOf(this.#context, query);
  }

  /**
   * Runs an operation and reports what it cost.
   *
   * Wrapping rather than instrumenting every method keeps the ten operations free of profiling
   * concerns, and measures what actually reached the graph after caching rather than what was asked
   * for. **No timing is included**: elapsed milliseconds differ between runs and every response must
   * be byte-identical for identical input, so callers time the call themselves.
   */
  profile<T>(operation: string, run: (explorer: RepositoryExplorer) => T): Profiled<T> {
    const before = {
      graph: this.#context.graph.graphCalls,
      hits: this.#context.graph.hits,
      queries: this.#context.queryEngineCalls,
    };

    const result = run(this);

    const profile: OperationProfile = {
      operation,
      graphApiCalls: this.#context.graph.graphCalls - before.graph,
      cacheHits: this.#context.graph.hits - before.hits,
      queryEngineCalls: this.#context.queryEngineCalls - before.queries,
      largestTraversal: largestTraversalOf(this.#context),
      largestResult: largestResultOf(result),
    };

    return { result, profile };
  }
}

function largestTraversalOf(context: ExplorerContext): OperationProfile['largestTraversal'] {
  // Reported from what the context actually built, so an operation that touched no index says so.
  const index = context.builtIndex();

  return index === null
    ? { name: 'none', nodes: 0 }
    : { name: 'graph-index', nodes: index.nodeById.size };
}

/**
 * The biggest list in a response.
 *
 * Walks the result looking for `Listing` shapes rather than being told where they are, so a new
 * field cannot be forgotten. Bounded by the response, which is itself capped.
 */
function largestResultOf(result: unknown): OperationProfile['largestResult'] {
  let largest = { name: 'none', entries: 0 };

  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }

    if (isListing(value)) {
      if (value.total > largest.entries) {
        largest = { name: path, entries: value.total };
      }

      return;
    }

    if (Array.isArray(value)) {
      if (value.length > largest.entries) {
        largest = { name: path, entries: value.length };
      }

      return;
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, path === '' ? key : `${path}.${key}`);
    }
  };

  visit(result, '');

  return largest;
}

function isListing(value: object): value is { readonly total: number } {
  return 'entries' in value && 'total' in value && 'truncated' in value;
}
