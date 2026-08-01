#!/usr/bin/env node
import { RepositoryAnalyzer } from '@traceiq/analysis';

/**
 * One analysis, in its own process.
 *
 * **Why a process and not a worker thread.** Three reasons, and the first is decisive. A graph build
 * peaks at 1.5 GB on `facebook/react`; a worker thread shares the parent's heap, so an analysis that
 * exceeds the limit takes the API down with it, while a child process that runs out of memory is a
 * child process that died. Second, `--max-old-space-size` is per process, so a worker can be given a
 * bigger heap than the server needs. Third, cancellation of synchronous CPU work is only possible by
 * killing something: a thread running a tight loop in the TypeScript compiler cannot be interrupted,
 * and `SIGKILL` on a process always works.
 *
 * **The protocol is deliberately tiny.** One `start` message in, `stage` messages out as the workflow
 * moves, one `done` message with the outcome, then exit. No streaming of graph data: the worker writes
 * the database itself and the parent is told the path, so nothing large ever crosses the IPC channel —
 * a 339 MB graph serialised through `process.send` would cost more than the analysis.
 *
 * Nothing here decides policy. Timeouts, retries, queueing and which database path to use are the
 * registry's business; this runs one analysis and reports what happened.
 */

/** Sends a message, tolerating a parent that has already gone. */
function send(message) {
  try {
    process.send?.(message);
  } catch {
    // The parent disconnected. Nothing this process can do about it, and nothing worth crashing over.
  }
}

process.on('message', (message) => {
  if (message?.type !== 'start') {
    return;
  }

  void run(message.request);
});

async function run(request) {
  const analyzer = new RepositoryAnalyzer({
    ...(request.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: request.cloneTimeoutMs }),
    ...(request.maxCloneBytes === undefined ? {} : { maxCloneBytes: request.maxCloneBytes }),
  });

  /**
   * Peak resident memory, sampled.
   *
   * Node reports current RSS, never a high-water mark, so the peak has to be observed. A second is
   * frequent enough to catch the compiler's plateau and rare enough to cost nothing measurable.
   */
  let peakRssBytes = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }, 1000);

  sampler.unref?.();

  try {
    const outcome = await analyzer.analyze(request, (stages) => {
      send({ type: 'stage', stages });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    });

    send({
      type: 'done',
      outcome,
      // `cpuUsage` is this process's own, so it is the analysis's cost and not the server's.
      cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
      peakRssBytes: Math.max(peakRssBytes, process.memoryUsage.rss()),
    });
  } catch (cause) {
    // `analyze` resolves on every expected failure, so this is a defect. Reporting it as a message
    // rather than a crash lets the parent attribute it to the job instead of guessing from an exit code.
    send({ type: 'done', failed: String(cause instanceof Error ? (cause.stack ?? cause.message) : cause) });
  } finally {
    clearInterval(sampler);
    // Explicit rather than letting the loop drain: ts-morph and better-sqlite3 both leave handles
    // behind, and a worker that lingers holds a slot the pool has already given away.
    process.exit(0);
  }
}

// A worker with no parent has nobody to report to and no work to do.
process.on('disconnect', () => {
  process.exit(0);
});
