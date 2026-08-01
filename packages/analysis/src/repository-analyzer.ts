import { RepositoryPipeline } from '@traceiq/pipeline';

import { GitCommandCloner, type GitCloner } from './git-cloner.js';
import { GitHubApiProbe, type RepositoryProbe } from './github-probe.js';
import { parseGitHubUrl } from './github-url.js';
import { createWorkspace, type Workspace } from './workspace.js';
import {
  ANALYSIS_STAGES,
  STAGE_LABELS,
  type AnalysisFailure,
  type AnalysisResult,
  type AnalysisStage,
  type AnalysisStageName,
} from './types.js';
import type { GitHubRepository } from './github-url.js';

/**
 * The Repository Analysis workflow: a GitHub URL in, a stored repository graph out.
 *
 * **It composes; it does not analyse.** Validation, a clone and a workspace are the only things this
 * package adds. Every fact about the repository comes from `RepositoryPipeline.scan`, which is called
 * exactly once and is not modified, wrapped or bypassed — the pipeline remains the source of truth, and
 * it never learns that the directory it was handed came from GitHub rather than from a disk.
 *
 * That boundary is what makes a second source — a zip upload, a local path, a mirror — a new caller
 * rather than a new pipeline.
 */
export interface AnalysisRequest {
  readonly url: string;
  readonly databasePath: string;
  /** Stamped into the stored revision, for the same reason the pipeline requires it. */
  readonly createdAt: string;
  readonly signal?: AbortSignal;
}

export interface AnalysisOutcome {
  readonly repository: GitHubRepository | null;
  readonly result: AnalysisResult | null;
  readonly failure: AnalysisFailure | null;
  /** Non-null when the workspace could not be removed. Never fails a completed analysis. */
  readonly workspaceWarning: string | null;
  /**
   * What running it cost, where the executor can say.
   *
   * **Absent from an in-process analysis on purpose.** `process.cpuUsage()` in the API would report the
   * server's CPU, not the analysis's — it would include every request served alongside it — and a
   * number that means something else is worse than no number. A worker process has nothing else to do,
   * so its own accounting *is* the analysis's cost.
   */
  readonly execution?: ExecutionCost;
}

export interface ExecutionCost {
  /** Which worker ran it, for correlating with logs. */
  readonly worker: string | null;
  readonly cpuMs: number | null;
  readonly peakRssBytes: number | null;
}

/** Called as the workflow moves. The runner uses it to keep a job's stage list current. */
export type StageListener = (stages: readonly AnalysisStage[]) => void;

export interface AnalyzerOptions {
  readonly cloner?: GitCloner;
  readonly probe?: RepositoryProbe;
  readonly pipeline?: RepositoryPipeline;
  readonly cloneTimeoutMs?: number;
  readonly maxCloneBytes?: number;
}

const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CLONE_BYTES = 2 * 1024 * 1024 * 1024;

export class RepositoryAnalyzer {
  readonly #cloner: GitCloner;
  readonly #probe: RepositoryProbe;
  readonly #pipeline: RepositoryPipeline;
  readonly #cloneTimeoutMs: number;
  readonly #maxCloneBytes: number;

  constructor(options: AnalyzerOptions = {}) {
    // Constructor injection, as everywhere else in this codebase: a test supplies a cloner that writes a
    // fixture directory, and nothing about the workflow changes.
    this.#cloner = options.cloner ?? new GitCommandCloner();
    this.#probe = options.probe ?? new GitHubApiProbe();
    this.#pipeline = options.pipeline ?? new RepositoryPipeline();
    this.#cloneTimeoutMs = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
    this.#maxCloneBytes = options.maxCloneBytes ?? DEFAULT_MAX_CLONE_BYTES;
  }

