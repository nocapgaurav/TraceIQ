import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { LanguageModel } from '@traceiq/ai';
import { AnalysisRegistry, RepositoryAnalyzer, type AnalysisExecutor } from '@traceiq/analysis';

import { ENDPOINTS, methodsFor, type Endpoint } from './endpoints.js';
import {
  ApiError,
  badRequest,
  methodNotAllowed,
  notFound,
} from './errors.js';
import { GraphHolder } from './graph-holder.js';
import { openApiDocument } from './openapi.js';
import { openEventStream } from './sse.js';
import {
  API_VERSION,
  REQUEST_ID_HEADER,
  RESPONSE_TIME_HEADER,
  VERSION_HEADER,
  failure,
  success,
  type ResponseMeta,
} from './respond.js';

export interface LogEntry {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface AppOptions {
  readonly databasePath: string;
  /** Where request logs go. Injected so a test reads them instead of the console. */
  readonly log?: (entry: LogEntry) => void;
  /** Request identifiers, injected so a test can make them predictable. */
  readonly requestId?: () => string;
  /**
   * The language model the chat endpoints answer with.
   *
   * **Constructor injection, no registry.** The API never selects a provider: a composition root builds
   * one, takes a model from it, and passes it here. That is why nothing under `apps/api/src` names a
   * vendor. Omitted, the chat endpoints answer `ai-not-configured` and every other endpoint is unaffected.
   */
  readonly model?: LanguageModel;
  /**
   * Analyses in flight.
   *
   * Injected so a test drives the whole endpoint over a cloner that writes a fixture instead of reaching
   * GitHub. Omitted, the app builds its own with the real git cloner.
   */
  readonly analyses?: AnalysisRegistry;
  /**
   * Where analyses run. Omitted, they run in this process, which is what every test wants.
   *
   * The API's composition root supplies a process-backed one, because a graph build is synchronous and
   * CPU-bound: measured on React, running it here left `GET /ping` over five seconds seven times and
   * once at thirty.
   */
  readonly executor?: AnalysisExecutor;
  /** How many analyses may run at once. One by default — an analysis peaks at 1.5 GB. */
  readonly concurrency?: number;
  /** How long one attempt may run before it is stopped as stuck. */
  readonly analysisTimeoutMs?: number;
  /** How many times a transient failure is retried. */
  readonly retries?: number;
}

export interface TraceIqApp {
  readonly express: Express;
  readonly holder: GraphHolder;
  /** Whether analyses actually run in a worker. Observed from the wiring, never from a flag. */
  readonly analysisOutOfProcess: boolean;
  close(): void;
}

/**
 * The HTTP surface.
 *
 * **It contains zero repository intelligence.** Each route validates its parameters, calls one
 * capability and returns that capability's result unchanged. No traversal, no assembly, no
 * interpretation, and nothing reshaped — an endpoint that added a field would be inventing information.
 *
 * Middleware order is deliberate: identify, time, parse, then route, then handle what fell through.
 * Every dependency is passed in — the database path, the logger, the identifier source — so nothing
 * reaches for module state and two apps can run in one process without seeing each other.
 */
export function createApp(options: AppOptions): TraceIqApp {
  const holder = new GraphHolder(options.databasePath);
  /*
   * A successful analysis has written a new graph over the old one, so the open session is stale — it
   * still points at the previous repository. Reopening here is what makes the Overview show the newly
   * analysed repository without the browser being asked to reload anything.
   *
   * Only on success: a failed analysis leaves the previous graph untouched and still correct.
   */
  /**
   * Where an analysis runs, and what happens to what it produced.
   *
   * The executor is injected rather than constructed here when the composition root supplies one: the
   * API's own root forks a worker process, and a test drives the in-process analyzer over a fake cloner
   * with no network. Either satisfies `AnalysisExecutor`, and nothing else about a job depends on which.
   *
   * `onSettled` is where a staged database becomes the live graph — or is deleted. A failed or cancelled
   * analysis leaves the previous graph exactly as it was, which is the property that used to be missing:
   * an analysis that died halfway had already overwritten a graph that worked.
   */
  const analyses =
    options.analyses ??
    new AnalysisRegistry({
      analyzer: options.executor ?? new RepositoryAnalyzer(analyzerLimits()),
      concurrency: options.concurrency ?? 1,
      ...(options.analysisTimeoutMs === undefined ? {} : { timeoutMs: options.analysisTimeoutMs }),
      retries: options.retries ?? 1,
      onSettled: (job) => {
        holder.settle(job.id, job.status === 'succeeded');
      },
    });
  const log = options.log ?? (() => {});
  const nextRequestId = options.requestId ?? defaultRequestId();

  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);

