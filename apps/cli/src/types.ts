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
  /** `chat` only: which model to answer with. Required, because no default is baked in. */
  readonly model: string | null;
  /** `chat` only: which provider holds it. */
  readonly provider: string;
  /** `chat` only: what to ask about, as a prefixed identifier. Defaults to the repository as a whole. */
  readonly subject: string | null;
}
