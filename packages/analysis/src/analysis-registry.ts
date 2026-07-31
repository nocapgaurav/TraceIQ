import { RepositoryAnalyzer, type AnalysisRequest } from './repository-analyzer.js';
import type { AnalysisJob, AnalysisStage } from './types.js';

/**
 * Analyses in flight, and the ones that have finished.
 *
 * **Why a job at all.** A clone plus a scan of a real repository takes minutes. Holding an HTTP request
 * open for that loses to any proxy timeout, gives the browser nothing to show while it waits, and turns
 * a refresh into a second clone. Accepting the work and reporting on it separately is the smallest
 * arrangement that avoids all three.
 *
 * **Why in memory.** A job is worth exactly as long as the graph it produces, and the graph is a single
 * file that a scan replaces wholesale. Persisting job rows would add a store, a schema and a migration
 * to hold state that is meaningless after a restart — the graph either exists or it does not, and
 * `/version` already answers that. Everything a queue, cancellation or a retry would need is behind this
 * interface, so adding them later does not change a caller.
 *
 * **One at a time.** `scan` replaces the entire database, so two concurrent analyses would race for one
 * file and the loser's graph would vanish mid-read. A second submission is refused while one is running
 * rather than queued silently, because the caller should know its work has not started.
 */
export interface StartOutcome {
  readonly accepted: boolean;
  readonly job: AnalysisJob;
}

export interface RegistryOptions {
  readonly analyzer?: RepositoryAnalyzer;
  /** Finished jobs kept for polling after completion. Old ones are dropped oldest-first. */
  readonly history?: number;
  /** Injected so a test does not depend on the clock. */
  readonly now?: () => number;
  /**
   * Called once a job has settled, whatever the outcome.
   *
   * How the API reopens its graph after a successful analysis without this package knowing anything
   * about `GraphHolder`. A callback rather than an import keeps the dependency pointing one way.
   */
  readonly onSettled?: (job: AnalysisJob) => void;
}

interface Entry {
  job: AnalysisJob;
  readonly startedAt: number;
  finishedAt: number | null;
  readonly controller: AbortController;
}

let sequence = 0;

/** A counter, not a UUID: ids need only be unique within a process, and a test can predict them. */
function nextId(): string {
  sequence += 1;

  return `analysis-${sequence}`;
}

/** Exposed so a test starts from a known counter. */
export function resetAnalysisIds(): void {
  sequence = 0;
}

export class AnalysisRegistry {
  readonly #analyzer: RepositoryAnalyzer;
  readonly #history: number;
  readonly #now: () => number;
  readonly #onSettled: (job: AnalysisJob) => void;
  readonly #entries = new Map<string, Entry>();

  #running: string | null = null;

  constructor(options: RegistryOptions = {}) {
    this.#analyzer = options.analyzer ?? new RepositoryAnalyzer();
    this.#history = options.history ?? 20;
    this.#now = options.now ?? (() => Date.now());
    this.#onSettled = options.onSettled ?? (() => {});
  }

  /** The analysis currently running, or `null`. */
  running(): AnalysisJob | null {
    return this.#running === null ? null : (this.get(this.#running) ?? null);
  }

  /**
   * Accepts an analysis and returns immediately.
   *
   * `accepted: false` means one is already running and this one was not started — the caller is handed
   * the running job so it can follow that instead.
   */
  start(request: AnalysisRequest): StartOutcome {
    const active = this.running();

    if (active !== null) {
      return { accepted: false, job: active };
    }

    const id = nextId();
    const startedAt = this.#now();
    const controller = new AbortController();

    const entry: Entry = {
      startedAt,
      finishedAt: null,
      controller,
      job: {
        id,
        url: request.url,
        repository: null,
        status: 'queued',
        stages: RepositoryAnalyzer.initialStages(),
        result: null,
        error: null,
        elapsedMs: 0,
        workspaceWarning: null,
      },
    };

    this.#entries.set(id, entry);
    this.#running = id;
    this.#prune();

    // Deliberately not awaited: `start` returns to the HTTP handler while this continues. Every failure
    // path inside `analyze` resolves rather than rejects, and the catch below covers a defect in that.
    void this.#run(id, entry, request, controller);

    return { accepted: true, job: this.get(id) as AnalysisJob };
  }

  /** A job by id, with its elapsed time computed at read time. */
  get(id: string): AnalysisJob | undefined {
    const entry = this.#entries.get(id);

    if (entry === undefined) {
      return undefined;
    }

    return {
      ...entry.job,
      elapsedMs: (entry.finishedAt ?? this.#now()) - entry.startedAt,
    };
  }

  /** Newest first. */
  list(): readonly AnalysisJob[] {
    return [...this.#entries.keys()]
      .reverse()
      .map((id) => this.get(id))
      .filter((job): job is AnalysisJob => job !== undefined);
  }

  /**
   * Stops the running analysis.
   *
   * The signal reaches the clone, which is the long part and the only step that takes one. A scan
   * already under way finishes — `RepositoryPipeline` accepts no signal, and interrupting it is not
   * something this package may add without changing the pipeline.
   */
  cancel(id: string): boolean {
    const entry = this.#entries.get(id);

    if (entry === undefined || entry.finishedAt !== null) {
      return false;
    }

    entry.controller.abort();

    return true;
  }

  async #run(id: string, entry: Entry, request: AnalysisRequest, controller: AbortController): Promise<void> {
    entry.job = { ...entry.job, status: 'running' };

    try {
      const outcome = await this.#analyzer.analyze(
        { ...request, signal: controller.signal },
        (stages: readonly AnalysisStage[]) => {
          // The listener fires as the workflow moves, so a poll between two stages sees the earlier one.
          entry.job = { ...entry.job, stages };
        },
      );

      entry.job = {
        ...entry.job,
        repository: outcome.repository,
        status: outcome.failure === null ? 'succeeded' : 'failed',
        result: outcome.result,
        error: outcome.failure,
        workspaceWarning: outcome.workspaceWarning,
      };
    } catch (cause) {
      // `analyze` is written to resolve on every expected failure, so reaching here is a defect. It is
      // still reported as a failed job rather than left running for ever.
      entry.job = {
        ...entry.job,
        status: 'failed',
        error: {
          code: 'pipeline-failed',
          detail: `The analysis ended unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`,
          hint: 'This is a fault in TraceIQ rather than in the repository. The API log has the full error.',
        },
      };
    } finally {
      entry.finishedAt = this.#now();

      if (this.#running === id) {
        this.#running = null;
      }

      // After the slot is freed, so a listener that starts another analysis cannot be refused by the
      // job it is reacting to. A throwing listener must not resurrect a settled job.
      try {
        this.#onSettled(this.get(id) as AnalysisJob);
      } catch {
        // A listener's fault is not the analysis's.
      }
    }
  }

  /** Drops the oldest finished jobs once history is exceeded. A running job is never dropped. */
  #prune(): void {
    while (this.#entries.size > this.#history) {
      const oldest = [...this.#entries.entries()].find(([, entry]) => entry.finishedAt !== null);

      if (oldest === undefined) {
        return;
      }

      this.#entries.delete(oldest[0]);
    }
  }
}
