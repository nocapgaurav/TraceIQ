import { createApp } from './app.js';

/**
 * Starts the server.
 *
 * Kept apart from `createApp` so the app is testable without a port: a test builds one and drives it
 * over a real socket or in process, and nothing here runs on import.
 */
export interface StartedServer {
  readonly port: number;
  readonly url: string;
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
}): Promise<StartedServer> {
  const app = createApp({
    databasePath: input.databasePath,
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.analyses === undefined ? {} : { analyses: input.analyses }),
  });

  return await new Promise<StartedServer>((resolve) => {
    const server = app.express.listen(input.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : input.port;

      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
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
