import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import fastGlob from 'fast-glob';

import { detectFramework } from './detect-framework.js';
import { detectLanguage } from './detect-language.js';
import { selectLockfile } from './detect-package-manager.js';
import { walkDirectories, type DirectoryWalk } from './directory-walk.js';
import { resolveEntryPoints } from './entry-points.js';
import { IGNORED_GLOB_PATTERNS } from './ignore.js';
import { readPackageManifest } from './manifest.js';
import { deriveTechnologyRegions, repositoryLanguages } from './technology-regions.js';
import type { RepositoryInventory } from './types.js';
import { discoverUniversalFacts } from './universal-discovery.js';
import { NO_WORKSPACE_GLOBS } from './workspace-globs.js';
import { discoverWorkspacePackages } from './workspace-packages.js';

/**
 * Everything, so that a repository can be described whatever it is written in.
 *
 * Discovery is universal and analysis is layered: the walk finds every file, and a
 * language analyser later takes the subset it can read. Globbing only TypeScript — which
 * is what this did — meant a repository without it appeared empty, and a polyglot
 * repository appeared to be only its TypeScript part.
 */
const ALL_FILES_PATTERN = '**/*';

/**
 * The subset of the universal file set the TypeScript compiler can read.
 *
 * JavaScript is included because the compiler analyses it natively with `allowJs`: `.js`, `.jsx`,
 * `.mjs` and `.cjs` get the same declarations, imports, exports and call binding TypeScript does,
 * from the same program. A separate JavaScript analyser would be a second implementation of work
 * the compiler already does.
 *
 * `.d.ts` is included because the Project Host needs declaration files for resolution; deciding
 * what to do with one is a downstream concern, not a discovery one.
 */
const COMPILER_READABLE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const TSCONFIG_FILE_NAME = 'tsconfig.json';
const PACKAGE_JSON_FILE_NAME = 'package.json';

export class RepositoryScanError extends Error {
  constructor(repositoryPath: string, reason: string, options?: { cause: unknown }) {
    super(`Cannot scan repository at ${repositoryPath}: ${reason}`, options);
    this.name = 'RepositoryScanError';
  }
}

/**
 * Discovers what a repository contains. This is the only module that touches the
 * filesystem on behalf of the engine.
 *
 * **Discovery is universal; analysis is layered.** Every file is found and classified
 * whatever language it is in, and only manifests have their contents read. Which subset a
 * language analyser can then parse is that analyser's concern — a repository is never
 * rejected here for being written in the wrong thing.
 */
export class RepositoryScanner {
  async scan(
    repositoryPath: string,
    options?: {
      /**
       * Repository-relative paths to leave out of the inventory entirely.
       *
       * For a caller that writes into the repository it is scanning. The graph database is
       * the case that matters: universal discovery records every file, so without this a
       * second scan would find the database the first scan wrote and report it as one of
       * the repository's own files — and the two scans would disagree.
       *
       * Applied before languages and regions are derived, so every part of the inventory
       * agrees about what the repository contains.
       */
      readonly excludeFiles?: readonly string[];
    },
  ): Promise<RepositoryInventory> {
    const rootPath = await this.resolveRoot(repositoryPath);

    const [allFilePaths, walk, rootFileNames] = await Promise.all([
      this.findFiles(rootPath),
      this.walk(rootPath),
      this.readRootFileNames(rootPath),
    ]);

    const excluded = new Set(options?.excludeFiles ?? []);
    const filePaths = allFilePaths.filter((filePath) => !excluded.has(filePath));

    const universal = await discoverUniversalFacts({ rootPath, filePaths });

    // The TypeScript subset, taken from the universal set rather than globbed separately,
    // so the two can never disagree about what the repository contains.
    const sourceFiles = filePaths.filter((filePath) => COMPILER_READABLE_EXTENSIONS.test(filePath));

    const hasTsconfig = rootFileNames.includes(TSCONFIG_FILE_NAME);
    const hasPackageJson = rootFileNames.includes(PACKAGE_JSON_FILE_NAME);

    const manifest = hasPackageJson
      ? await readPackageManifest(path.join(rootPath, PACKAGE_JSON_FILE_NAME))
      : null;

    const lockfile = selectLockfile(rootFileNames);

    // Discovery, not configuration: what this finds lets the Project Host point a
    // sibling import at source instead of at ignored build output. It reads each
    // package's manifest, so it runs after the root manifest rather than beside it.
    const workspacePackages = await discoverWorkspacePackages({
      rootPath,
      directories: walk.directories,
      sourceFiles,
      manifestWorkspaceGlobs: manifest?.workspaceGlobs ?? NO_WORKSPACE_GLOBS,
    });

    return {
      name: manifest?.name ?? path.basename(rootPath),
      rootPath,
      language: detectLanguage({ hasTsconfig, sourceFileCount: sourceFiles.length }),
      framework: detectFramework(manifest?.dependencyNames ?? []),
      packageManager: lockfile?.packageManager ?? 'unknown',
      sourceFiles,
      directories: walk.directories,
      tsconfigPath: hasTsconfig ? TSCONFIG_FILE_NAME : null,
      packageJsonPath: hasPackageJson ? PACKAGE_JSON_FILE_NAME : null,
      lockfile,
      entryPoints: resolveEntryPoints({
        manifestEntries: manifest?.entryFields ?? [],
        sourceFiles,
      }),
      ignoredPaths: walk.ignoredPaths,
      workspacePackages,
      files: universal.files,
      languages: repositoryLanguages(universal.files),
      manifests: universal.manifests,
      regions: deriveTechnologyRegions({
        files: universal.files,
        manifests: universal.manifests,
      }),
    };
  }

  private async resolveRoot(repositoryPath: string): Promise<string> {
    if (repositoryPath.trim().length === 0) {
      throw new RepositoryScanError(repositoryPath, 'the path is empty');
    }

    const rootPath = path.resolve(repositoryPath);
    let stats;

    try {
      stats = await stat(rootPath);
    } catch (cause) {
      const reason =
        (cause as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'the path does not exist'
          : 'the path could not be read';

      throw new RepositoryScanError(rootPath, reason, { cause });
    }

    if (!stats.isDirectory()) {
      throw new RepositoryScanError(rootPath, 'the path is not a directory');
    }

    return rootPath;
  }

  /**
   * Results are sorted so that scanning the same repository twice produces an
   * identical inventory. Walk order is not guaranteed, and an unstable inventory
   * would produce unstable output in everything downstream.
   */
  private async findFiles(rootPath: string): Promise<readonly string[]> {
    try {
      const matches = await fastGlob(ALL_FILES_PATTERN, {
        cwd: rootPath,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: [...IGNORED_GLOB_PATTERNS],
      });

      return matches.sort();
    } catch (cause) {
      throw new RepositoryScanError(rootPath, 'the repository could not be searched for sources', {
        cause,
      });
    }
  }

  private async walk(rootPath: string): Promise<DirectoryWalk> {
    try {
      return await walkDirectories(rootPath);
    } catch (cause) {
      throw new RepositoryScanError(rootPath, 'the repository directories could not be walked', {
        cause,
      });
    }
  }

  private async readRootFileNames(rootPath: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(rootPath, { withFileTypes: true });

      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (cause) {
      throw new RepositoryScanError(rootPath, 'the repository root could not be listed', {
        cause,
      });
    }
  }
}