  // 1. Identity, version and timing. The identifier and the elapsed time go in headers, never in the
  //    body, so a body stays byte-identical for identical input.
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = nextRequestId();
    const startedAt = process.hrtime.bigint();

    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.setHeader(VERSION_HEADER, API_VERSION);
    response.locals.requestId = requestId;

    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      log({
        requestId,
        method: request.method,
        path: request.originalUrl,
        status: response.statusCode,
        durationMs,
      });
    });

    // Set before the body is written, since a header cannot follow it.
    const send = response.send.bind(response);

    response.send = (body: unknown) => {
      if (!response.headersSent) {
        response.setHeader(
          RESPONSE_TIME_HEADER,
          `${(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(3)}ms`,
        );
      }

      return send(body);
    };

    next();
  });

  // 2. JSON bodies. A malformed body is a 400 with the same shape as every other error.
  app.use(express.json({ limit: '64kb' }));

  // 3. The OpenAPI document, generated from the endpoint table so it cannot drift from the routes.
  app.get('/openapi.json', (_request, response) => {
    response.json(openApiDocument());
  });

  // 4. Every endpoint, from the one table.
  for (const endpoint of ENDPOINTS) {
    app[endpoint.method](endpoint.path, (request, response, next) => {
      void handle(
        endpoint,
        request,
        response,
        holder,
        options.model ?? null,
        analyses,
        options.executor !== undefined,
      ).catch(next);
    });
  }

  // 5. A path an endpoint declares under a different method is a 405, not a 404.
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const allowed = ENDPOINTS.filter((endpoint) => matchesPath(endpoint, request.path)).map((endpoint) =>
      endpoint.method.toUpperCase(),
    );

    next(
      allowed.length > 0
        ? methodNotAllowed(request.method, request.path, allowed)
        : notFound(request.method, request.path),
    );
  });

  // 6. One error shape for everything, including a body Express itself rejected.
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const apiError = toApiError(error);

    response
      .status(apiError.status)
      .json(failure(apiError, metaFor(request, holder, 'api')));
  });

  return {
    express: app,
    holder,
    // Recorded rather than asserted: the one thing `/healthz` must never do is repeat an intention.
    analysisOutOfProcess: options.executor !== undefined,
    close: () => {
      holder.close();
    },
  };
}

/**
 * The two ceilings a deployment may raise, read from the environment.
 *
 * Read here rather than inside the analysis package, so that package stays a library with no opinion
 * about how it is configured — the same reason nothing under `packages/` reads `process.env` for its
 * behaviour. An unset or unparseable value falls back to the analyzer's own default rather than to zero,
 * which would refuse every repository.
 */
function analyzerLimits(): { readonly cloneTimeoutMs?: number; readonly maxCloneBytes?: number } {
  const timeout = Number(process.env.TRACEIQ_CLONE_TIMEOUT_MS);
  const megabytes = Number(process.env.TRACEIQ_MAX_CLONE_MB);

  return {
    ...(Number.isFinite(timeout) && timeout > 0 ? { cloneTimeoutMs: timeout } : {}),
    ...(Number.isFinite(megabytes) && megabytes > 0 ? { maxCloneBytes: megabytes * 1024 * 1024 } : {}),
  };
}

