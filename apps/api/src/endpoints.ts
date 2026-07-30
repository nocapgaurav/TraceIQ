import type { NodeId } from '@traceiq/types';

import {
  badRequest,
  identifierMissingChain,
  invalidIdentifier,
  invalidPackageName,
  invalidRepository,
  missingParameter,
  unknownIdentifier,
  unknownPackage,
  unknownRoute,
  type ErrorCode,
} from './errors.js';
import type { GraphHolder } from './graph-holder.js';
import { API_VERSION } from './respond.js';

/** What a handler is given. Nothing else about the request reaches a capability. */
export interface RequestContext {
  /** Path parameters, with a wildcard already joined back into one string. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly holder: GraphHolder;
}

export interface ParameterSpec {
  readonly name: string;
  readonly location: 'path' | 'query';
  readonly required: boolean;
  readonly description: string;
  readonly example: string;
}

export interface Endpoint {
  readonly method: 'get' | 'post';
  /** Express path, using `*name` for a parameter that may contain slashes. */
  readonly path: string;
  /** The same path in OpenAPI form, using `{name}`. */
  readonly documentedPath: string;
  readonly operationId: string;
  readonly summary: string;
  /** Which package produced the payload. Recorded in `meta.capability`. */
  readonly capability: string;
  readonly parameters: readonly ParameterSpec[];
  readonly requestBody?: { readonly description: string; readonly example: unknown };
  /** Errors this endpoint can return, beyond the ones every endpoint can. */
  readonly errors: readonly ErrorCode[];
  handle(context: RequestContext): Promise<unknown> | unknown;
}

const IDENTITY_PREFIX = /^(sym|file|route|env|ext):/;

/**
 * Every endpoint, and the single source of truth for routing, validation and the OpenAPI document.
 *
 * A handler **adapts and delegates**: it reads parameters, validates their shape, calls one capability
 * and returns its result unchanged. There is no repository intelligence here — no traversal, no
 * assembly, no interpretation — and an endpoint that reshaped a result would be inventing information.
 */
