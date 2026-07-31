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
}

/**
 * `queued` is reserved, not dead.
 *
 * With a single slot the work starts the moment it is accepted, so a job goes straight to `running`.
 * The status exists so that adding a real queue later is a change inside the registry rather than a
 * change to this contract and every client reading it.
 */
export type AnalysisStatus = 'queued' | 'running' | 'succeeded' | 'failed';

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
  'unsupported-repository',
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
}