async function handle(
  endpoint: Endpoint,
  request: Request,
  response: Response,
  holder: GraphHolder,
  model: LanguageModel | null,
  analyses: AnalysisRegistry,
  analysisOutOfProcess: boolean,
): Promise<void> {
  // Aborted when the client disconnects, so a cancelled request actually stops the model generating rather
  // than leaving a local model burning CPU for an answer nobody will read.
  //
  // **The listener is on the response, not the request.** `close` on an `IncomingMessage` fires when that
  // readable stream is destroyed, which happens as soon as the body has been consumed — so listening there
  // aborted every POST with a body the instant it was parsed, and every chat answer failed with
  // `generation-aborted`. The response closes when the connection does, and `writableFinished`
  // distinguishes "the client left" from "we finished answering".
  const controller = new AbortController();

  response.on('close', () => {
    if (!response.writableFinished) {
      controller.abort();
    }
  });

  const context = {
    params: joinWildcards(request.params),
    query: readQuery(request.query),
    body: request.body,
    holder,
    analysisOutOfProcess,
    model,
    signal: controller.signal,
    analyses,
  };

  if (endpoint.stream !== undefined) {
    // The sink opens the stream on its first frame, so anything the handler throws beforehand — a malformed
    // body, an unknown subject, no model configured — still reaches the error handler with a real status.
    const sink = openEventStream(response);

    await endpoint.stream(context, sink);

    if (sink.started) {
      response.end();
    }

    return;
  }

  if (endpoint.handle === undefined) {
    throw new Error(`endpoint ${endpoint.operationId} has neither a handle nor a stream`);
  }

  const data = await endpoint.handle(context);

  response.status(endpoint.method === 'post' ? 201 : 200).json(
    success(data, metaFor(request, holder, endpoint.capability, endpoint.documentedPath)),
  );
}

function metaFor(
  request: Request,
  holder: GraphHolder,
  capability: string,
  documentedPath?: string,
): ResponseMeta {
  return {
    endpoint: documentedPath ?? `${request.method} ${request.path}`,
    capability,
    // Reads that reached the database. Zero when no graph was opened, which is the honest answer for
    // /ping and for a request that failed validation.
    graphApiCalls: holder.isScanned() ? holder.capabilities().graphApiCalls() : 0,
  };
}

/**
 * Express 5 gives a wildcard parameter as an array of path segments.
 *
 * Joined back into the one string the caller sent, so a handler sees `packages/health` rather than
 * `['packages','health']` and never has to know which parameters are wildcards.
 */
function joinWildcards(params: Request['params']): Readonly<Record<string, string>> {
  const joined: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    joined[key] = Array.isArray(value) ? value.join('/') : String(value ?? '');
  }

  return joined;
}

/** Only the first value of a repeated query parameter is read, so a request cannot be ambiguous. */
function readQuery(query: Request['query']): Readonly<Record<string, string>> {
  const flat: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') {
      flat[key] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      flat[key] = value[0];
    }
  }

  return flat;
}

function matchesPath(endpoint: Endpoint, path: string): boolean {
  const prefix = endpoint.path.replace(/\/\*.*$/, '');

  return endpoint.path.includes('*') ? path.startsWith(`${prefix}/`) : endpoint.path === path;
}

/**
 * Turns anything thrown into the one error shape.
 *
 * A body Express rejected arrives as a `SyntaxError` with a status, and is reported as
 * `bad-request` — the same shape as every error the API raises itself, so a client has one thing to
 * parse.
 */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return badRequest('the request body is not valid JSON', 'send a JSON object');
  }

  // Anything else is a defect rather than a client mistake. It is still reported in the one shape,
  // with the message, because a silent 500 is worse than a legible one.
  return new ApiError(
    'bad-request',
    error instanceof Error ? error.message : 'unhandled error',
    'this is a defect in the API rather than a problem with the request',
  );
}

/** Sequential identifiers, so a log can be followed. Replaced in tests to make them predictable. */
function defaultRequestId(): () => string {
  let counter = 0;

  return () => {
    counter += 1;

    return `req-${counter}`;
  };
}

export { methodsFor };
