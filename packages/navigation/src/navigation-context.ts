import { CachingGraph, RepositoryExplorer, packageOf } from '@traceiq/explorer';
import type { ArchitectureView, Listing, PackageSummary, RepositoryOverview } from '@traceiq/explorer';
import type { GraphNode, RepositoryGraphApi } from '@traceiq/graph-api';
import { QueryEngine } from '@traceiq/query';
import type { NodeId, Role } from '@traceiq/types';

import { LIMITATION_DETAIL } from './limitations.js';
import type { Limitation, LimitationCode, TreeRef } from './types.js';

/**
 * Everything navigation shares, built at most once each.
 *
 * **One graph read for the whole layer.** `RepositoryExplorer` is constructed over this context's
 * `CachingGraph`, so the explorer's own cache delegates here on a miss and the database is read once
 * however many capabilities run. Only the explorer builds a whole-graph index — navigation never
 * builds a second one, which is why it asks the explorer for structure rather than indexing itself.
 *
 * The `QueryEngine` exists here for the one thing the explorer does not expose: `explainRoute`, which
 * splits a route's chain into middleware and handler and names the handlers it could not link.
 */
export class NavigationContext {
  readonly graph: CachingGraph;
  readonly explorer: RepositoryExplorer;
  readonly queries: QueryEngine;

  queryEngineCalls = 0;
  explorerCalls = 0;

  #overview: RepositoryOverview | null = null;
  #architecture: ArchitectureView | null = null;
  #packages: Listing<PackageSummary> | null = null;

  constructor(api: RepositoryGraphApi) {
    this.graph = new CachingGraph(api);
    this.explorer = new RepositoryExplorer(this.graph);
    this.queries = new QueryEngine(this.graph);
  }

  /** Counts an explorer call and returns its result, so reuse is measured rather than claimed. */
  explore<T>(read: (explorer: RepositoryExplorer) => T): T {
    this.explorerCalls += 1;

    return read(this.explorer);
  }

  query<T>(read: (queries: QueryEngine) => T): T {
    this.queryEngineCalls += 1;

    return read(this.queries);
  }

  overview(): RepositoryOverview {
    this.#overview ??= this.explore((explorer) => explorer.overview());

    return this.#overview;
  }

  architecture(): ArchitectureView {
    this.#architecture ??= this.explore((explorer) => explorer.architecture());

    return this.#architecture;
  }

  packages(): Listing<PackageSummary> {
    this.#packages ??= this.explore((explorer) => explorer.browsePackages());

    return this.#packages;
  }

  node(id: NodeId): GraphNode | null {
    return this.graph.getNode(id);
  }
}

/**
 * The declarations carrying each architectural role.
 *
 * One place rather than three: the route explanation, the architecture tree and the role tree all
 * need this mapping, and writing it out per consumer meant the same six lines three times. Written
 * as a literal so the record is exhaustive by type — a new role in the vocabulary becomes a compile
 * error here instead of a silently missing group.
 */
export function roleGroupsOf(context: NavigationContext): Readonly<Record<Role, readonly GraphNode[]>> {
  const architecture = context.architecture();

  return {
    Controller: architecture.controllers.entries,
    Service: architecture.services.entries,
    Repository: architecture.repositories.entries,
    Middleware: architecture.middleware.entries,
    Model: architecture.models.entries,
    Test: architecture.tests.entries,
  };
}

/**
 * Maps a list that is **already capped**, keeping its true `total` and `truncated`.
 *
 * Repository Explorer caps its own lists, so re-wrapping the visible entries would report the cap as
 * the total and quietly understate the repository. Only the entries are transformed.
 */
export function mapListing<T, U>(source: Listing<T>, transform: (entry: T) => U): Listing<U> {
  return {
    entries: source.entries.map(transform),
    total: source.total,
    truncated: source.truncated,
  };
}

/** A node as a tree carries it. */
export function treeRef(node: GraphNode): TreeRef {
  return { id: node.id, name: node.name, kind: node.kind };
}

/** The package a node belongs to, or `null` when the graph records no file for it. */
export function packageOfNode(node: GraphNode): string | null {
  const fileId = node.kind === 'File' ? node.id : node.fileId;

  return fileId === null ? null : packageOf(fileId.slice('file:'.length));
}

/**
 * Selects the limitations a response carries.
 *
 * `null` marks one that always holds; a number is how many parts of the response it bears on, and
 * zero means it does not apply and is omitted. Text is fixed per code and never composed.
 */
export function limitationsOf(
  codes: readonly LimitationCode[],
  counts: Partial<Record<LimitationCode, number | null>>,
): readonly Limitation[] {
  return codes.flatMap((code) => {
    const affected = code in counts ? (counts[code] ?? null) : null;

    return affected === 0 ? [] : [{ code, detail: LIMITATION_DETAIL[code], affected }];
  });
}
