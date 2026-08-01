import { RepositoryContextBuilder } from '@traceiq/context';
import { SymbolExplainer } from '@traceiq/explain';
import { RepositoryHealthAnalyzer } from '@traceiq/health';
import { CachingGraph, RepositoryExplorer } from '@traceiq/explorer';
import { ImpactAnalyzer } from '@traceiq/impact';
import { RepositoryNavigator } from '@traceiq/navigation';
import { RepositoryPipeline, type RepositorySession } from '@traceiq/pipeline';
import { QueryEngine } from '@traceiq/query';

import { renameSync, rmSync } from 'node:fs';

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

  /**
   * Computes the whole-repository results now, so the first request does not.
   *
   * **This moves work rather than removing it, and that is the whole point.** Assembling a repository
   * context on `facebook/react` costs 3,990 ms the first time and nothing afterwards, now that the
   * explorer and the health analyser memoise their revision-wide results. Somebody has to pay the
   * 3,990 ms; the only question is whether it is a user with a question or a process that has just
   * finished a two-minute scan and has nothing else to do.
   *
   * **Returned as steps rather than run in one call, and that was measured.** Warming all five in one
   * go is roughly four seconds of synchronous CPU on React, and adoption happens exactly when an
   * analysis has just finished — so the burst landed on an event loop that had a user waiting on it. A
   * probe sampling `GET /ping` every 250 ms caught the adoption as a multi-second stall.
   *
   * Splitting it does not make any single step shorter — `overview()` alone is 2.3 s and cannot be
   * subdivided from here — but it lets the loop serve requests between them, which turns one long
   * stall into several shorter ones. That is an honest improvement rather than a fix, and the residual
   * is the subject of its own limitation.
   */
  warmSteps(): readonly (() => void)[] {
    return [
      () => this.explorer().overview(),
      () => this.explorer().architecture(),
      () => this.explorer().hotspots(),
      () => this.explorer().cycles(),
      () => this.health().analyze(),
    ];
  }

  /** Every step, back to back. For a caller with nothing else to serve — a test, or the CLI. */
  warm(): void {
    for (const step of this.warmSteps()) {
      step();
    }
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

  /** Counts staged databases, so two issued in the same millisecond cannot collide. */
  #staged = 0;

  /**
   * Which staged database belongs to which job.
   *
   * Here rather than beside the registry because this class is what owns graph files, and because
   * everything in the API that is not a constant lives on an instance: two apps in one process — as two
   * tests are — must not see each other's graphs.
   */
  readonly #staging = new Map<string, string>();

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

  /**
   * A database path for an analysis to write, which is not the live one.
   *
   * **Analyses no longer write the graph a user is reading.** They used to, and the note on
   * `AnalysisRegistry` explained the consequence: "two concurrent analyses would race for one file and
   * the loser's graph would vanish mid-read", so submissions had to be refused. Writing somewhere else
   * removes the race rather than serialising around it, and it fixes a second fault nobody had named —
   * an analysis that failed halfway had already overwritten a graph that was working.
   *
   * The suffix is a counter rather than a timestamp so two paths issued in the same millisecond differ,
   * and it sits beside the live database so the adoption below is a rename within one filesystem.
   */
  stage(): string {
    this.#staged += 1;

    return `${this.#databasePath}.staging-${this.#staged}`;
  }

  /**
   * Records which job owns a staged path, once the job has an id.
   *
   * Two calls rather than one because the path is needed to *create* the job and the id only exists
   * afterwards. The alternative — predicting the next id — would couple this class to the registry's
   * counter, and would be wrong the first time two submissions raced.
   */
  bind(jobId: string, stagedPath: string): void {
    this.#staging.set(jobId, stagedPath);
  }

  /**
   * Adopts or discards whatever a job staged, once it has settled.
   *
   * One method rather than two exposed ones, because the decision is always the same shape — a job
   * ended, and its output either becomes the graph or becomes rubbish — and splitting it invites a
   * caller to do one and forget the other. A job that staged nothing is a no-op, which is what a
   * retry's second attempt against the same path already is.
   */
  settle(jobId: string, succeeded: boolean): void {
    const staged = this.#staging.get(jobId);

    this.#staging.delete(jobId);

    if (staged === undefined) {
      return;
    }

    if (succeeded) {
      this.adopt(staged);
    } else {
      this.discard(staged);
    }
  }

  /**
   * Makes a staged database the live one.
   *
   * **A rename, which on one filesystem is atomic.** The alternative — close, copy, reopen — has a
   * window in which the live path is a partial file, and a read landing in that window sees a corrupt
   * graph rather than an old one. The session is closed first because SQLite holds the file open, and
   * reopening afterwards is what makes the new graph visible without anything being asked to reload.
   *
   * Returns `false` when the rename fails, leaving the previous graph exactly as it was. A deployment
   * that cannot adopt a result still has the one it had.
   */
  adopt(stagedPath: string): boolean {
    this.#open?.session.close();
    this.#open = null;

    try {
      renameSync(stagedPath, this.#databasePath);
    } catch {
      // The old graph is untouched, so reopening restores exactly the state before the attempt.
      this.#reopenQuietly();

      return false;
    }

    // Sidecars from the write-ahead log. A stale `-wal` beside a replaced database is the one way a
    // rename can still produce an inconsistent read.
    for (const suffix of ['-wal', '-shm']) {
      try {
        renameSync(`${stagedPath}${suffix}`, `${this.#databasePath}${suffix}`);
      } catch {
        // Absent unless the writer left one, which is the ordinary case.
      }
    }

    this.#reopenQuietly();

    return true;
  }

  /** Removes a staged database that will never be adopted. Failure is not worth reporting. */
  discard(stagedPath: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${stagedPath}${suffix}`, { force: true });
      } catch {
        // A leaked temporary file is not worth failing a request over.
      }
    }
  }

  /** Reopens if a graph exists, without turning "there is no graph yet" into an error. */
  #reopenQuietly(): void {
    try {
      this.#openNow();
    } catch {
      this.#open = null;
    }
  }

  /**
   * Precomputes the whole-repository results off the request path.
   *
   * Scheduled rather than run inline: `#openNow` is reached from inside a request as often as not, and
   * a four-second block there would be exactly the latency this is meant to remove. `setImmediate`
   * lets the response that triggered the open be written first, and `unref` keeps a pending warm-up
   * from holding the process open at shutdown.
   *
   * Failure is swallowed on purpose. Warming is an optimisation; a graph that cannot be summarised
   * will fail again, legibly, on the request that actually needs it — and reporting it here would
   * surface an error against whatever unrelated request happened to open the graph.
   */
  #scheduleWarm(capabilities: Capabilities): void {
    const steps = capabilities.warmSteps();
    let index = 0;

    // One step per turn of the loop, so a request arriving mid-warm waits for one capability rather
    // than for all five. See `Capabilities.warmSteps` for why this is a mitigation and not a cure.
    const next = (): void => {
      const step = steps[index];

      index += 1;

      if (step === undefined) {
        return;
      }

      try {
        step();
      } catch {
        // Warming is an optimisation; a graph that cannot be summarised will fail again, legibly, on
        // the request that actually needs it.
        return;
      }

      const timer = setImmediate(next);

      timer.unref?.();
    };

    const first = setImmediate(next);

    first.unref?.();
  }

  #openNow(): void {
    let session: RepositorySession;

    try {
      session = this.#pipeline.open(this.#databasePath);
    } catch {
      throw repositoryNotScanned(this.#databasePath);
    }

    const capabilities = new Capabilities(session);

    this.#open = { session, capabilities };
    this.#scheduleWarm(capabilities);
  }
}
