import type { ScanSummary } from '@traceiq/pipeline';

/** Builds and stores a repository graph. Injected so a test can run `scan` without a real project. */
export type ScanRunner = (repositoryPath: string) => Promise<ScanSummary>;

/**
 * Where a command writes.
 *
 * Injected rather than reaching for `process`, so a test drives the CLI as a function and reads what
 * it produced, and so nothing in the command layer depends on a live terminal.
 */
export interface Io {
  write(text: string): void;
  writeError(text: string): void;
  readonly cwd: string;
}

export interface Options {
  /** Where the stored graph lives. */
  readonly databasePath: string;
  /** Print what the command cost after its output. */
  readonly profile: boolean;
}
