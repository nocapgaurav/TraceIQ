/**
 * Reads the package globs that define a workspace.
 *
 * Two declarations exist and both are supported: pnpm states them in
 * `pnpm-workspace.yaml`, and npm, yarn and bun state them in package.json's
 * `workspaces`. When both are present pnpm's file wins, because a repository with a
 * `pnpm-workspace.yaml` is a pnpm workspace whatever else its manifest says.
 *
 * A glob is taken verbatim. Nothing here expands, resolves or checks it against the
 * filesystem — that is `matchWorkspaceDirectories`' job, and keeping the two apart is
 * what lets the parser be tested without a repository on disk.
 */

/** Negations, which pnpm permits. Recorded so a caller can exclude rather than ignore. */
export interface WorkspaceGlobs {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export const NO_WORKSPACE_GLOBS: WorkspaceGlobs = Object.freeze({
  include: Object.freeze([]),
  exclude: Object.freeze([]),
});

/**
 * Extracts `packages:` from a pnpm-workspace.yaml.
 *
 * **A deliberately narrow YAML subset**, not a parser: a top-level `packages:` key
 * followed by `- item` entries, with optional single or double quotes and `#` comments.
 * That is the only shape pnpm documents for this key and the only shape observed in
 * practice.
 *
 * Anything else is ignored rather than guessed at. A repository whose workspace file
 * uses flow sequences or anchors yields no globs, which degrades to treating the
 * repository as a single package — the same behaviour as before workspaces were
 * understood at all, and never a wrong answer stated confidently.
 */
export function parsePnpmWorkspaceGlobs(contents: string): WorkspaceGlobs {
  const include: string[] = [];
  const exclude: string[] = [];
  let inPackages = false;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripComment(rawLine);

    if (line.trim().length === 0) {
      continue;
    }

    // A non-indented line that is not a list item ends the `packages:` block, whatever
    // key it introduces.
    if (!/^\s/.test(line) && !line.trimStart().startsWith('-')) {
      inPackages = /^packages\s*:/.test(line);
      continue;
    }

    if (!inPackages) {
      continue;
    }

    const item = line.trim();

    if (!item.startsWith('-')) {
      continue;
    }

    const value = unquote(item.slice(1).trim());

    if (value.length === 0) {
      continue;
    }

    if (value.startsWith('!')) {
      exclude.push(value.slice(1));
    } else {
      include.push(value);
    }
  }

  return { include, exclude };
}

/**
 * Extracts `workspaces` from a parsed package.json.
 *
 * Both shapes npm accepts are handled: an array of globs, and an object with a
 * `packages` array. Yarn's `nohoist` and every other key are ignored.
 */
export function readManifestWorkspaceGlobs(manifest: unknown): WorkspaceGlobs {
  if (!isRecord(manifest)) {
    return NO_WORKSPACE_GLOBS;
  }

  const workspaces = manifest['workspaces'];
  const list = Array.isArray(workspaces)
    ? workspaces
    : isRecord(workspaces) && Array.isArray(workspaces['packages'])
      ? workspaces['packages']
      : null;

  if (list === null) {
    return NO_WORKSPACE_GLOBS;
  }

  const include: string[] = [];
  const exclude: string[] = [];

  for (const value of list) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue;
    }

    const glob = value.trim();

    if (glob.startsWith('!')) {
      exclude.push(glob.slice(1));
    } else {
      include.push(glob);
    }
  }

  return { include, exclude };
}

/**
 * Matches workspace globs against directories the walk already found.
 *
 * Matching a list the scanner holds rather than searching the disk means a workspace
 * glob can never reach into an ignored directory, and costs no further filesystem
 * calls. It also means a declared package that does not exist simply does not match,
 * which is the right outcome.
 *
 * Results are sorted, so a repository always yields its packages in one order.
 */
export function matchWorkspaceDirectories(
  globs: WorkspaceGlobs,
  directories: readonly string[],
): readonly string[] {
  if (globs.include.length === 0) {
    return [];
  }

  const included = globs.include.map(globToRegExp);
  const excluded = globs.exclude.map(globToRegExp);

  const matched = directories.filter(
    (directory) =>
      included.some((pattern) => pattern.test(directory)) &&
      !excluded.some((pattern) => pattern.test(directory)),
  );

  return [...matched].sort();
}

/**
 * Compiles the glob subset workspace declarations use: `*`, `**` and `?`.
 *
 * `*` stops at a path separator and `**` crosses them, which is the standard meaning.
 * A trailing `/**` also matches the directory itself, because `packages/**` is written
 * to mean "packages and everything under it".
 *
 * Character classes and brace expansion are not supported. They do not appear in
 * workspace declarations, and a half-implemented class would match the wrong
 * directories rather than none.
 */
function globToRegExp(glob: string): RegExp {
  const trimmed = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let pattern = '';

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] as string;

    if (character === '*') {
      if (trimmed[index + 1] === '*') {
        // `**/` may match zero segments, so the separator is part of the optional group.
        if (trimmed[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }

      continue;
    }

    pattern += character === '?' ? '[^/]' : escapeForRegExp(character);
  }

  return new RegExp(`^${pattern}$`);
}

function escapeForRegExp(character: string): string {
  return /[\\^$.|+()[\]{}]/.test(character) ? `\\${character}` : character;
}

function stripComment(line: string): string {
  const index = line.indexOf('#');

  return index === -1 ? line : line.slice(0, index);
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);

  return quoted?.[2] ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
