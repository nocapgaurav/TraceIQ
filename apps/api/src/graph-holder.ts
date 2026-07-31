import { RepositoryContextBuilder } from '@traceiq/context';
import { SymbolExplainer } from '@traceiq/explain';
import { RepositoryHealthAnalyzer } from '@traceiq/health';
import { CachingGraph, RepositoryExplorer } from '@traceiq/explorer';
import { ImpactAnalyzer } from '@traceiq/impact';
import { RepositoryNavigator } from '@traceiq/navigation';
import { RepositoryPipeline, type RepositorySession } from '@traceiq/pipeline';
import { QueryEngine } from '@traceiq/query';

import { repositoryNotScanned } from './errors.js';

/**
 * The capabilities one request may use, over one shared graph read.
 *
 * Every capability is built over a single `CachingGraph` and built **lazily**, so a request that needs
 * only the explorer never constructs an impact analyser, and a request that drives three of them reads
 * the database once.
 *
 * One of these is held per open graph, not per request: the cache is what makes a warm request fast,
 * and the graph is one immutable revision, so sharing it across requests is sound.
 */
export class Capabilities {
  readonly #graph: CachingGraph;

  #explorer: RepositoryExplorer | null = null;
  #navigator: RepositoryNavigator | null = null;
  #impact: ImpactAnalyzer | null = null;
  #health: RepositoryHealthAnalyzer | null = null;
  #context: RepositoryContextBuilder | null = null;

  constructor(session: RepositorySession) {
    this.#graph = new CachingGraph(session.api);
  }

  explorer(): RepositoryExplorer {
    this.#explorer ??= new RepositoryExplorer(this.#graph);

    return this.#explorer;
  }

  navigator(): RepositoryNavigator {
    this.#navigator ??= new RepositoryNavigator(this.#graph);

    return this.#navigator;
  }

  impact(): ImpactAnalyzer {
    this.#impact ??= new ImpactAnalyzer(new QueryEngine(this.#graph));

    return this.#impact;
  }

  health(): RepositoryHealthAnalyzer {
    this.#health ??= new RepositoryHealthAnalyzer(this.#graph);

    return this.#health;
  }

  /**
   * The context builder, over the same shared graph.
   *
   * Built here rather than in a route so a chat request reads the database through the same cache every
   * other endpoint uses. It is the **only** thing the chat endpoints receive from this class: they never
   * touch the explorer, the explainer, the impact analyser, the health analyser or the query engine
   * directly, and the AI layer cannot — a `ContextSource` has one method.
   */
  context(): RepositoryContextBuilder {
    if (this.#context === null) {
      const queries = new QueryEngine(this.#graph);

      this.#context = new RepositoryContextBuilder({
        explorer: this.explorer(),
        explain: new SymbolExplainer(queries),
        impact: new ImpactAnalyzer(queries),
        health: this.health(),
        queries,
      });
    }

    return this.#context;
  }

  /** Reads that reached the database since this graph was opened. */
  graphApiCalls(): number {
    return this.#graph.graphCalls;
  }
}

/**
 * The one piece of mutable state the API owns: which graph is currently open.
 *
 * Held on an instance created by `createApp`, never at module scope, so two apps in one process — as
 * two tests are — cannot see each other's graph.
 *
 * **Why no locking is needed.** Every read capability is synchronous, so a request never yields
 * between taking the graph and finishing with it: no `await` sits between `capabilities()` and the
 * response. Only a scan is asynchronous, and it swaps the graph in a single synchronous step once the
 * new one is ready. An in-flight read therefore cannot have its session closed underneath it, and no
 * mutex, queue or reference count is required to guarantee that.
 */
export class GraphHolder {
  readonly #pipeline = new RepositoryPipeline();
  readonly #databasePath: string;

  #open: { readonly session: RepositorySession; readonly capabilities: Capabilities } | null = null;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
  }

  get databasePath(): string {
    return this.#databasePath;
  }

  get pipeline(): RepositoryPipeline {
    return this.#pipeline;
  }

  /** Whether a graph is currently open, or one exists to open. */
  isScanned(): boolean {
    if (this.#open !== null) {
      return true;
    }

    try {
      this.#openNow();

      return true;
    } catch {
      return false;
    }
  }

  /**
   * The capabilities over the current graph, opening it on first use.
   *
   * Throws `repository-not-scanned` when there is no graph, which is a 409: the request was fine, the
   * server has nothing to answer from yet.
   */
  capabilities(): Capabilities {
    if (this.#open === null) {
      this.#openNow();
    }

    if (this.#open === null) {
      throw repositoryNotScanned(this.#databasePath);
    }

    return this.#open.capabilities;
  }

  /**
   * Replaces the open graph with a freshly written one.
   *
   * Synchronous, and called only after a scan has finished writing: the old session is closed and the
   * new one opened without yielding, so no request can observe a half-swapped state.
   */
  reopen(): void {
    this.#open?.session.close();
    this.#open = null;
    this.#openNow();
  }

  close(): void {
    this.#open?.session.close();
    this.#open = null;
  }

  #openNow(): void {
    let session: RepositorySession;

    try {
      session = this.#pipeline.open(this.#databasePath);
    } catch {
      throw repositoryNotScanned(this.#databasePath);
    }

    this.#open = { session, capabilities: new Capabilities(session) };
  }
}
