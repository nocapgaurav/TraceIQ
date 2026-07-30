import type { ApiResponse } from '@/types/api';

/**
 * The one place an HTTP request is made.
 *
 * **Every REST call in the app goes through here.** No component, hook or page constructs a URL or
 * calls `fetch`, so the wire protocol — the envelope, the error shape, the identifier encoding — is
 * described once.
 *
 * **Requests are same-origin.** They go to `/api/…` on this app's own host, and a Next rewrite forwards
 * them to the TraceIQ API. Calling the API directly from the browser does not work: it sends no
 * `Access-Control-Allow-Origin` header, so every cross-origin request is blocked before it is made. The
 * API is frozen for this milestone, so the proxy lives here rather than a CORS middleware being added
 * there. The upstream host is configured in `next.config.mjs`; see `TRACEIQ_API_URL`.
 */
export const API_BASE = '/api';

/** A failure the API described, carried with the code a caller can branch on. */
export class ApiError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly hint: string;
  readonly status: number;

  constructor(input: { code: string; detail: string; hint: string; status: number }) {
    super(`${input.code}: ${input.detail}`);
    this.name = 'ApiError';
    this.code = input.code;
    this.detail = input.detail;
    this.hint = input.hint;
    this.status = input.status;
  }

  /** True when the repository has not been scanned, which the UI answers with a prompt to scan. */
  get isNotScanned(): boolean {
    return this.code === 'repository-not-scanned';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A failure that never reached the API — the server is down, or the network is. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'the API could not be reached');
    this.name = 'NetworkError';
  }
}

/**
 * A path segment that may contain slashes and a `#`.
 *
 * Slashes are left alone — the API routes them with wildcards — but `#` **must** be percent-encoded,
 * because it starts a URL fragment and everything after it is dropped before the request is sent. This
 * is the whole reason a declaration identifier needs encoding at all.
 */
export function encodeSegment(value: string): string {
  return value.replace(/#/g, '%23');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...init?.headers },
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  let body: ApiResponse<T>;

  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError({
      code: 'bad-response',
      detail: `the API returned ${response.status} with a body that is not JSON`,
      hint: 'check that TRACEIQ_API_URL points at a running TraceIQ API',
      status: response.status,
    });
  }

  if (!body.success) {
    throw new ApiError({ ...body.error, status: response.status });
  }

  return body.data;
}

export const apiClient = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};
