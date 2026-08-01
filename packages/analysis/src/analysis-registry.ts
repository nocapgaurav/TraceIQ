import type { AnalysisExecutor } from './analysis-executor.js';
import { RepositoryAnalyzer, type AnalysisRequest } from './repository-analyzer.js';
import type { AnalysisJob, AnalysisStage, JobTelemetry } from './types.js';

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
 * **It queues now, and that changed for two reasons.** The old note here said a second submission was
 * refused because "`scan` replaces the entire database, so two concurrent analyses would race for one
 * file". That was true of the *destination*, not of the work: an analysis is now handed its own database
 * path and the caller decides when to adopt the result, so two of them no longer collide. And refusing
 * was never good behaviour — a user with three repositories to analyse had to sit and resubmit.
 *
 * So submissions are accepted into a queue and drawn by a bounded pool. The bound is deliberate rather
 * than absent: an analysis is the most memory-hungry thing TraceIQ does — 1.5 GB peak on React — and an
 * unbounded pool would turn three submissions into an out-of-memory kill. Waiting is visible
 * (`telemetry.queueWaitMs`) rather than hidden.
 */
export interface StartOutcome {
  readonly accepted: boolean;
  readonly job: AnalysisJob;
}

export interface RegistryOptions {
  /**
   * Who performs the work. Defaults to an in-process `RepositoryAnalyzer`.
   *
   * The API injects a process-backed executor instead, because a graph build is synchronous and
   * CPU-bound and would otherwise run on the thread serving every other request.
   */
  readonly analyzer?: AnalysisExecutor;
  /**
   * How many analyses may run at once.
   *
   * One by default, which is what every existing caller had. The bound exists because an analysis peaks
   * at 1.5 GB on React; concurrency is a memory decision before it is a throughput one.
   */
  readonly concurrency?: number;
  /**
   * How long a single attempt may run before it is cancelled as stuck.
   *
   * Distinct from the cloner's own timeout, which covers only the clone. This covers everything,
   * including a graph build that has stopped making progress — the case no inner timeout can see.
   */
  readonly timeoutMs?: number;
  /**
   * How many times a job is retried after a failure the registry judges transient.
   *
   * Zero by default. A retry is only ever attempted for a failure that could plausibly succeed second
   * time — see `RETRYABLE`. Retrying a repository that is not TypeScript would waste minutes proving
   * the same thing twice.
   */
  readonly retries?: number;
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
  /** When the submission was accepted — the start of the queue wait, not of the work. */
  readonly acceptedAt: number;
  /** When a worker picked it up. `null` while queued. */
  startedAt: number | null;
  finishedAt: number | null;
  controller: AbortController;
  readonly request: AnalysisRequest;
  attempts: number;
  /** Set when this job's own timeout fired, so the failure can say so rather than blaming the caller. */
  timedOut: boolean;
  /** Set by `cancel`, so an abort raised by the user is not reported as a fault. */
  cancelled: boolean;
  worker: string | null;
  cpuMs: number | null;
  peakRssBytes: number | null;
}

/**
 * Failures worth a second attempt.
 *
 * A closed list, because the default has to be "do not retry". Re-running an analysis costs minutes of
 * CPU, and most failures are facts about the repository — it does not exist, it is private, it is not
 * analysable — which a second attempt would confirm at length. These three are about the run rather
 * than the repository: a network that dropped, a clone that timed out, a worker that died.
 */
const RETRYABLE: ReadonlySet<string> = new Set(['clone-failed', 'analysis-timeout', 'worker-exited']);

