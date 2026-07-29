import { normalizeRepoPath } from '@traceiq/shared';

import type { ManifestEntryField } from './manifest.js';
import type { EntryPoint } from './types.js';

/**
 * Conventional source entry points, in the order they are reported.
 *
 * These are guesses, and are marked `origin: 'convention'` so a consumer can
 * discount them against a declared entry.
 */
export const CONVENTIONAL_ENTRY_POINTS = [
  'src/index.ts',
  'src/main.ts',
  'src/server.ts',
  'src/app.ts',
  'index.ts',
  'server.ts',
  'app.ts',
] as const;

/**
 * Resolves entry points to discovered *source* files.
 *
 * A declared target only counts if it names a file the scan actually found. In
 * practice most manifests point at build output — `dist/index.js` — which is an
 * ignored directory and therefore never in the source set, so those targets are
 * intentionally dropped. Mapping build output back to the source that produced it
 * requires reading tsconfig and belongs to the Project Host, not here.
 *
 * Declared entries are reported before conventional ones, and a path is never
 * reported twice.
 */
export function resolveEntryPoints(input: {
  readonly manifestEntries: readonly ManifestEntryField[];
  readonly sourceFiles: readonly string[];
}): readonly EntryPoint[] {
  const sourceFiles = new Set(input.sourceFiles);
  const entryPoints: EntryPoint[] = [];
  const claimed = new Set<string>();

  for (const entry of input.manifestEntries) {
    const path = normalizeTarget(entry.target);

    if (path === null || !sourceFiles.has(path) || claimed.has(path)) {
      continue;
    }

    claimed.add(path);
    entryPoints.push({ path, origin: 'manifest', field: entry.field });
  }

  for (const candidate of CONVENTIONAL_ENTRY_POINTS) {
    if (!sourceFiles.has(candidate) || claimed.has(candidate)) {
      continue;
    }

    claimed.add(candidate);
    entryPoints.push({ path: candidate, origin: 'convention', field: null });
  }

  return entryPoints;
}

/**
 * A manifest target is untrusted input. Anything that cannot become a canonical
 * repository-relative path — an absolute path, `.`, a path escaping the root —
 * is not an entry point rather than an error, because a manifest may legitimately
 * point outside the analysed source set.
 */
function normalizeTarget(target: string): string | null {
  try {
    return normalizeRepoPath(target);
  } catch {
    return null;
  }
}
