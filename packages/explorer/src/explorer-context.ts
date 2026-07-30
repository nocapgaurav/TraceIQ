import { SymbolExplainer } from '@traceiq/explain';
import type { GraphEdge, GraphNode, RepositoryGraphApi } from '@traceiq/graph-api';
import {
  buildGraphIndex,
  deriveFrom,
  type Adjacency,
  type Derived,
  type GraphIndex,
  type RepositoryHealthReport,
  RepositoryHealthAnalyzer,
} from '@traceiq/health';
import { ImpactAnalyzer } from '@traceiq/impact';
import { QueryEngine } from '@traceiq/query';
import type { NodeId, RelationshipType } from '@traceiq/types';

import { CachingGraph } from './caching-graph.js';

/**
 * The package a file belongs to: its first two path segments, or its first when it has only one.
 *
 * The graph records **no package boundary** — the specification deliberately omits both `Repository`
 * and `Directory` nodes, and the scanner's `packageJsonPath` never reaches the graph. So a package
 * here is a stated projection of the file path and nothing more:
 *
 * ```
 * packages/health/src/types.ts  →  packages/health
 * src/auth/user.service.ts      →  src/auth
 * index.ts                      →  index.ts
 * ```
 *
 * One fixed rule, no directory names hardcoded and no configuration, so two callers always agree.
 */
export function packageOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);

  return segments.slice(0, 2).join('/');
}

/** The package a node belongs to, or `null` when the graph records no file for it. */
export function packageOfNode(node: GraphNode): string | null {
  const fileId = node.kind === 'File' ? node.id : node.fileId;

  return fileId === null ? null : packageOf(fileId.slice('file:'.length));
}

export interface PackageIndex {
  /** Package name to the files in it, identifier-ordered. */
  readonly filesByPackage: ReadonlyMap<string, readonly GraphNode[]>;
  /** Package name to every declaration whose file sits in it. */
  readonly declarationsByPackage: ReadonlyMap<string, readonly GraphNode[]>;
  readonly packageOfFile: ReadonlyMap<NodeId, string>;
  /**
   * Import edges that cross a package boundary, as `from → to → edges`.
   *
   * A nested map rather than a composite string key: encoding two names into one string and
   * splitting them apart again is a bug waiting to happen, and a package name is free to contain
   * whatever a path contains.
   */
  readonly crossingEdges: ReadonlyMap<string, ReadonlyMap<string, readonly GraphEdge[]>>;
  /** Alphabetical package names. */
  readonly names: readonly string[];
}

/**
 * Everything shared between explorer operations, built at most once each.
 *
 * The explorer reuses Explain Symbol, Impact Analysis and Repository Health rather than
 * reimplementing them, and reuses **Repository Health's** graph index and graph algorithms rather
 * than writing a second copy. Each shared value is built lazily and cached here, so an operation
 * that needs none of it pays for none of it, and two operations that need the same one share it.
 *
 * Every capability is constructed over one `CachingGraph`, so when Explain Symbol and Impact
 * Analysis both read a node the second read is answered from memory.
 */
export class ExplorerContext {
  readonly graph: CachingGraph;
  readonly queries: QueryEngine;
  readonly explainer: SymbolExplainer;
  readonly impact: ImpactAnalyzer;

  /** Query Engine calls made through this context, for profiling. */
  queryEngineCalls = 0;

  #index: GraphIndex | null = null;
  #derived: Derived | null = null;
  #health: RepositoryHealthReport | null = null;
  #packages: PackageIndex | null = null;
  readonly #adjacencies = new Map<string, Adjacency>();

  constructor(api: RepositoryGraphApi) {
    this.graph = new CachingGraph(api);
    this.queries = new QueryEngine(this.graph);
    this.explainer = new SymbolExplainer(this.queries);
    this.impact = new ImpactAnalyzer(this.queries);
  }

  /** Repository Health's whole-graph index, reused rather than rebuilt. */
  index(): GraphIndex {
    this.#index ??= buildGraphIndex(this.graph);

    return this.#index;
  }

  /** Repository Health's derived values: coupling metrics, call components, module dependencies. */
  derived(): Derived {
    this.#derived ??= deriveFrom(this.index());

    return this.#derived;
  }

