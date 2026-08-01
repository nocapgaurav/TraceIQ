import path from 'node:path';

import type { RepositoryInventory } from '@traceiq/scanner';
import { Project, type SourceFile } from 'ts-morph';

import type { CompilerOptions } from './compiler-options.js';
import { ProjectContext } from './project-context.js';
import {
  resolveCompilerOptions,
  type ResolvedCompilerOptions,
} from './resolve-compiler-options.js';

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
 * **One host per scan, and it caches what every unit of that scan shares.** The host used to be
 * stateless, which was right when a repository meant one program. Bounded compilation calls `load`
 * once per unit and twice per unit across the two passes — 64 times for TraceIQ's 32 units — and
 * resolving compiler options reads and parses every tsconfig in the repository each time. That is
 * the same answer 64 times over, computed from files that cannot change during a scan.
 *
 * The cache is per host instance, not per process. A host is created by the analyser for one scan
 * and discarded with it, so nothing outlives the analysis and there is still no global state.
 * Contexts remain independently owned: what is shared is the *decision*, not the program.
 *
 * `load` is synchronous and CPU-bound. Creating the Program for a large
 * repository blocks for as long as it takes; presenting that as a promise would
 * imply an ability to yield that does not exist. Reporting progress and allowing
 * cancellation belong to a layer above this one.
 */
export class ProjectHost {
  /**
   * Resolved compiler options, keyed by the repository they were resolved for.
   *
   * Keyed by root path and tsconfig path rather than by the whole inventory, because those two are
   * what `resolveCompilerOptions` actually reads — the source file list it is handed differs per
   * unit and changes nothing about the answer.
   */
  readonly #optionsCache = new Map<string, ResolvedCompilerOptions>();

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

    const cacheKey = `${inventory.rootPath}\u0000${inventory.tsconfigPath ?? ''}`;
    const cached = this.#optionsCache.get(cacheKey);
    const resolved = cached ?? resolveCompilerOptions(inventory);

    this.#optionsCache.set(cacheKey, resolved);

    // Fatal, and deliberately so. The scanner names a tsconfig only when it found one,
    // so a root config that will not parse means the repository would otherwise be
    // analysed under defaults while looking configured.
    if (resolved.rootTsconfigUnreadable) {
      throw new ProjectHostError(
        inventory.rootPath,
        `the tsconfig at ${inventory.tsconfigPath} could not be read`,
      );
    }

    const project = this.createProject(inventory, resolved.options);

    return new ProjectContext({
      project,
      rootPath: inventory.rootPath,
      tsconfigPath: inventory.tsconfigPath,
      sourceFilesByPath: this.addSourceFiles(project, inventory),
      configurationNotes: resolved.notes,
    });
  }

  /**
   * Creates the program under already-decided options, adding none of the files any
   * tsconfig lists.
   *
   * The inventory is the authority on what is in scope, because it is what applied
   * the ignore rules. A tsconfig's `include` and `exclude` answer a different
   * question — what to compile — and letting them decide would mean the analysed
   * file set could disagree with the inventory that produced it.
   *
   * Options arrive resolved rather than being read from `tsConfigFilePath` here. A
   * repository's root tsconfig is often a solution file declaring no options at all,
   * so handing the path to ts-morph configured nothing; `resolveCompilerOptions` is
   * where that is worked out, and it needs to merge several configs to do it.
   */
  private createProject(inventory: RepositoryInventory, compilerOptions: CompilerOptions): Project {
    try {
      return new Project({ compilerOptions: { ...compilerOptions } });
    } catch (cause) {
      throw new ProjectHostError(
        inventory.rootPath,
        'the resolved compiler options were rejected',
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
