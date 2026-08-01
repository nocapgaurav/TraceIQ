import { fork, type ChildProcess } from 'node:child_process';

import type { AnalysisExecutor, AnalysisOutcome, AnalysisRequest, StageListener } from '@traceiq/analysis';

/**
 * Runs an analysis in a child process, and reports what it cost.
 *
 * **This is the milestone.** The graph build is synchronous and CPU-bound; running it on the thread
 * that serves HTTP meant the API stopped answering while it ran. Measured on `facebook/react` with
 * `GET /ping` sampled every 250 ms throughout an analysis: **7 samples over 5 seconds and one that
 * reached the 30-second client timeout**, against a 4.9 ms median when idle. No amount of care inside
 * the pipeline makes an event loop available while it is running; the work has to leave the process.
 *
 * What stays here is supervision — spawn, translate messages into the stage callbacks the registry
 * already expects, kill on abort, and turn a dead worker into a job failure rather than a hung promise.
 * Policy above it is unchanged: the registry still owns queueing, timeouts and retries, and
 * `AnalysisExecutor` is satisfied identically by the in-process analyzer the CLI and the tests use.
 */
export interface WorkerExecutorOptions {
  /** Absolute path to the worker entry point. */
  readonly workerPath: string;
  readonly cloneTimeoutMs?: number;
  readonly maxCloneBytes?: number;
  /**
   * Heap ceiling for the worker, in megabytes.
   *
   * Its own, and larger than the server's: an analysis peaks at 1.5 GB where the API idles near 200 MB.
   * Sizing them together would mean either a server that reserves memory it never uses or a worker that
   * cannot analyse React.
   */
  readonly maxOldSpaceMb?: number;
  /** Where a worker's stderr goes. Injected so a test can read it instead of the console. */
  readonly log?: (line: string) => void;
}

interface StageMessage {
  readonly type: 'stage';
  readonly stages: Parameters<StageListener>[0];
}

interface DoneMessage {
  readonly type: 'done';
  readonly outcome?: AnalysisOutcome;
  readonly failed?: string;
  readonly cpuMs?: number;
  readonly peakRssBytes?: number;
}

export class WorkerAnalysisExecutor implements AnalysisExecutor {
  readonly #options: WorkerExecutorOptions;

  constructor(options: WorkerExecutorOptions) {
    this.#options = options;
  }

  async analyze(request: AnalysisRequest, onStage: StageListener = () => {}): Promise<AnalysisOutcome> {
    const log = this.#options.log ?? ((line: string) => process.stderr.write(line));
    const child = fork(this.#options.workerPath, [], {
      // `ipc` for the protocol, `pipe` for stderr so a worker's crash output reaches the API log
      // instead of vanishing. Anything the worker prints is prefixed with its pid at the other end.
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      execArgv: [`--max-old-space-size=${this.#options.maxOldSpaceMb ?? 4096}`],
    });

    const worker = `worker-${child.pid ?? 0}`;

    child.stderr?.on('data', (chunk: Buffer) => {
      log(`[${worker}] ${chunk.toString()}`);
    });

    return await new Promise<AnalysisOutcome>((resolve, reject) => {
      let settled = false;

      const finish = (run: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        run();
      };

      /**
       * Cancellation, as a kill.
       *
       * `SIGTERM` first so the worker can unwind, then `SIGKILL` shortly after. The escalation is not
       * theoretical: the whole reason this runs in a process is that the compiler holds the thread for
       * long synchronous stretches, and a worker in one of those cannot handle a signal at all.
       */
      const onAbort = (): void => {
        child.kill('SIGTERM');

        const hard = setTimeout(() => child.kill('SIGKILL'), 2000);

        hard.unref?.();
      };

      request.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('message', (message: StageMessage | DoneMessage) => {
        if (message.type === 'stage') {
          onStage(message.stages);

          return;
        }

        if (message.type !== 'done') {
          return;
        }

        if (message.outcome === undefined) {
          finish(() => reject(new Error(message.failed ?? 'the analysis worker reported no outcome')));

          return;
        }

        const outcome: AnalysisOutcome = {
          ...(message.outcome as AnalysisOutcome),
          execution: { worker, cpuMs: message.cpuMs ?? null, peakRssBytes: message.peakRssBytes ?? null },
        };

        finish(() => resolve(outcome));
      });

      child.on('error', (cause) => {
        finish(() => reject(new Error(`the analysis worker could not be started: ${cause.message}`)));
      });

      /**
       * A worker that exits without reporting.
       *
       * The characteristic case is an out-of-memory kill, which arrives as a signal and no message at
       * all. Naming it beats a generic pipeline failure, because "the worker ran out of memory" is
       * something a deployment can act on and "the analysis ended unexpectedly" is not.
       */
      child.on('exit', (code, signal) => {
        finish(() =>
          reject(
            new Error(
              signal === 'SIGKILL' || signal === 'SIGABRT'
                ? `the analysis worker was killed (${signal}), which usually means it ran out of memory`
                : `the analysis worker exited with code ${String(code)} before reporting a result`,
            ),
          ),
        );
      });

      child.send({
        type: 'start',
        request: {
          url: request.url,
          databasePath: request.databasePath,
          createdAt: request.createdAt,
          ...(this.#options.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: this.#options.cloneTimeoutMs }),
          ...(this.#options.maxCloneBytes === undefined ? {} : { maxCloneBytes: this.#options.maxCloneBytes }),
        },
      });
    }).finally(() => {
      // A worker that answered has nothing left to do; one that did not is already gone. Either way the
      // slot must not be held by a process nobody is listening to.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    });
  }
}

/** Exposed for the composition root, which is the only place that knows the file layout. */
export type { ChildProcess };
