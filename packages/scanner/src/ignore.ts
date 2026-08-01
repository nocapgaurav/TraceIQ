/**
 * Directories that never take part in analysis: dependencies, version control
 * metadata and build output.
 *
 * The list is fixed by the milestone specification. Making it configurable would
 * mean two repositories could produce different inventories from the same
 * source, so it stays a constant until there is a stated reason to change it.
 */
export const IGNORED_DIRECTORY_NAMES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'out',
  // TraceIQ's own output. Universal discovery records every file, so without this a
  // repository scanned twice would find the graph database written by the first scan and
  // report it as one of its own files.
  '.traceiq',
] as const;

/**
 * Glob patterns excluding ignored directories and everything within them.
 *
 * Note that `**​/name/**` also matches the bare `name` entry, because the
 * trailing `/**` matches zero segments. These patterns therefore cannot express
 * "exclude the contents but report the directory", which is why directory
 * partitioning uses an explicit pruning walk instead of glob ignores.
 */
export const IGNORED_GLOB_PATTERNS: readonly string[] = IGNORED_DIRECTORY_NAMES.map(
  (name) => `**/${name}/**`,
);

const IGNORED = new Set<string>(IGNORED_DIRECTORY_NAMES);

export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED.has(name);
}
