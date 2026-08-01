import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readPackageManifest } from './manifest.js';
import type { WorkspacePackage } from './types.js';
import {
  NO_WORKSPACE_GLOBS,
  matchWorkspaceDirectories,
  parsePnpmWorkspaceGlobs,
  type WorkspaceGlobs,
} from './workspace-globs.js';

const PNPM_WORKSPACE_FILE_NAME = 'pnpm-workspace.yaml';
const PACKAGE_JSON_FILE_NAME = 'package.json';
const TSCONFIG_FILE_NAME = 'tsconfig.json';

/**
 * Source directory names tried, in order, when locating a package's sources.
 *
 * `''` is the package directory itself, for packages that keep sources at their root.
 * A candidate only wins if the scan actually found source files under it, so this is a
 * search order rather than an assumption.
 */
const SOURCE_DIRECTORY_CANDIDATES = ['src', 'lib', ''] as const;

/** Index file names tried inside the chosen source directory, in order. */
const INDEX_FILE_NAMES = ['index.ts', 'index.tsx', 'index.mts', 'index.cts'] as const;

/**
 * Finds the packages that make up a workspace.
 *
 * A workspace package is the reason a monorepo needs special handling at all: an import
 * of `@scope/thing` from a sibling package resolves, through node_modules, to that
 * package's *published types* — `dist/index.d.ts` — which is build output the scan
 * deliberately ignores. The reference therefore lands outside the analysed file set and
 * every fact about it is lost, so a monorepo's own internal structure is the one thing
 * its graph cannot show.
 *
 * What is returned here is the evidence needed to redirect those imports back to
 * source. It is discovery, not configuration: this module decides nothing about the
 * compiler, and the Project Host is free to use or ignore what it finds.
 *
 * A package is reported only when it has a name and at least one analysed source file,
 * because a mapping to a directory containing nothing the scan will read would resolve
 * imports to files that produce no nodes — worse than leaving them external, since it
 * would look like success.
 */
export async function discoverWorkspacePackages(input: {
  readonly rootPath: string;
  readonly directories: readonly string[];
  readonly sourceFiles: readonly string[];
  /** Globs from the root package.json's `workspaces`, already parsed by the manifest reader. */
  readonly manifestWorkspaceGlobs: WorkspaceGlobs;
}): Promise<readonly WorkspacePackage[]> {
  const globs = await readWorkspaceGlobs(input.rootPath, input.manifestWorkspaceGlobs);
  const directories = matchWorkspaceDirectories(globs, input.directories);

  if (directories.length === 0) {
    return [];
  }

  const sourceFiles = new Set(input.sourceFiles);
  const packages: WorkspacePackage[] = [];

  for (const directory of directories) {
    const found = await readWorkspacePackage({
      rootPath: input.rootPath,
      directory,
      sourceFiles,
    });

    if (found !== null) {
      packages.push(found);
    }
  }

  // Sorted by name so two scans of one repository agree, and so a later duplicate-name
  // check sees colliding packages adjacent.
  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.directory.localeCompare(b.directory));
}

async function readWorkspacePackage(input: {
  readonly rootPath: string;
  readonly directory: string;
  readonly sourceFiles: ReadonlySet<string>;
}): Promise<WorkspacePackage | null> {
  const manifestPath = path.join(input.rootPath, input.directory, PACKAGE_JSON_FILE_NAME);

  let manifest;

  try {
    manifest = await readPackageManifest(manifestPath);
  } catch {
    // A malformed manifest inside a workspace is not fatal to the scan. The package is
    // skipped, its imports stay external, and the rest of the repository is unaffected.
    return null;
  }

  if (manifest?.name === null || manifest === null) {
    return null;
  }

  const sourceDirectory = selectSourceDirectory(input.directory, input.sourceFiles);

  if (sourceDirectory === null) {
    return null;
  }

  return {
    name: manifest.name,
    directory: input.directory,
    sourceDirectory,
    entryFile: selectEntryFile(sourceDirectory, input.sourceFiles),
    tsconfigPath: (await exists(path.join(input.rootPath, input.directory, TSCONFIG_FILE_NAME)))
      ? joinRepoPath(input.directory, TSCONFIG_FILE_NAME)
      : null,
  };
}

/**
 * Picks the directory a package's sources actually live in.
 *
 * Decided by looking for analysed files rather than by reading the package's tsconfig
 * `rootDir`: the inventory is the authority on what will be analysed, and a `rootDir`
 * naming a directory the scan ignored would be a mapping into nothing.
 */
function selectSourceDirectory(
  directory: string,
  sourceFiles: ReadonlySet<string>,
): string | null {
  for (const candidate of SOURCE_DIRECTORY_CANDIDATES) {
    const prefix = `${joinRepoPath(directory, candidate)}/`;

    for (const file of sourceFiles) {
      if (file.startsWith(prefix)) {
        return joinRepoPath(directory, candidate);
      }
    }
  }

  return null;
}

function selectEntryFile(sourceDirectory: string, sourceFiles: ReadonlySet<string>): string | null {
  for (const name of INDEX_FILE_NAMES) {
    const candidate = joinRepoPath(sourceDirectory, name);

    if (sourceFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** pnpm's workspace file wins over a `workspaces` field, per the module's contract. */
async function readWorkspaceGlobs(
  rootPath: string,
  fromManifest: WorkspaceGlobs,
): Promise<WorkspaceGlobs> {
  let contents: string | null = null;

  try {
    contents = await readFile(path.join(rootPath, PNPM_WORKSPACE_FILE_NAME), 'utf8');
  } catch {
    contents = null;
  }

  if (contents !== null) {
    const globs = parsePnpmWorkspaceGlobs(contents);

    if (globs.include.length > 0) {
      return globs;
    }
  }

  return fromManifest.include.length > 0 ? fromManifest : NO_WORKSPACE_GLOBS;
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await readFile(absolutePath);

    return true;
  } catch {
    return false;
  }
}

/** Joins repository-relative segments, POSIX-separated, tolerating an empty segment. */
function joinRepoPath(base: string, segment: string): string {
  if (segment.length === 0) {
    return base;
  }

  return base.length === 0 ? segment : `${base}/${segment}`;
}
