import type { LanguageAnalyzer } from '@traceiq/analyzer';
import type { AnalysisDepth, RepositoryGraphApi } from '@traceiq/graph-api';

/** What a scan produced, as counts rather than as the graph itself. */
export interface ScanSummary {
  readonly repository: string;
  readonly repositoryPath: string;
  readonly databasePath: string;
  readonly files: number;
  readonly declarations: number;
  readonly nodes: number;
  readonly edges: number;
  readonly unresolvedReferences: number;
  readonly routes: number;
  readonly environmentVariables: number;
  readonly externalPackages: number;
  readonly callEdges: number;
  readonly unresolvedCalls: number;
  /** Language distribution across the repository, by file count descending. */
  readonly languages: readonly { readonly language: string; readonly files: number }[];
  /** Technology regions discovered. At least one for any repository containing files. */
  readonly regions: number;
  readonly manifests: number;
  /** Distinct dependency names declared across every manifest. */
  readonly declaredDependencies: number;
  /**
   * Files artefact analysis classified, and how many it read the structure of.
   *
   * Reported as two numbers because their difference is the honest measurement of this capability's
   * reach: `artifacts` counts the non-source files the repository holds, and `artifactsRead` counts
   * those a format reader actually understood. A large gap is a statement about TraceIQ rather than
   * about the repository, and it should be visible without opening a graph.
   */
  readonly artifacts: number;
  readonly artifactsRead: number;
  /** Structural pieces of those artefacts the graph now holds: jobs, steps, services, headings. */
  readonly artifactElements: number;
  /** The deepest analysis reached anywhere in the repository. */
  readonly depth: AnalysisDepth;
  readonly isPolyglot: boolean;
  /**
   * Analysers that threw, and what they said.
   *
   * Empty for a clean scan. Non-empty means the scan still succeeded — the regions those analysers
   * would have covered are reported at discovery depth — so a caller that wants to surface the
   * failure has it, and one that does not still gets a usable graph.
   */
  readonly analyzerFailures: readonly { readonly analyzer: string; readonly failure: string }[];
}

/**
 * An open repository graph.
 *
 * `api` is the abstract read model. A consumer never learns what is behind it, which is what lets an
 * interface depend on this package without SQLite entering its own dependency tree.
 */
export interface RepositorySession {
  readonly api: RepositoryGraphApi;
  readonly databasePath: string;
  close(): void;
}

export interface ScanInput {
  readonly repositoryPath: string;
  /**
   * The analysers to run. Defaults to `DEFAULT_ANALYZERS`.
   *
   * Injectable so a test can register a deliberately failing analyser and prove that the rest of a
   * polyglot repository still analyses.
   */
  readonly analyzers?: readonly LanguageAnalyzer[];
  readonly databasePath: string;
  /**
   * Stamped into the stored revision.
   *
   * Required rather than minted here, for the same reason the Graph Store requires it: a timestamp
   * invented inside the pipeline would make two otherwise identical scans differ. No read ever
   * exposes it, so the graph a consumer sees is unaffected either way.
   */
  readonly createdAt: string;
  /**
   * Analyse even when the sources look unchanged since the last scan.
   *
   * The change check compares path, size and modification time, which misses an edit that preserves
   * both size and timestamp. That is a deliberate trade — hashing content would cost a full read of
   * the repository — and this is the way out for anyone who has hit it.
   */
  readonly force?: boolean;
}
