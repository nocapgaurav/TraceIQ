import type { RepositoryGraphApi } from '@traceiq/graph-api';

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
  readonly databasePath: string;
  /**
   * Stamped into the stored revision.
   *
   * Required rather than minted here, for the same reason the Graph Store requires it: a timestamp
   * invented inside the pipeline would make two otherwise identical scans differ. No read ever
   * exposes it, so the graph a consumer sees is unaffected either way.
   */
  readonly createdAt: string;
}
