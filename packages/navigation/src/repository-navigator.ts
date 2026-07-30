import { listing } from '@traceiq/explorer';
import type { RepositoryGraphApi } from '@traceiq/graph-api';

import { dependencyNavigationOf } from './dependency-navigation.js';
import { NavigationContext } from './navigation-context.js';
import { explainRouteOf, routeSummariesOf } from './route-explanation.js';
import { architectureNavigationOf } from './trees.js';
import type {
  ArchitectureNavigation,
  DependencyNavigation,
  DependencySubject,
  Listing,
  OperationProfile,
  Profiled,
  RouteExplanationView,
  RouteSelector,
  RouteSummary,
} from './types.js';

/**
 * The repository navigation layer.
 *
 * Four operations combining route explanation, architecture navigation and dependency navigation.
 * Every future interface — CLI, REST API, web UI, AI assistant — consumes this.
 *
 * **Everything returned already exists in the graph.** Nothing is predicted, ranked, scored or
 * generated. A route is never reported under a path the graph does not state, and where prefix
 * composition is unsupported the response says so rather than guessing.
 *
 * **It reuses rather than reimplements.** Repository Explorer answers structure, Explain Symbol
 * answers a handler, Impact Analysis answers reach, Repository Health answers condition, and the
 * Query Engine splits a route's chain. All of them run over **one** memoising graph adapter, so the
 * database is read once for the whole layer and only the explorer builds a whole-graph index.
 *
 * An instance is a snapshot of one immutable revision, so repeated calls return identical results.
 */
export class RepositoryNavigator {
  readonly #context: NavigationContext;

  constructor(api: RepositoryGraphApi) {
    this.#context = new NavigationContext(api);
  }

  /**
   * Everything the repository records about one route.
   *
   * Selected by method and path — `{ method: 'GET', path: '/users/:id' }` — or by identifier. Returns
   * `null` when the graph holds no such route, rather than inventing one.
   */
  explainRoute(route: RouteSelector): RouteExplanationView | null {
    return explainRouteOf(this.#context, route);
  }

  /** Every route the graph holds, with its method, written path and composition state. */
  routes(): Listing<RouteSummary> {
    return listing(routeSummariesOf(this.#context));
  }

  /** The repository's architecture: Repository Explorer's grouping, plus four navigation trees. */
  architecture(): ArchitectureNavigation {
    return architectureNavigationOf(this.#context);
  }

  /**
   * Dependency navigation for a package, a file, a declaration or a route.
   *
   * A package is named — `{ package: 'packages/health' }`; anything else is an identifier.
   */
  dependencies(subject: DependencySubject): DependencyNavigation | null {
    return dependencyNavigationOf(this.#context, subject);
  }

  /**
   * Runs an operation and reports what it cost.
   *
   * Measures what reached the database after caching, and how much came from reuse. **No timing**:
   * responses must be byte-identical for identical input, so callers time the call themselves.
   */
  profile<T>(operation: string, run: (navigator: RepositoryNavigator) => T): Profiled<T> {
    const before = {
      graph: this.#context.graph.graphCalls,
      hits: this.#context.graph.hits,
      queries: this.#context.queryEngineCalls,
      explorer: this.#context.explorerCalls,
    };

    const result = run(this);

    const profile: OperationProfile = {
      operation,
      graphApiCalls: this.#context.graph.graphCalls - before.graph,
      cacheHits: this.#context.graph.hits - before.hits,
      queryEngineCalls: this.#context.queryEngineCalls - before.queries,
      explorerCalls: this.#context.explorerCalls - before.explorer,
      largestTraversal: {
        name: 'repository-graph',
        nodes: this.#context.overview().graph.nodes,
      },
      largestResult: largestResultOf(result),
    };

    return { result, profile };
  }
}

/**
 * The biggest list in a response.
 *
 * Walks the result looking for `Listing` shapes rather than being told where they are, so a new field
 * cannot be forgotten. Bounded by the response, which is itself capped.
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