const NO_TELEMETRY: JobTelemetry = {
  queueWaitMs: 0,
  runMs: 0,
  worker: null,
  cpuMs: null,
  peakRssBytes: null,
  repositoryBytes: null,
  attempts: 0,
};

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
  readonly #analyzer: AnalysisExecutor;
  readonly #history: number;
  readonly #now: () => number;
  readonly #onSettled: (job: AnalysisJob) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #concurrency: number;
  readonly #timeoutMs: number;
  readonly #retries: number;

  /** Ids accepted and not yet started, oldest first. */
  readonly #queue: string[] = [];

  /** Ids currently held by a worker. */
  readonly #running = new Set<string>();

  constructor(options: RegistryOptions = {}) {
    this.#analyzer = options.analyzer ?? new RepositoryAnalyzer();
    this.#history = options.history ?? 20;
    this.#now = options.now ?? (() => Date.now());
    this.#onSettled = options.onSettled ?? (() => {});
    this.#concurrency = Math.max(1, options.concurrency ?? 1);
    this.#timeoutMs = options.timeoutMs ?? 45 * 60 * 1000;
    this.#retries = Math.max(0, options.retries ?? 0);
  }

  /** The analyses currently running, newest first. */
  active(): readonly AnalysisJob[] {
    return [...this.#running].map((id) => this.get(id)).filter((job): job is AnalysisJob => job !== undefined);
  }

  /**
   * The analysis currently running, or `null`.
   *
   * Kept for the callers that predate the pool and only ever expected one. With concurrency above one
   * it answers "the oldest still running", which is the closest true statement to what it used to mean.
   */
  running(): AnalysisJob | null {
    return this.active().at(0) ?? null;
  }

  /** How many submissions are waiting for a worker. */
  queued(): number {
    return this.#queue.length;
  }

  /**
   * Accepts an analysis.
   *
   * **Always accepted now.** It used to refuse while another ran, which meant a user with three
   * repositories had to watch and resubmit. A submission that cannot start immediately is `queued`
   * with the wait reported rather than rejected, and `accepted` stays in the contract because a caller
   * still wants to know whether work began.
   */
  start(request: AnalysisRequest): StartOutcome {
    const id = nextId();
    const acceptedAt = this.#now();

    this.#entries.set(id, {
      acceptedAt,
      startedAt: null,
      finishedAt: null,
      controller: new AbortController(),
      request,
      attempts: 0,
      timedOut: false,
      cancelled: false,
      worker: null,
      cpuMs: null,
      peakRssBytes: null,
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
        telemetry: NO_TELEMETRY,
      },
    });

    this.#queue.push(id);
    this.#prune();
    this.#drain();

    return { accepted: this.#running.has(id), job: this.get(id) as AnalysisJob };
  }

  /** A job by id, with its elapsed and queue times computed at read time. */
  get(id: string): AnalysisJob | undefined {
    const entry = this.#entries.get(id);

    if (entry === undefined) {
      return undefined;
    }

    const settledAt = entry.finishedAt ?? this.#now();

    return {
      ...entry.job,
      elapsedMs: settledAt - entry.acceptedAt,
      telemetry: {
        queueWaitMs: (entry.startedAt ?? settledAt) - entry.acceptedAt,
        runMs: entry.startedAt === null ? 0 : settledAt - entry.startedAt,
        worker: entry.worker,
        cpuMs: entry.cpuMs,
        peakRssBytes: entry.peakRssBytes,
        repositoryBytes: bytesFromClone(entry.job.stages),
        attempts: entry.attempts,
      },
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
   * Stops an analysis, queued or running.
   *
   * A queued job is settled immediately — there is nothing to interrupt, and leaving it to be picked up
   * and then killed would waste a worker slot on work already abandoned. A running job is aborted
   * through its signal, which reaches the clone and, with a process-backed executor, the worker itself.
   */
  cancel(id: string): boolean {
    const entry = this.#entries.get(id);

    if (entry === undefined || entry.finishedAt !== null) {
      return false;
    }

    entry.cancelled = true;

    const waiting = this.#queue.indexOf(id);

    if (waiting !== -1) {
      this.#queue.splice(waiting, 1);
      this.#settle(entry, id, { ...entry.job, status: 'cancelled' });

      return true;
    }

    entry.controller.abort();

    return true;
  }

  /**
   * Runs a settled job again, as a new job.
   *
   * A new id rather than a reset, because a job and its outcome belong together: overwriting the first
   * attempt's stages and error would destroy the evidence of why a retry was wanted. The original stays
   * exactly as it finished.
   */
  retry(id: string, overrides: Partial<AnalysisRequest> = {}): StartOutcome | null {
    const entry = this.#entries.get(id);

    if (entry === undefined || entry.finishedAt === null) {
      return null;
    }

    // `overrides` exists for the destination. The first attempt's database was discarded when it
    // failed, so writing the retry to the same path would be writing to a name whose meaning has
    // already been used up — and the caller, not this package, is the one that knows where graphs go.
    return this.start({ ...entry.request, ...overrides });
  }

  /** Starts whatever the pool has room for. Safe to call at any time; it does nothing when full. */
  #drain(): void {
    while (this.#running.size < this.#concurrency && this.#queue.length > 0) {
      const id = this.#queue.shift() as string;
      const entry = this.#entries.get(id);

      if (entry === undefined || entry.finishedAt !== null) {
        continue;
      }

      this.#running.add(id);
      void this.#run(id, entry);
    }
  }

  async #run(id: string, entry: Entry): Promise<void> {
    entry.startedAt = this.#now();
    entry.attempts += 1;
    entry.job = { ...entry.job, status: 'running' };

    // Its own deadline, covering everything rather than just the clone. A graph build that stops making
    // progress is invisible to every inner timeout, and a job with no ceiling holds a worker for ever.
    const deadline = setTimeout(() => {
      entry.timedOut = true;
      entry.controller.abort();
    }, this.#timeoutMs);

    deadline.unref?.();

    try {
      const outcome = await this.#analyzer.analyze(
        { ...entry.request, signal: entry.controller.signal },
        (stages: readonly AnalysisStage[]) => {
          // The listener fires as the workflow moves, so a poll between two stages sees the earlier one.
          entry.job = { ...entry.job, stages };
        },
      );

      if (outcome.execution !== undefined) {
        entry.worker = outcome.execution.worker;
        entry.cpuMs = outcome.execution.cpuMs;
        entry.peakRssBytes = outcome.execution.peakRssBytes;
      }

      if (entry.cancelled) {
        this.#settle(entry, id, { ...entry.job, status: 'cancelled' });

        return;
      }

      const failure = entry.timedOut
        ? {
            code: 'analysis-timeout' as const,
            detail: `The analysis was still running after ${Math.round(this.#timeoutMs / 60_000)} minutes and was stopped.`,
            hint: 'Very large repositories can exceed this ceiling. Raise TRACEIQ_ANALYSIS_TIMEOUT_MS or analyse a smaller repository.',
          }
        : outcome.failure;

      if (failure !== null && this.#shouldRetry(entry, failure.code)) {
        this.#requeue(id, entry);

        return;
      }

      this.#settle(entry, id, {
        ...entry.job,
        repository: outcome.repository,
        status: failure === null ? 'succeeded' : 'failed',
        result: outcome.result,
        error: failure,
        workspaceWarning: outcome.workspaceWarning,
      });
    } catch (cause) {
      if (entry.cancelled) {
        this.#settle(entry, id, { ...entry.job, status: 'cancelled' });

        return;
      }

      const detail = cause instanceof Error ? cause.message : String(cause);
      const code = detail.includes('worker') ? 'worker-exited' : 'pipeline-failed';

      if (this.#shouldRetry(entry, code)) {
        this.#requeue(id, entry);

        return;
      }

      // `analyze` is written to resolve on every expected failure, so reaching here is a defect or a
      // worker that died. It is still reported as a failed job rather than left running for ever.
      this.#settle(entry, id, {
        ...entry.job,
        status: 'failed',
        error: {
          code: 'pipeline-failed',
          detail: `The analysis ended unexpectedly: ${detail}`,
          hint: 'This is a fault in TraceIQ rather than in the repository. The API log has the full error.',
        },
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  #shouldRetry(entry: Entry, code: string): boolean {
    return !entry.cancelled && entry.attempts <= this.#retries && RETRYABLE.has(code);
  }

  /** Puts a job back at the front of the queue for another attempt, freeing its worker first. */
  #requeue(id: string, entry: Entry): void {
    entry.controller = new AbortController();
    entry.timedOut = false;
    entry.startedAt = null;
    entry.job = { ...entry.job, status: 'queued', stages: RepositoryAnalyzer.initialStages(), error: null };
    this.#running.delete(id);
    this.#queue.unshift(id);
    this.#drain();
  }

  /** Records a final state, frees the worker and starts the next job. */
  #settle(entry: Entry, id: string, job: AnalysisJob): void {
    entry.job = job;
    entry.finishedAt = this.#now();
    this.#running.delete(id);

    // The queue is drained before the listener runs, so a slot freed by this job is available to
    // whatever was waiting rather than to whatever the listener decides to submit.
    this.#drain();

    try {
      this.#onSettled(this.get(id) as AnalysisJob);
    } catch {
      // A listener's fault is not the analysis's.
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

/**
 * The cloned size, read back out of the clone stage's own detail.
 *
 * Recovered from the stage rather than threaded through the outcome because the stage list is what the
 * registry already receives, and adding a parallel channel for one number would mean two places that
 * could disagree about it. `null` whenever the clone has not finished or did not report a size.
 */
function bytesFromClone(stages: readonly AnalysisStage[]): number | null {
  const detail = stages.find((stage) => stage.name === 'clone')?.detail ?? '';
  const match = /, ([\d.]+) (B|KiB|MiB|GiB)$/.exec(detail);

  if (match === null) {
    return null;
  }

  const scale = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2] as 'B'];

  return Math.round(Number(match[1]) * scale);
}