  /**
   * Runs the workflow.
   *
   * Cleanup is applied around the result rather than inside it: a `finally` cannot change a value that
   * has already been computed, so the workspace warning is attached here, after disposal has actually
   * happened. Every path — success, failure, throw — passes through the same disposal.
   */
  async analyze(request: AnalysisRequest, onStage: StageListener = () => {}): Promise<AnalysisOutcome> {
    const progress = new StageTracker(onStage);

    progress.begin('validate');

    const verdict = parseGitHubUrl(request.url);

    if (!verdict.ok) {
      progress.fail('validate', verdict.detail);

      return {
        repository: null,
        result: null,
        failure: { code: 'invalid-url', detail: verdict.detail, hint: verdict.hint },
        workspaceWarning: null,
      };
    }

    const repository = verdict.repository;

    progress.finish('validate', repository.slug);

    let workspace: Workspace;

    try {
      workspace = await createWorkspace();
    } catch (cause) {
      progress.fail('clone', 'the workspace could not be created');

      return {
        repository,
        result: null,
        failure: {
          code: 'clone-failed',
          detail: `A temporary workspace could not be created: ${cause instanceof Error ? cause.message : String(cause)}`,
          hint: 'Check that the server can write to its temporary directory, or set TRACEIQ_WORKSPACE_ROOT.',
        },
        workspaceWarning: null,
      };
    }

    /*
     * From here the workspace exists, so every exit runs through `finally`.
     *
     * Disposal happens after the pipeline has returned, never alongside it: the scan reads the cloned
     * tree from disk, so removing it while a scan is in flight would pull files out from under ts-morph.
     * `analyze` awaits the scan before it reaches the cleanup, which is what guarantees the ordering.
     */
    let outcome: AnalysisOutcome;
    let warning: string | null = null;

    try {
      outcome = await this.#afterClone(request, repository, workspace, progress);
    } finally {
      const cleanup = await workspace.dispose();

      if (!cleanup.removed) {
        warning = cleanup.reason;
      }
    }

    return { ...outcome, workspaceWarning: warning };
  }

  /**
   * Everything that needs the cloned tree on disk.
   *
   * Separated from `analyze` so the workspace has exactly one creation site and one disposal site, with
   * this whole method between them. The scan is awaited here, which is what guarantees the clone is
   * still on disk while the pipeline reads it.
   */
  async #afterClone(
    request: AnalysisRequest,
    repository: GitHubRepository,
    workspace: Workspace,
    progress: StageTracker,
  ): Promise<AnalysisOutcome> {
    {
      progress.begin('clone');

      /*
       * Ask GitHub whether the repository is even visible before cloning it.
       *
       * A typo then costs one request instead of a clone that fails with a message git cannot make
       * specific. `unknown` — the API unreachable or rate limited — falls through to the clone, which may
       * still succeed; the probe is an optimisation and a better message, never a gate.
       */
      const visibility = await this.#probe.probe(repository, request.signal);

      if (visibility === 'missing') {
        const failure: AnalysisFailure = {
          code: 'repository-not-found',
          detail: `${repository.slug} is not a public repository on GitHub.`,
          hint: 'GitHub reports no repository at that address. Check the spelling — a private repository looks the same to an anonymous client, and cannot be analysed in this version.',
        };

        progress.fail('clone', failure.detail);

        return { repository, result: null, failure, workspaceWarning: null };
      }

      const clone = await this.#cloner.clone({
        repository,
        destination: workspace.path,
        timeoutMs: this.#cloneTimeoutMs,
        maxBytes: this.#maxCloneBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      if (!clone.ok) {
        progress.fail('clone', clone.failure?.detail ?? 'the clone failed');

        return { repository, result: null, failure: clone.failure, workspaceWarning: null };
      }

      progress.finish(
        'clone',
        clone.bytes === null
          ? `${repository.slug} cloned`
          : `${repository.slug} cloned, ${formatBytes(clone.bytes)}`,
      );
      progress.begin('scan');

      let summary;

      try {
        // The one call into the engine. Everything the Overview later shows originates here.
        summary = await this.#pipeline.scan({
          repositoryPath: workspace.path,
          databasePath: request.databasePath,
          createdAt: request.createdAt,
        });
      } catch (cause) {
        const failure = classifyScan(cause, repository);

        progress.fail('scan', failure.detail);

        return { repository, result: null, failure, workspaceWarning: null };
      }

      progress.finish('scan', `${summary.files} files, ${summary.nodes} nodes, ${summary.edges} edges`);

      /*
       * `load` is a real step, not a flourish.
       *
       * The pipeline writes the database and closes it. Opening it proves the graph is readable before
       * the UI is sent to a page that assumes it is — a scan that wrote a corrupt or empty database
       * should fail here rather than as a broken Overview.
       */
      progress.begin('load');

      try {
        const session = this.#pipeline.open(request.databasePath);

        session.close();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);

        progress.fail('load', detail);

        return {
          repository,
          result: null,
          failure: {
            code: 'pipeline-failed',
            detail: `The repository graph was written but could not be reopened: ${detail}`,
            hint: 'This usually means the database path is not writable. Check TRACEIQ_DB.',
          },
          workspaceWarning: null,
        };
      }

      progress.finish('load', 'graph opened');
      progress.finish('complete', null);

      return {
        repository,
        result: {
          repository: summary.repository,
          slug: repository.slug,
          htmlUrl: repository.htmlUrl,
          files: summary.files,
          declarations: summary.declarations,
          nodes: summary.nodes,
          edges: summary.edges,
          routes: summary.routes,
          environmentVariables: summary.environmentVariables,
          externalPackages: summary.externalPackages,
          callEdges: summary.callEdges,
          unresolvedCalls: summary.unresolvedCalls,
          unresolvedReferences: summary.unresolvedReferences,
          languages: summary.languages,
          regions: summary.regions,
          depth: summary.depth,
          isPolyglot: summary.isPolyglot,
          analyzerFailures: summary.analyzerFailures,
        },
        failure: null,
        workspaceWarning: null,
      };
    }
  }

  /** The stage list as it looks before anything has run. The API returns this with a queued job. */
  static initialStages(): readonly AnalysisStage[] {
    return ANALYSIS_STAGES.map((name) => ({
      name,
      label: STAGE_LABELS[name],
      status: 'pending' as const,
      detail: null,
      elapsedMs: null,
    }));
  }
}

