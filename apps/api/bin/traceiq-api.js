#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { OllamaProvider } from '@traceiq/ai-ollama';

import { startServer, WorkerAnalysisExecutor } from '../dist/index.js';

/**
 * The API's composition root.
 *
 * **This file is the only place in the API that names a model vendor.** It builds a provider, takes one
 * model from it, and passes that model to `startServer`. Nothing under `apps/api/src` imports
 * `@traceiq/ai-ollama`, and there is no registry — the chat endpoints receive a `LanguageModel` and never
 * learn what is behind it.
 *
 * With no `TRACEIQ_MODEL` set the API starts normally and the chat endpoints answer `ai-not-configured`.
 * Every other endpoint is unaffected, so a deployment that does not want AI simply omits the variable.
 */
const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.TRACEIQ_DB ?? '.traceiq/graph.db';
const modelId = process.env.TRACEIQ_MODEL;
const providerName = process.env.TRACEIQ_PROVIDER ?? 'ollama';
const baseUrl = process.env.TRACEIQ_OLLAMA_URL;

let model;

if (modelId !== undefined && modelId !== '') {
  if (providerName !== 'ollama') {
    process.stderr.write(`unknown provider '${providerName}'; the only provider implemented is 'ollama'\n`);
    process.exit(2);
  }

  /**
   * The runtime context window, as a ceiling.
   *
   * Exposed because it is the one AI setting a deployment genuinely has to own: it costs memory for
   * the key/value cache and, because the projection is budgeted from it, it costs time-to-first-token
   * directly — prompt evaluation on the reference stack runs at 45.75 tokens per second, so every
   * extra 1,000 tokens of prompt is another 22 seconds before the answer starts. A machine with a GPU
   * should raise it; a small container should not.
   *
   * Unset or unparseable falls back to the provider's own default rather than to zero, which would
   * leave no room for a single fact.
   */
  const maxContextWindow = Number(process.env.TRACEIQ_MODEL_CONTEXT);
  const provider = new OllamaProvider({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(Number.isFinite(maxContextWindow) && maxContextWindow > 0 ? { maxContextWindow } : {}),
  });
  const health = await provider.health();

  if (!health.available) {
    // A provider that is not running is a startup problem worth naming now, rather than a 503 per request.
    process.stderr.write(`model provider unavailable: ${health.detail}\n`);
    process.exit(2);
  }

  // Throws `model-not-found` if the provider does not hold it, which is the right time to find out.
  model = await provider.model(modelId);

  process.stdout.write(`chat enabled: ${providerName} ${modelId} (${model.describe().contextWindow} token window)\n`);
} else {
  process.stdout.write('chat disabled: set TRACEIQ_MODEL to enable POST /chat and POST /chat/stream\n');
}

/**
 * Analyses run in their own processes, and this is the only place that knows so.
 *
 * A graph build is synchronous and CPU-bound. Measured on `facebook/react` with `GET /ping` sampled
 * every 250 ms throughout an analysis: seven samples over five seconds and one that reached the
 * thirty-second client timeout, against a 4.9 ms median when idle. Nothing inside the pipeline can make
 * an event loop available while it runs, so the work leaves the process.
 *
 * The worker gets its own heap ceiling because an analysis peaks near 1.5 GB where the server idles
 * around 200 MB; sizing them together would mean either a wasteful server or a worker that cannot
 * analyse React.
 */
const executor = new WorkerAnalysisExecutor({
  workerPath: fileURLToPath(new URL('./analysis-worker.js', import.meta.url)),
  ...(Number.isFinite(Number(process.env.TRACEIQ_CLONE_TIMEOUT_MS)) && Number(process.env.TRACEIQ_CLONE_TIMEOUT_MS) > 0
    ? { cloneTimeoutMs: Number(process.env.TRACEIQ_CLONE_TIMEOUT_MS) }
    : {}),
  ...(Number.isFinite(Number(process.env.TRACEIQ_MAX_CLONE_MB)) && Number(process.env.TRACEIQ_MAX_CLONE_MB) > 0
    ? { maxCloneBytes: Number(process.env.TRACEIQ_MAX_CLONE_MB) * 1024 * 1024 }
    : {}),
  ...(Number.isFinite(Number(process.env.TRACEIQ_WORKER_HEAP_MB)) && Number(process.env.TRACEIQ_WORKER_HEAP_MB) > 0
    ? { maxOldSpaceMb: Number(process.env.TRACEIQ_WORKER_HEAP_MB) }
    : {}),
  log: (line) => process.stderr.write(line),
});

/**
 * How many analyses run at once.
 *
 * One by default, and the bound is a memory decision before it is a throughput one: two React-sized
 * analyses at 1.5 GB apiece exceed what a 4 GB container has to give, and an out-of-memory kill is a
 * worse outcome than a queue. Raise it where the machine has the memory.
 */
const concurrency = Math.max(1, Number(process.env.TRACEIQ_ANALYSIS_CONCURRENCY) || 1);
const analysisTimeoutMs = Number(process.env.TRACEIQ_ANALYSIS_TIMEOUT_MS);

process.stdout.write(`analysis: ${concurrency} worker${concurrency === 1 ? '' : 's'}, out of process\n`);

const server = await startServer({
  port,
  databasePath,
  executor,
  concurrency,
  ...(Number.isFinite(analysisTimeoutMs) && analysisTimeoutMs > 0 ? { analysisTimeoutMs } : {}),
  ...(model === undefined ? {} : { model }),
  log: (entry) => {
    process.stdout.write(
      `${entry.requestId} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs.toFixed(1)}ms\n`,
    );
  },
});

process.stdout.write(`traceiq api listening on ${server.url} (db ${databasePath})\n`);
