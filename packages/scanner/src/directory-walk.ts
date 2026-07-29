import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isIgnoredDirectoryName } from './ignore.js';

export interface DirectoryWalk {
  /** Directories taking part in analysis, repository-relative, sorted. */
  readonly directories: readonly string[];
  /** Ignored directories that exist, repository-relative, sorted. */
  readonly ignoredPaths: readonly string[];
}

/**
 * Partitions a repository's directories into those that take part in analysis and
 * those that are ignored.
 *
 * An ignored directory is recorded and then not entered, so `ignoredPaths` names
 * what was skipped while nothing inside it is ever read. That distinction cannot
 * be expressed with glob ignore patterns, which is why this is an explicit walk.
 *
 * Symlinked directories are recorded by neither list: `readdir` reports a symlink
 * as a symlink rather than a directory, so the walk cannot leave the repository or
 * loop.
 *
 * The walk is sequential. It is pruned at every ignored directory, so the tree it
 * covers is the source tree, and concurrency here would trade a real risk of
 * exhausting file descriptors on a large monorepo for an unmeasured gain.
 */
export async function walkDirectories(rootPath: string): Promise<DirectoryWalk> {
  const directories: string[] = [];
  const ignoredPaths: string[] = [];

  await visit(rootPath, '', directories, ignoredPaths);

  return { directories: directories.sort(), ignoredPaths: ignoredPaths.sort() };
}

async function visit(
  rootPath: string,
  relativePath: string,
  directories: string[],
  ignoredPaths: string[],
): Promise<void> {
  const entries = await readdir(path.join(rootPath, relativePath), { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childPath = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;

    if (isIgnoredDirectoryName(entry.name)) {
      ignoredPaths.push(childPath);
      continue;
    }

    directories.push(childPath);

    await visit(rootPath, childPath, directories, ignoredPaths);
  }
}