/**
 * Keeps the stage list consistent as the workflow moves through it.
 *
 * A small state machine rather than ad-hoc updates, so a failure cannot leave a later stage claiming to
 * be active and an abandoned stage cannot be left `pending` as though it were still to come — it becomes
 * `skipped`, which is what actually happened.
 */
class StageTracker {
  #stages: AnalysisStage[] = [...RepositoryAnalyzer.initialStages()];

  /**
   * When the currently active stage began.
   *
   * A single stage covers the whole graph build and can run for minutes on a large repository. A
   * reader watching a stage list with no clock on it cannot tell working from stalled, so each stage
   * carries the time it has been running. It is elapsed time, never a percentage: the pipeline reports
   * no progress of its own and a bar would have to invent one.
   */
  #startedAt: number | null = null;

  constructor(
    private readonly onChange: StageListener,
    private readonly now: () => number = () => Date.now(),
  ) {}

  begin(name: AnalysisStageName): void {
    this.#startedAt = this.now();
    this.#set(name, 'active', null);
  }

  finish(name: AnalysisStageName, detail: string | null): void {
    this.#set(name, 'done', detail);
    this.#startedAt = null;
  }

  fail(name: AnalysisStageName, detail: string): void {
    this.#set(name, 'failed', detail);
    this.#stages = this.#stages.map((stage) => (stage.status === 'pending' ? { ...stage, status: 'skipped' } : stage));
    this.#startedAt = null;
    this.onChange([...this.#stages]);
  }

  #set(name: AnalysisStageName, status: AnalysisStage['status'], detail: string | null): void {
    const elapsedMs = this.#startedAt === null ? null : this.now() - this.#startedAt;

    this.#stages = this.#stages.map((stage) =>
      stage.name === name ? { ...stage, status, detail, elapsedMs } : stage,
    );
    this.onChange([...this.#stages]);
  }
}

/**
 * A byte count a reader can hold in their head.
 *
 * Binary units, because that is what a filesystem reports and a repository is measured against a disk
 * rather than against a marketing figure.
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Why a scan failed.
 *
 * The pipeline reports one error type for every internal fault, so this reads its message for the two
 * cases a user can act on — a repository with no TypeScript, and one too big to hold in memory — and
 * treats everything else as a pipeline failure rather than guessing.
 */
function classifyScan(cause: unknown, repository: GitHubRepository): AnalysisFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = message.toLowerCase();

  if (text.includes('heap out of memory') || text.includes('allocation failed')) {
    return {
      code: 'repository-too-large',
      detail: `${repository.slug} exhausted the memory available to the analysis.`,
      hint: 'Very large repositories need more heap than this deployment allows. Try a smaller repository.',
    };
  }

  /*
   * The only repository TraceIQ still refuses.
   *
   * A repository written in a language with no semantic analyser is **not** a failure any
   * more: it is scanned, described and reported at `universal` depth. A checkout with no
   * files at all has nothing to describe, and that is what this reports.
   */
  if (text.includes('contains no files')) {
    return {
      code: 'empty-repository',
      detail: `${repository.slug} contains no files, so there is nothing to describe.`,
      hint: 'Check that the default branch is not empty. Any repository with files is accepted, whatever language it is written in.',
    };
  }

  return {
    code: 'pipeline-failed',
    detail: `Analysis of ${repository.slug} failed: ${message}`,
    hint: 'This is a fault in the analysis rather than in the repository. The API log has the full error.',
  };
}
