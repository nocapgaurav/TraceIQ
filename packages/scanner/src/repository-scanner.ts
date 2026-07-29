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
import type { RepositoryInventory } from './types.js';

/**
 * TypeScript sources only. Version 1 analyses TypeScript, and `.d.ts` files are
 * included because the Project Host needs them for resolution; deciding what to
 * do with a declaration file is a downstream concern, not a discovery one.
 */
const SOURCE_FILE_PATTERN = '**/*.{ts,tsx,mts,cts}';

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
 * filesystem on behalf of the engine, and it reads no file contents beyond
 * package.json.
 */
export class RepositoryScanner {
  async scan(repositoryPath: string): Promise<RepositoryInventory> {
    const rootPath = await this.resolveRoot(repositoryPath);

    const [sourceFiles, walk, rootFileNames] = await Promise.all([
      this.findSourceFiles(rootPath),
      this.walk(rootPath),
      this.readRootFileNames(rootPath),
    ]);

    const hasTsconfig = rootFileNames.includes(TSCONFIG_FILE_NAME);
    const hasPackageJson = rootFileNames.includes(PACKAGE_JSON_FILE_NAME);

    const manifest = hasPackageJson
      ? await readPackageManifest(path.join(rootPath, PACKAGE_JSON_FILE_NAME))
      : null;

    const lockfile = selectLockfile(rootFileNames);

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
  private async findSourceFiles(rootPath: string): Promise<readonly string[]> {
    try {
      const matches = await fastGlob(SOURCE_FILE_PATTERN, {
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
