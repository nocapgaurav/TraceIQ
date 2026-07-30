import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { ENDPOINTS, methodsFor, type Endpoint } from './endpoints.js';
import {
  ApiError,
  badRequest,
  methodNotAllowed,
  notFound,
} from './errors.js';
import { GraphHolder } from './graph-holder.js';
import { openApiDocument } from './openapi.js';
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
}

export interface TraceIqApp {
  readonly express: Express;
  readonly holder: GraphHolder;
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
      void handle(endpoint, request, response, holder).catch(next);
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
    close: () => {
      holder.close();
    },
  };
}

async function handle(
  endpoint: Endpoint,
  request: Request,
  response: Response,
  holder: GraphHolder,
): Promise<void> {
  const data = await endpoint.handle({
    params: joinWildcards(request.params),
    query: readQuery(request.query),
    body: request.body,
    holder,
  });

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
