import path from 'node:path';

import type { RepositoryInventory } from '@traceiq/scanner';
import { Project, type SourceFile } from 'ts-morph';

import { DEFAULT_COMPILER_OPTIONS } from './compiler-options.js';
import { ProjectContext } from './project-context.js';

export class ProjectHostError extends Error {
  constructor(rootPath: string, reason: string, options?: { cause: unknown }) {
    super(`Cannot load TypeScript project at ${rootPath}: ${reason}`, options);
    this.name = 'ProjectHostError';
  }
}

/**
 * Creates the one ts-morph `Project` a repository is analysed through.
 *
 * This is the only module permitted to construct a `Project`, and the boundary
 * exists because the TypeScript type checker is whole-program: any symbol lookup
 * may touch any file, so a second Project would mean a second copy of the
 * compiler's memory for the same repository.
 *
 * The host is stateless. Each `load` returns an independently owned context, and
 * nothing is cached or shared between calls — a singleton Project would be global
 * state, which the architecture forbids. "One Project instance" therefore means
 * one per context, not one per process.
 *
 * `load` is synchronous and CPU-bound. Creating the Program for a large
 * repository blocks for as long as it takes; presenting that as a promise would
 * imply an ability to yield that does not exist. Reporting progress and allowing
 * cancellation belong to a layer above this one.
 */
export class ProjectHost {
  load(inventory: RepositoryInventory): ProjectContext {
    if (!path.isAbsolute(inventory.rootPath)) {
      throw new ProjectHostError(inventory.rootPath, 'the repository root path is not absolute');
    }

    if (inventory.language !== 'typescript') {
      throw new ProjectHostError(
        inventory.rootPath,
        `the repository was detected as '${inventory.language}', not TypeScript`,
      );
    }

    const project = this.createProject(inventory);

    return new ProjectContext({
      project,
      rootPath: inventory.rootPath,
      tsconfigPath: inventory.tsconfigPath,
      sourceFilesByPath: this.addSourceFiles(project, inventory),
    });
  }

  /**
   * Reads compiler options from the repository's tsconfig.json but adds none of
   * the files it lists.
   *
   * The inventory is the authority on what is in scope, because it is what applied
   * the ignore rules. A tsconfig's `include` and `exclude` answer a different
   * question — what to compile — and letting them decide would mean the analysed
   * file set could disagree with the inventory that produced it.
   */
  private createProject(inventory: RepositoryInventory): Project {
    if (inventory.tsconfigPath === null) {
      return new Project({ compilerOptions: { ...DEFAULT_COMPILER_OPTIONS } });
    }

    const tsConfigFilePath = path.join(inventory.rootPath, inventory.tsconfigPath);

    try {
      return new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
    } catch (cause) {
      throw new ProjectHostError(
        inventory.rootPath,
        `the tsconfig at ${inventory.tsconfigPath} could not be read`,
        { cause },
      );
    }
  }

  /**
   * Adds the inventory's files one at a time.
   *
   * ts-morph offers a batch call, but it takes globs: a path containing glob
   * syntax would be silently misinterpreted, and a failure would name the batch
   * rather than the file. Adding individually costs a little speed and buys an
   * error that says which file was unreadable.
   */
  private addSourceFiles(
    project: Project,
    inventory: RepositoryInventory,
  ): ReadonlyMap<string, SourceFile> {
    const sourceFilesByPath = new Map<string, SourceFile>();

    for (const repoRelativePath of inventory.sourceFiles) {
      const absolutePath = path.join(inventory.rootPath, repoRelativePath);

      try {
        sourceFilesByPath.set(repoRelativePath, project.addSourceFileAtPath(absolutePath));
      } catch (cause) {
        throw new ProjectHostError(
          inventory.rootPath,
          `the source file ${repoRelativePath} could not be loaded`,
          { cause },
        );
      }
    }

    return sourceFilesByPath;
  }
}
