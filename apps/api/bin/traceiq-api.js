#!/usr/bin/env node
import { OllamaProvider } from '@traceiq/ai-ollama';

import { startServer } from '../dist/index.js';

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

  const provider = new OllamaProvider(baseUrl === undefined ? {} : { baseUrl });
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

const server = await startServer({
  port,
  databasePath,
  ...(model === undefined ? {} : { model }),
  log: (entry) => {
    process.stdout.write(
      `${entry.requestId} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs.toFixed(1)}ms\n`,
    );
  },
});

process.stdout.write(`traceiq api listening on ${server.url} (db ${databasePath})\n`);
