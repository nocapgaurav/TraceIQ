import type { AnalysisErrorCode, AnalysisJob } from '@traceiq/analysis';

import { ApiError, badRequest, missingParameter } from './errors.js';

/**
 * Repository Analysis, as the wire carries it.
 *
 * The same shape as `apps/api/src/chat.ts`: request parsing, a wire projection and one error
 * translation, kept out of the endpoint table so the handlers stay three lines each.
 *
 * A job is returned as a **payload, not an error**, even when it failed. An analysis that could not
 * clone is a completed request describing an unsuccessful analysis — the HTTP call worked. Only a
 * malformed submission is an HTTP error.
 */

export interface WireStage {
  readonly name: string;
  readonly label: string;
  readonly status: string;
  readonly detail: string | null;
  /** How long this stage has run, or took. Elapsed time, never a percentage. */
  readonly elapsedMs: number | null;
}

export interface WireJob {
  readonly id: string;
  readonly url: string;
  readonly slug: string | null;
  readonly htmlUrl: string | null;
  readonly status: string;
  readonly stages: readonly WireStage[];
  readonly result: AnalysisJob['result'];
  readonly error: AnalysisJob['error'];
  readonly elapsedMs: number;
  readonly workspaceWarning: string | null;
  readonly telemetry: AnalysisJob['telemetry'];
}

/** Reads `{ url }` from a submission. The URL itself is validated by the analysis package, not here. */
export function readAnalysisUrl(body: unknown): string {
  if (body === null || typeof body !== 'object') {
    throw missingParameter('url', 'body');
  }

  const value = (body as { readonly url?: unknown }).url;

  if (typeof value !== 'string' || value.trim() === '') {
    throw missingParameter('url', 'body');
  }

  // A ceiling on what is even worth parsing. A URL this long is not a repository address.
  if (value.length > 2048) {
    throw badRequest('the url is longer than 2048 characters', 'paste a repository URL, such as https://github.com/facebook/react');
  }

  return value;
}

/** The repository slug is lifted to the top level: a client should not dig for what it is following. */
export function wireJob(job: AnalysisJob): WireJob {
  return {
    id: job.id,
    url: job.url,
    slug: job.repository?.slug ?? null,
    htmlUrl: job.repository?.htmlUrl ?? null,
    status: job.status,
    stages: job.stages.map((stage) => ({
      name: stage.name,
      label: stage.label,
      status: stage.status,
      detail: stage.detail,
      elapsedMs: stage.elapsedMs,
    })),
    result: job.result,
    error: job.error,
    elapsedMs: job.elapsedMs,
    workspaceWarning: job.workspaceWarning,
    // What it cost and where it ran. A reader watching a queue needs to know whether their job is
    // waiting or working, and an operator reading a slow one needs to know what it consumed.
    telemetry: job.telemetry,
  };
}

/**
 * An analysis code as an HTTP error.
 *
 * Used only where a *request* fails — asking for a job that does not exist. A failed analysis is
 * reported inside a 200, because the request to read it succeeded.
 */
export function analysisErrorStatus(code: AnalysisErrorCode): number {
  switch (code) {
    case 'invalid-url':
      return 400;
    case 'repository-not-found':
    case 'repository-private':
      return 404;
    case 'repository-too-large':
      return 413;
    case 'analysis-timeout':
      return 504;
    default:
      return 502;
  }
}

export function unknownAnalysis(id: string): ApiError {
  return new ApiError(
    'not-found',
    `no analysis with id '${id}'`,
    'analyses are held in memory and do not survive a restart; start a new one',
  );
}
