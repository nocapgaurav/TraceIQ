/**
 * Every way a request can fail, as a closed vocabulary.
 *
 * A code rather than a message, so a client branches on the failure without matching prose. Each has
 * one HTTP status and one fixed wording, which is what makes an error response deterministic.
 */
export const ERROR_CODES = [
  'bad-request',
  'missing-parameter',
  'invalid-identifier',
  'invalid-package-name',
  'not-found',
  'unknown-identifier',
  'unknown-route',
  'unknown-package',
  'method-not-allowed',
  'repository-not-scanned',
  'invalid-repository',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * HTTP status per code.
 *
 * `400` means the request itself was malformed. `404` means the request was well-formed and the thing
 * it named does not exist. `405` is an unsupported method on a path that exists. `409` means the
 * server cannot answer yet because no graph has been built — a state problem, not a client mistake,
 * and distinct from a 404 so a client can tell "scan first" from "that symbol is not there".
 * `422` is a well-formed request whose content the pipeline rejected.
 */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  'bad-request': 400,
  'missing-parameter': 400,
  'invalid-identifier': 400,
  'invalid-package-name': 400,
  'not-found': 404,
  'unknown-identifier': 404,
  'unknown-route': 404,
  'unknown-package': 404,
  'method-not-allowed': 405,
  'repository-not-scanned': 409,
  'invalid-repository': 422,
};

/**
 * A failure a client can act on.
 *
 * `detail` names the specific thing that was wrong and is the only part that varies with input.
 * `hint` is fixed per code and says what to do next.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly hint: string;

  constructor(code: ErrorCode, detail: string, hint: string) {
    super(`${code}: ${detail}`);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
    this.hint = hint;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export function badRequest(detail: string, hint: string): ApiError {
  return new ApiError('bad-request', detail, hint);
}

export function missingParameter(name: string, where: 'query' | 'body' | 'path'): ApiError {
  return new ApiError('missing-parameter', `'${name}' is required in the ${where}`, `add ${name} to the request ${where}`);
}

export function invalidIdentifier(value: string): ApiError {
  return new ApiError(
    'invalid-identifier',
    `'${value}' is not a repository identifier`,
    'an identifier begins with sym:, file:, route:, env: or ext:',
  );
}

/**
 * A declaration identifier that lost its `#`.
 *
 * Almost always the URL encoding trap: `#` starts a fragment, so a client that sends it unencoded has
 * the rest of the identifier stripped before the request leaves. Reported as a 400 naming the fix
 * rather than as a 404, because the graph never had a chance to be asked.
 */
export function identifierMissingChain(value: string): ApiError {
  return new ApiError(
    'invalid-identifier',
    `'${value}' names no declaration: a sym: identifier needs a # and a chain`,
    'percent-encode the # as %23 — it starts a URL fragment and is otherwise stripped by the client',
  );
}

export function invalidPackageName(value: string): ApiError {
  return new ApiError('invalid-package-name', `'${value}' is not a package name`, 'a package name is a repository-relative path, as GET /packages lists them');
}

export function notFound(method: string, path: string): ApiError {
  return new ApiError('not-found', `no endpoint for ${method} ${path}`, 'see GET /openapi.json for every endpoint');
}

export function methodNotAllowed(method: string, path: string, allowed: readonly string[]): ApiError {
  return new ApiError('method-not-allowed', `${method} is not allowed on ${path}`, `allowed: ${allowed.join(', ')}`);
}

export function unknownIdentifier(id: string): ApiError {
  return new ApiError('unknown-identifier', `the graph holds nothing named '${id}'`, 'use GET /search?q= to find an identifier');
}

export function unknownRoute(method: string, path: string): ApiError {
  return new ApiError('unknown-route', `no route '${method} ${path}' is registered`, 'use GET /routes to list every route');
}

export function unknownPackage(name: string): ApiError {
  return new ApiError('unknown-package', `no package named '${name}'`, 'use GET /packages to list every package');
}

export function repositoryNotScanned(databasePath: string): ApiError {
  return new ApiError('repository-not-scanned', `no graph at '${databasePath}'`, 'POST /scan with { "repository": "<path>" } first');
}

export function invalidRepository(repositoryPath: string, reason: string): ApiError {
  return new ApiError('invalid-repository', `cannot scan '${repositoryPath}': ${reason}`, 'check the path and that it holds a TypeScript project');
}
