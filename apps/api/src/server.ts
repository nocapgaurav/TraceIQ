import { createApp, type TraceIqApp } from './app.js';

/**
 * Starts the server.
 *
 * Kept apart from `createApp` so the app is testable without a port: a test builds one and drives it
 * over a real socket or in process, and nothing here runs on import.
 */
export interface StartedServer {
  readonly port: number;
  readonly url: string;
  /**
   * The app behind the port.
   *
   * Exposed because a caller that injects its own `AnalysisRegistry` must also adopt what an analysis
   * produced — an analysis writes a staged database and something has to make it live. `createApp`
   * wires that itself for the registry it builds; a caller supplying one needs the same reach.
   */
  readonly app: TraceIqApp;
  close(): Promise<void>;
}

export async function startServer(input: {
  readonly databasePath: string;
  /** 0 asks the operating system for a free port, which is what a test wants. */
  readonly port: number;
  readonly log?: Parameters<typeof createApp>[0]['log'];
  /** The model the chat endpoints answer with. Omitted, they answer `ai-not-configured`. */
  readonly model?: Parameters<typeof createApp>[0]['model'];
  /** Analyses in flight. Omitted, the app builds one over the real git cloner. */
  readonly analyses?: Parameters<typeof createApp>[0]['analyses'];
  /**
   * Where analyses run. Omitted, they run in this process.
   *
   * **Forwarding these was missed once and the symptom was a lie.** The composition root passed an
   * executor, this function dropped it, and the startup banner said "out of process" while every
   * analysis ran on the event loop. It was caught because the job telemetry that only a worker can
   * report came back null — which is the argument for reporting measurements rather than intentions.
   */
  readonly executor?: Parameters<typeof createApp>[0]['executor'];
  readonly concurrency?: Parameters<typeof createApp>[0]['concurrency'];
  readonly analysisTimeoutMs?: Parameters<typeof createApp>[0]['analysisTimeoutMs'];
  readonly retries?: Parameters<typeof createApp>[0]['retries'];
}): Promise<StartedServer> {
  const app = createApp({
    databasePath: input.databasePath,
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.analyses === undefined ? {} : { analyses: input.analyses }),
    ...(input.executor === undefined ? {} : { executor: input.executor }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    ...(input.analysisTimeoutMs === undefined ? {} : { analysisTimeoutMs: input.analysisTimeoutMs }),
    ...(input.retries === undefined ? {} : { retries: input.retries }),
  });

  return await new Promise<StartedServer>((resolve) => {
    const server = app.express.listen(input.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : input.port;

      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        app,
        close: async () => {
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          });
          app.close();
        },
      });
    });
  });
}