  /**
   * The full health report.
   *
   * Costs almost nothing beyond the index it shares, because the analyser reads through the same
   * cache: its own `buildGraphIndex` call is answered from memory rather than from the database.
   */
  health(): RepositoryHealthReport {
    this.#health ??= new RepositoryHealthAnalyzer(this.graph).analyze();

    return this.#health;
  }

  packages(): PackageIndex {
    this.#packages ??= buildPackageIndex(this.index());

    return this.#packages;
  }

  /**
   * Adjacency over one or more relationship types.
   *
   * A single type is delegated to the health index, which already memoises it. A union — inheritance
   * is `EXTENDS` and `IMPLEMENTS` together — is built here and cached, since nothing else needs a
   * multi-type adjacency.
   */
  adjacencyOf(types: readonly RelationshipType[]): Adjacency {
    if (types.length === 1 && types[0] !== undefined) {
      return this.index().adjacencyOf(types[0]);
    }

    const key = [...types].sort().join(',');
    const cached = this.#adjacencies.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const built = adjacencyFor(types.flatMap((type) => this.index().edgesByType.get(type) ?? []));

    this.#adjacencies.set(key, built);

    return built;
  }

  /** The index if an operation has already built it, else `null`. Used only for profiling. */
  builtIndex(): GraphIndex | null {
    return this.#index;
  }

  node(id: NodeId): GraphNode | null {
    return this.graph.getNode(id);
  }

  /** Counts a Query Engine call and returns its result, so the profile is measured not guessed. */
  query<T>(read: (queries: QueryEngine) => T): T {
    this.queryEngineCalls += 1;

    return read(this.queries);
  }
}

function buildPackageIndex(index: GraphIndex): PackageIndex {
  const filesByPackage = new Map<string, GraphNode[]>();
  const declarationsByPackage = new Map<string, GraphNode[]>();
  const packageOfFile = new Map<NodeId, string>();

  for (const file of index.files) {
    const name = packageOf(file.id.slice('file:'.length));

    packageOfFile.set(file.id, name);
    append(filesByPackage, name, file);
  }

  for (const declaration of index.declarations) {
    const name = declaration.fileId === null ? null : packageOfFile.get(declaration.fileId);

    if (name !== undefined && name !== null) {
      append(declarationsByPackage, name, declaration);
    }
  }

  // Import edges crossing a package boundary. Kept per ordered pair so a dependency and a dependent
  // are the same fact read from two directions.
  const crossingEdges = new Map<string, Map<string, GraphEdge[]>>();

  for (const edge of index.edgesByType.get('IMPORTS') ?? []) {
    const from = packageOfFile.get(edge.sourceId);
    const target = index.nodeById.get(edge.targetId);

    if (from === undefined || target === undefined) {
      continue;
    }

    const targetFile = target.kind === 'File' ? target.id : target.fileId;
    const to = targetFile === null ? undefined : packageOfFile.get(targetFile);

    if (to === undefined || to === from) {
      continue;
    }

    const outward = crossingEdges.get(from) ?? new Map<string, GraphEdge[]>();

    crossingEdges.set(from, outward);
    append(outward, to, edge);
  }

  return {
    filesByPackage,
    declarationsByPackage,
    packageOfFile,
    crossingEdges,
    names: [...filesByPackage.keys()].sort(),
  };
}

function adjacencyFor(edges: readonly GraphEdge[]): Adjacency {
  const out = new Map<NodeId, NodeId[]>();
  const incoming = new Map<NodeId, NodeId[]>();
  const seen = new Set<string>();

  for (const edge of edges) {
    const pair = `${edge.sourceId} ${edge.targetId}`;

    if (seen.has(pair)) {
      continue;
    }

    seen.add(pair);
    appendId(out, edge.sourceId, edge.targetId);
    appendId(incoming, edge.targetId, edge.sourceId);
  }

  return { out, in: incoming };
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);

  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function appendId(map: Map<NodeId, NodeId[]>, key: NodeId, value: NodeId): void {
  const existing = map.get(key);

  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}
