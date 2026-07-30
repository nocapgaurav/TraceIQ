import type { ApiError } from './errors.js';

/** The API version reported by `GET /version` and the `x-traceiq-version` header. */
export const API_VERSION = '1.0.0';

/**
 * What every successful response carries.
 *
 * `data` is the capability result, returned **directly** — never reshaped, renamed or summarised. An
 * endpoint that wanted to add a field would be inventing information.
 *
 * `meta` says which endpoint answered, which capability produced it, and how many reads reaching the
 * database it cost. All three are deterministic for identical input, which is the point: a response
 * body is byte-identical across runs.
 */
export interface ResponseMeta {
  readonly endpoint: string;
  readonly capability: string;
  readonly graphApiCalls: number;
}

export interface SuccessBody<T> {
  readonly success: true;
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface ErrorBody {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly detail: string;
    readonly hint: string;
  };
  readonly meta: ResponseMeta;
}

export function success<T>(data: T, meta: ResponseMeta): SuccessBody<T> {
  return { success: true, data, meta };
}

export function failure(error: ApiError, meta: ResponseMeta): ErrorBody {
  return {
    success: false,
    error: { code: error.code, detail: error.detail, hint: error.hint },
    meta,
  };
}

/**
 * The request identifier and elapsed time deliberately live in **headers**, not in the body.
 *
 * Both vary between otherwise identical requests, and a body that varies cannot be compared, cached or
 * snapshot-tested. So observability goes in `x-request-id` and `x-response-time`, and the body stays
 * reproducible.
 */
export const REQUEST_ID_HEADER = 'x-request-id';
export const RESPONSE_TIME_HEADER = 'x-response-time';
export const VERSION_HEADER = 'x-traceiq-version';
