import type { Lockfile, PackageManagerName } from './types.js';

interface LockfileDefinition {
  readonly fileName: string;
  readonly packageManager: PackageManagerName;
}

/**
 * Recognised lockfiles, in precedence order.
 *
 * Order matters because repositories do end up with more than one lockfile,
 * usually after a migration. Rather than reporting the ambiguity as `'unknown'`
 * — which would be less useful than a defensible guess — the first match wins,
 * and `Lockfile.path` records which file the answer came from so the decision
 * stays explainable.
 */
export const LOCKFILES: readonly LockfileDefinition[] = [
  { fileName: 'pnpm-lock.yaml', packageManager: 'pnpm' },
  { fileName: 'package-lock.json', packageManager: 'npm' },
  { fileName: 'yarn.lock', packageManager: 'yarn' },
  { fileName: 'bun.lock', packageManager: 'bun' },
  { fileName: 'bun.lockb', packageManager: 'bun' },
];

/**
 * Selects the lockfile from the file names present at the repository root.
 *
 * Only the root is considered. A lockfile nested inside a workspace package does
 * not determine how the repository as a whole is installed.
 */
export function selectLockfile(rootFileNames: readonly string[]): Lockfile | null {
  for (const definition of LOCKFILES) {
    if (rootFileNames.includes(definition.fileName)) {
      return { path: definition.fileName, packageManager: definition.packageManager };
    }
  }

  return null;
}
