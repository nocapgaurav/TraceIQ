import type { AnalysisDepth } from '@traceiq/graph-api';

import type { GitHubRepository } from './github-url.js';

/**
 * The analysis workflow's vocabulary.
 *
 * Stages are a **closed list in a fixed order**, and every one corresponds to work that actually
 * happens. There is no percentage anywhere in this file: the workflow cannot know how far through a
 * clone or a scan it is, and reporting a number it cannot measure would be inventing progress. What it
 * can report honestly is which step it is on, so that is what it reports.
 */
export const ANALYSIS_STAGES = [
  'validate',
  'clone',
  'scan',
  'load',
  'complete',
] as const;

export type AnalysisStageName = (typeof ANALYSIS_STAGES)[number];

/**
 * What each stage is called and what it covers.
 *
 * `scan` is deliberately one stage rather than the four the pipeline runs inside it. `RepositoryPipeline`
 * exposes no progress — it returns when the graph is written — so splitting it into "scanning source
 * files", "building the graph" and "detecting architecture" would mean ticking off steps the workflow
 * cannot observe. Naming what it genuinely covers is the honest version of that list.
 */
export const STAGE_LABELS: Readonly<Record<AnalysisStageName, string>> = {
  validate: 'Validating repository URL',
  clone: 'Cloning repository',
  scan: 'Scanning source and building the repository graph',
  load: 'Loading the repository graph',
  complete: 'Complete',
};

export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface AnalysisStage {
  readonly name: AnalysisStageName;
  readonly label: string;
  readonly status: StageStatus;
  /** What this stage produced, once it has. Never a guess about what it might produce. */
  readonly detail: string | null;
  /**
   * How long this stage has been running, or took.
   *
   * Added because "Scanning source and building the repository graph" is a single stage that can last
   * four minutes on a large repository, and a stage list with no clock on it is indistinguishable from
   * a stalled one. Still no percentage: the pipeline cannot say how far through it is, and elapsed
   * time is a fact rather than the guess a progress bar would have to make.
   */
  readonly elapsedMs: number | null;
}

/**
 * `queued` stopped being reserved.
 *
 * It was documented as a status that could not occur, because a single slot meant work began the
 * moment it was accepted. With a bounded worker pool a submission genuinely waits, and `queueWaitMs`
 * says for how long — which is the difference between "TraceIQ is slow" and "three repositories are
 * ahead of yours".
 *
 * `cancelled` is distinct from `failed` on purpose. A cancelled job produced no graph and neither did
 * a failed one, but only one of them is worth investigating, and a UI that showed a user's own Stop
 * as an error would be lying to them about their own action.
 */
export type AnalysisStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * What a job cost and where it ran.
 *
 * **Kept apart from the job's result because it describes the execution rather than the repository.**
 * Every field is measured rather than estimated: `cpuMs` and `peakRssBytes` come from the worker
 * process's own accounting, so they are that analysis's cost and not the API's. A field is `null` where
 * the number was genuinely not available — an in-process execution has no worker to report memory, and
 * saying zero would be a measurement that never happened.
 */
export interface JobTelemetry {
  /** Milliseconds between being accepted and being started. Zero when a worker was free. */
  readonly queueWaitMs: number;
  /** Milliseconds spent running, once started. */
  readonly runMs: number;
  /** Which worker ran it, for correlating with logs. `null` while queued or when run in process. */
  readonly worker: string | null;
  /** Worker CPU time, as the worker measured it. */
  readonly cpuMs: number | null;
  /** Worker peak resident memory, as the worker measured it. */
  readonly peakRssBytes: number | null;
  /** Bytes cloned, once the clone stage has finished. */
  readonly repositoryBytes: number | null;
  /** How many times this job has been started, including the current attempt. */
  readonly attempts: number;
}

/**
 * Why an analysis failed, as a closed vocabulary.
 *
 * A code rather than a message, so the HTTP layer maps it to a status and the UI branches on it without
 * matching prose — the same contract the API's own errors use.
 */
export const ANALYSIS_ERROR_CODES = [
  'invalid-url',
  'repository-not-found',
  'repository-private',
  'clone-failed',
  'repository-too-large',
  /**
   * The repository holds no files at all.
   *
   * Replaces `unsupported-repository`, which meant "not TypeScript". That is no longer a
   * failure: a repository in any language now produces structure, languages, manifests
   * and declared dependencies, and how deeply it was analysed is reported as a capability
   * rather than as an error.
   */
  'empty-repository',
  'pipeline-failed',
  'analysis-timeout',
  'network-failed',
] as const;

export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

export interface AnalysisFailure {
  readonly code: AnalysisErrorCode;
  readonly detail: string;
  readonly hint: string;
}

/** What a finished analysis produced. The pipeline's own summary, plus where it came from. */
export interface AnalysisResult {
  readonly repository: string;
  readonly slug: string;
  readonly htmlUrl: string;
  readonly files: number;
  readonly declarations: number;
  readonly nodes: number;
  readonly edges: number;
  readonly routes: number;
  readonly environmentVariables: number;
  readonly externalPackages: number;
  readonly callEdges: number;
  readonly unresolvedCalls: number;
  readonly unresolvedReferences: number;
  /**
   * What the repository is made of, and how deeply it was read.
   *
   * **Carried because the counts above are meaningless without it.** A Python service reports zero
   * routes and zero external packages, and a reader shown that with no language context reasonably
   * concludes the analysis found nothing — when what happened is that it found a different set of
   * things. `ScanSummary` has held all four of these since discovery became universal; this surface
   * simply dropped them on the floor.
   */
  readonly languages: readonly { readonly language: string; readonly files: number }[];
  readonly regions: number;
  readonly depth: AnalysisDepth;
  readonly isPolyglot: boolean;
  /** Analysers that failed. Empty for a clean analysis; non-empty means the graph is still usable. */
  readonly analyzerFailures: readonly { readonly analyzer: string; readonly failure: string }[];
}

export interface AnalysisJob {
  readonly id: string;
  /** The URL as submitted, so a reader can see what they asked for even if it was rejected. */
  readonly url: string;
  readonly repository: GitHubRepository | null;
  readonly status: AnalysisStatus;
  readonly stages: readonly AnalysisStage[];
  readonly result: AnalysisResult | null;
  readonly error: AnalysisFailure | null;
  /**
   * Milliseconds since this job was accepted.
   *
   * Elapsed time, not progress: it says how long the work has taken, and never implies how much is left.
   */
  readonly elapsedMs: number;
  /** Set when the workspace could not be removed. A completed analysis is not failed by a leak. */
  readonly workspaceWarning: string | null;
  /** What this job cost and where it ran. See `JobTelemetry`. */
  readonly telemetry: JobTelemetry;
}