export const ENDPOINTS: readonly Endpoint[] = [
  {
    method: 'get',
    path: '/ping',
    documentedPath: '/ping',
    operationId: 'ping',
    summary: 'Liveness check. Answers without opening a graph.',
    capability: 'api',
    parameters: [],
    errors: [],
    handle() {
      return { status: 'ok' };
    },
  },
  {
    method: 'get',
    path: '/version',
    documentedPath: '/version',
    operationId: 'version',
    summary: 'API version and whether a graph has been scanned.',
    capability: 'api',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return { version: API_VERSION, scanned: holder.isScanned(), databasePath: holder.databasePath };
    },
  },
  {
    method: 'post',
    path: '/scan',
    documentedPath: '/scan',
    operationId: 'scan',
    summary: 'Build the repository graph and store it, replacing any existing graph.',
    capability: 'pipeline',
    parameters: [],
    requestBody: { description: 'The repository to scan.', example: { repository: '/path/to/repo' } },
    errors: ['bad-request', 'missing-parameter', 'invalid-repository'],
    async handle({ body, holder }) {
      const repository = readRepository(body);

      let summary;

      try {
        summary = await holder.pipeline.scan({
          repositoryPath: repository,
          databasePath: holder.databasePath,
          createdAt: FIXED_CREATED_AT,
        });
      } catch (error) {
        throw invalidRepository(repository, error instanceof Error ? error.message : 'unreadable');
      }

      // Swapped only once the new graph is written, in one synchronous step.
      holder.reopen();

      return summary;
    },
  },
  {
    method: 'get',
    path: '/overview',
    documentedPath: '/overview',
    operationId: 'overview',
    summary: 'Repository, architecture, package, graph and health summary.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().overview();
    },
  },
  {
    method: 'get',
    path: '/architecture',
    documentedPath: '/architecture',
    operationId: 'architecture',
    summary: 'Architecture, package, role and dependency trees.',
    capability: 'navigation',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().navigator().architecture();
    },
  },
  {
    method: 'get',
    path: '/packages',
    documentedPath: '/packages',
    operationId: 'listPackages',
    summary: 'Every derived package with its counts.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().browsePackages();
    },
  },
  {
    method: 'get',
    path: '/packages/*name',
    documentedPath: '/packages/{name}',
    operationId: 'getPackage',
    summary: 'One package: files, dependencies, dependents, roles.',
    capability: 'explorer',
    parameters: [
      {
        name: 'name',
        location: 'path',
        required: true,
        description: 'Package name as GET /packages reports it. May contain slashes.',
        example: 'packages/health',
      },
    ],
    errors: ['missing-parameter', 'invalid-package-name', 'unknown-package'],
    handle({ params, holder }) {
      const name = required(params.name, 'name', 'path');

      if (name.includes('..') || name.startsWith('/')) {
        throw invalidPackageName(name);
      }

      const view = holder.capabilities().explorer().browsePackage(name);

      if (view === null) {
        throw unknownPackage(name);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/files/*path',
    documentedPath: '/files/{path}',
    operationId: 'getFile',
    summary: 'One file: declarations, imports, exports, routes, statistics.',
    capability: 'explorer',
    parameters: [
      {
        name: 'path',
        location: 'path',
        required: true,
        description: 'Repository-relative file path. May contain slashes. A file: prefix is optional.',
        example: 'packages/health/src/types.ts',
      },
    ],
    errors: ['missing-parameter', 'unknown-identifier'],
    handle({ params, holder }) {
      const path = required(params.path, 'path', 'path');
      const id = (path.startsWith('file:') ? path : `file:${path}`) as NodeId;
      const view = holder.capabilities().explorer().browseFile(id);

      if (view === null) {
        throw unknownIdentifier(path);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/symbol/*id',
    documentedPath: '/symbol/{id}',
    operationId: 'getSymbol',
    summary: 'Everything the repository records about one declaration.',
    capability: 'explorer+explain+impact+health',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description:
          'Declaration identifier. Slashes are sent as-is; the # MUST be percent-encoded as %23, since it otherwise starts a URL fragment and the rest is stripped before the request is sent.',
        example: 'sym:packages/health/src/graph-index.ts%23buildGraphIndex',
      },
    ],
    errors: ['missing-parameter', 'invalid-identifier', 'unknown-identifier'],
    handle({ params, holder }) {
      const id = declarationIdentifier(required(params.id, 'id', 'path'));
      const view = holder.capabilities().explorer().browseSymbol(id);

      if (view === null) {
        throw unknownIdentifier(id);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/impact/*id',
    documentedPath: '/impact/{id}',
    operationId: 'getImpact',
    summary: 'What a change to one declaration could affect.',
    capability: 'impact',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description: 'Declaration identifier. The # must be percent-encoded as %23.',
        example: 'sym:packages/health/src/graph-index.ts%23buildGraphIndex',
      },
    ],
    errors: ['missing-parameter', 'invalid-identifier', 'unknown-identifier'],
    handle({ params, holder }) {
      const id = declarationIdentifier(required(params.id, 'id', 'path'));
      const result = holder.capabilities().impact().analyze(id);

      if (result === null) {
        throw unknownIdentifier(id);
      }

      return result;
    },
  },
  {
    method: 'get',
    path: '/routes',
    documentedPath: '/routes',
    operationId: 'listRoutes',
    summary: 'Every route the repository registers.',
    capability: 'navigation',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().navigator().routes();
    },
  },
  {
    method: 'get',
    path: '/route',
    documentedPath: '/route',
    operationId: 'getRoute',
    summary: 'One route: chain, roles reached, dependencies, health.',
    capability: 'navigation',
    parameters: [
      { name: 'method', location: 'query', required: true, description: 'HTTP method as registered.', example: 'GET' },
      { name: 'path', location: 'query', required: true, description: 'Route path as written at the registration.', example: '/users/:id' },
    ],
    errors: ['missing-parameter', 'unknown-route'],
    handle({ query, holder }) {
      const method = required(query.method, 'method', 'query');
      const path = required(query.path, 'path', 'query');
      const view = holder.capabilities().navigator().explainRoute({ method, path });

      if (view === null) {
        throw unknownRoute(method, path);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/health',
    documentedPath: '/health',
    operationId: 'getHealth',
    summary: 'Architectural health report. Not a liveness check — see /ping.',
    capability: 'health',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().health().analyze();
    },
  },
  {
    method: 'get',
    path: '/search',
    documentedPath: '/search',
    operationId: 'search',
    summary: 'Exact or prefix search, alphabetical. Never ranked.',
    capability: 'explorer',
    parameters: [
      { name: 'q', location: 'query', required: true, description: 'Text matched against a name and an identifier.', example: 'buildGraph' },
      { name: 'kind', location: 'query', required: false, description: 'Restrict to one node kind.', example: 'Class' },
      { name: 'path', location: 'query', required: false, description: 'Restrict to a path prefix.', example: 'packages/health' },
      { name: 'match', location: 'query', required: false, description: 'prefix (default) or exact.', example: 'exact' },
    ],
    errors: ['missing-parameter', 'bad-request'],
    handle({ query, holder }) {
      const text = required(query.q, 'q', 'query');
      const match = matchMode(query.match);

      return holder
        .capabilities()
        .explorer()
        .search({
          text,
          ...(query.kind === undefined ? {} : { kind: query.kind as never }),
          ...(query.path === undefined ? {} : { path: query.path }),
          ...(match === undefined ? {} : { match }),
        });
    },
  },
  {
    method: 'get',
    path: '/dependencies/*id',
    documentedPath: '/dependencies/{id}',
    operationId: 'getDependencies',
    summary: 'Direct and transitive dependencies of a package, file, declaration or route.',
    capability: 'navigation',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description:
          'An identifier, or a package name when it carries no identity prefix. A # in an identifier must be percent-encoded as %23.',
        example: 'packages/health',
      },
    ],
    errors: ['missing-parameter', 'unknown-identifier'],
    handle({ params, holder }) {
      const value = required(params.id, 'id', 'path');
      const navigator = holder.capabilities().navigator();
      const view = IDENTITY_PREFIX.test(value)
        ? navigator.dependencies(value as NodeId)
        : navigator.dependencies({ package: value });

      if (view === null) {
        throw unknownIdentifier(value);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/cycles',
    documentedPath: '/cycles',
    operationId: 'getCycles',
    summary: 'Every import, call, reference and inheritance cycle.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().cycles();
    },
  },
  {
    method: 'get',
    path: '/hotspots',
    documentedPath: '/hotspots',
    operationId: 'getHotspots',
    summary: 'The most connected declarations and files.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().hotspots();
    },
  },
];

/**
 * The revision timestamp a scan stamps into the store.
 *
 * Fixed rather than read from the clock, so two scans of one repository write identical databases. No
 * read exposes it, so the only thing a live clock would change is reproducibility.
 */
const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

export function findEndpoint(method: string, documentedPath: string): Endpoint | undefined {
  return ENDPOINTS.find(
    (endpoint) => endpoint.method === method.toLowerCase() && endpoint.documentedPath === documentedPath,
  );
}

/** Methods any endpoint declares for a documented path, for a 405. */
export function methodsFor(documentedPath: string): readonly string[] {
  return ENDPOINTS.filter((endpoint) => endpoint.documentedPath === documentedPath).map((endpoint) =>
    endpoint.method.toUpperCase(),
  );
}

function required(value: string | undefined, name: string, where: 'query' | 'body' | 'path'): string {
  if (value === undefined || value === '') {
    throw missingParameter(name, where);
  }

  return value;
}

function identifier(value: string): NodeId {
  if (!IDENTITY_PREFIX.test(value)) {
    throw invalidIdentifier(value);
  }

  return value as NodeId;
}

/**
 * A declaration identifier: `sym:<path>#<chain>`.
 *
 * The `#` is required, so an identifier truncated by URL fragment handling is caught here as a 400
 * naming the fix rather than reaching the graph and coming back as a puzzling 404.
 */
function declarationIdentifier(value: string): NodeId {
  const id = identifier(value);

  if (!value.startsWith('sym:') || !value.includes('#')) {
    throw identifierMissingChain(value);
  }

  return id;
}

function matchMode(value: string | undefined): 'prefix' | 'exact' | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== 'prefix' && value !== 'exact') {
    throw badRequest(`'${value}' is not a match mode`, "match must be 'prefix' or 'exact'");
  }

  return value;
}

function readRepository(body: unknown): string {
  if (body === null || typeof body !== 'object') {
    throw missingParameter('repository', 'body');
  }

  const value = (body as { readonly repository?: unknown }).repository;

  if (typeof value !== 'string' || value === '') {
    throw missingParameter('repository', 'body');
  }

  return value;
}
