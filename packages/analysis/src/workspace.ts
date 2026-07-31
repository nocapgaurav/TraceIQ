import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A temporary directory holding one cloned repository.
 *
 * Owning this as a type rather than as two loose calls is what makes cleanup provable: a workspace is
 * created in one place and disposed in one place, and the analysis workflow's `finally` is the only
 * caller of `dispose`. There is no path for a clone to outlive the analysis that made it.
 *
 * **Disposal never throws.** A workspace that cannot be removed is a leaked directory in the system
 * temporary folder — worth reporting, never worth failing a completed analysis over, and never worth
 * masking the real error when one is already propagating.
 */
export interface Workspace {
  /** Absolute path to the directory. Empty until something clones into it. */
  readonly path: string;
  /**
   * Removes the directory and everything in it.
   *
   * Returns the failure rather than throwing it, so a caller can report a leak without a second
   * try/catch around its own cleanup.
   */
  dispose(): Promise<{ readonly removed: boolean; readonly reason: string | null }>;
}

/**
 * Where workspaces are created.
 *
 * A directory of our own under the system temp folder, so everything TraceIQ creates is identifiable and
 * a sweep can find leftovers from a previous run without guessing.
 */
export const WORKSPACE_PREFIX = 'traceiq-analysis-';

export function workspaceRoot(): string {
  return process.env.TRACEIQ_WORKSPACE_ROOT ?? tmpdir();
}

export async function createWorkspace(): Promise<Workspace> {
  const directory = await mkdtemp(path.join(workspaceRoot(), WORKSPACE_PREFIX));

  return {
    path: directory,
    dispose: async () => {
      try {
        // `force` so a workspace whose clone failed part-way — or never started — is not itself an error.
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });

        return { removed: true, reason: null };
      } catch (cause) {
        return { removed: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}
