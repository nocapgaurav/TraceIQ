#!/usr/bin/env node
import { startServer } from '../dist/index.js';

const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.TRACEIQ_DB ?? '.traceiq/graph.db';

const server = await startServer({
  port,
  databasePath,
  log: (entry) => {
    process.stdout.write(
      `${entry.requestId} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs.toFixed(1)}ms\n`,
    );
  },
});

process.stdout.write(`traceiq api listening on ${server.url} (db ${databasePath})\n`);
