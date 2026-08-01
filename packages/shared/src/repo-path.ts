/**
 * Repository-relative POSIX paths are the basis of every stable node
 * identifier, so normalisation has to be deterministic and total: the same file
 * must always produce the same string, and anything that cannot produce one
 * must fail rather than guess.
 */
export class InvalidRepoPathError extends Error {
  constructor(rawPath: string, reason: string) {
    super(`Invalid repository path ${JSON.stringify(rawPath)}: ${reason}`);
    this.name = 'InvalidRepoPathError';
  }
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Normalises a repository-relative path into the canonical form used inside
 * node identifiers.
 *
 * Accepts either separator and tolerates redundant `.` segments, duplicate
 * slashes and a trailing slash. Rejects absolute paths, paths escaping the
 * repository root, and paths containing `#`, which delimits the symbol portion
 * of a `sym:` identifier.
 */
export function normalizeRepoPath(rawPath: string): string {
  const trimmed = rawPath.trim();

  if (trimmed.length === 0) {
    throw new InvalidRepoPathError(rawPath, 'the path is empty');
  }

  const withPosixSeparators = trimmed.replaceAll('\\', '/');

  if (withPosixSeparators.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(withPosixSeparators)) {
    throw new InvalidRepoPathError(
      rawPath,
      'identifiers require a repository-relative path, not an absolute one',
    );
  }

  const segments = withPosixSeparators
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments.includes('..')) {
    throw new InvalidRepoPathError(rawPath, 'the path escapes the repository root');
  }

  if (segments.length === 0) {
    throw new InvalidRepoPathError(rawPath, 'the path resolves to the repository root');
  }

  // `#` is the delimiter between a path and a container chain in `sym:<path>#<chain>`, so a path
  // containing one would make an identifier ambiguous. It is **encoded rather than rejected**, and
  // the difference is a whole repository: Next.js ships
  // `test/e2e/app-dir/resource-url-encoding/app/client#component.tsx`, and rejecting it threw out
  // of the *file* node — past the tolerant build, which retries without an analyser and cannot
  // retry without a file — so all 22,554 sources failed to scan over one legal file name.
  //
  // Percent-encoding is reversible and safe for every existing parser: those split on the first
  // literal `#`, and an encoded one contains none.
  return segments.join('/').replaceAll('#', '%23');
}
