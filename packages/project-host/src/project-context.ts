import type { Project, SourceFile, TypeChecker } from 'ts-morph';

import { freezeCompilerOptions, type CompilerOptions } from './compiler-options.js';

export class ProjectContextDisposedError extends Error {
  constructor(rootPath: string) {
    super(`The project context for ${rootPath} has been disposed and can no longer be used.`);
    this.name = 'ProjectContextDisposedError';
  }
}

/**
 * An owned, immutable view of one TypeScript program.
 *
 * A context is a snapshot: the set of source files is fixed when it is created.
 * Nothing here adds, removes or edits files, so the type checker handed out
 * cannot be invalidated underneath a consumer mid-analysis.
 *
 * Construct one through `ProjectHost.load`. The constructor is public only
 * because TypeScript has no package-private visibility; it takes an already
 * configured `Project` and is not a supported entry point.
 *
 * The context holds the compiler's memory for the whole repository, which is why
 * it has an explicit lifecycle. Call `dispose` when analysis is finished; every
 * accessor throws afterwards, so a stale context fails loudly rather than
 * returning results from a program that was meant to be released.
 */
export class ProjectContext {
  #project: Project | null;
  #typeChecker: TypeChecker | null;
  #sourceFiles: readonly SourceFile[] | null;
  #sourceFilesByPath: ReadonlyMap<string, SourceFile> | null;
  #compilerOptions: Readonly<CompilerOptions> | null;

  /** Absolute path to the repository root. */
  readonly rootPath: string;

  /** Repository-relative path to the tsconfig.json in use, or `null`. */
  readonly tsconfigPath: string | null;

  constructor(input: {
    readonly project: Project;
    readonly rootPath: string;
    readonly tsconfigPath: string | null;
    /** Repository-relative path to source file, in inventory order. */
    readonly sourceFilesByPath: ReadonlyMap<string, SourceFile>;
  }) {
    this.rootPath = input.rootPath;
    this.tsconfigPath = input.tsconfigPath;

    this.#project = input.project;
    this.#sourceFilesByPath = input.sourceFilesByPath;
    this.#sourceFiles = [...input.sourceFilesByPath.values()];
    this.#compilerOptions = freezeCompilerOptions(input.project.getCompilerOptions());

    // The Program is created eagerly. Creating it is the expensive part of
    // loading a repository, and deferring it would move that cost to whichever
    // consumer happened to ask a question first.
    this.#typeChecker = input.project.getProgram().getTypeChecker();
  }

  /**
   * The compiler options in force, as a frozen copy.
   *
   * These come from the repository's tsconfig.json verbatim when it has one, and
   * from `DEFAULT_COMPILER_OPTIONS` when it does not.
   */
  get compilerOptions(): Readonly<CompilerOptions> {
    return this.#assertAlive(this.#compilerOptions);
  }

  /** The type checker for this program. */
  get typeChecker(): TypeChecker {
    return this.#assertAlive(this.#typeChecker);
  }

  /**
   * The source files under analysis, in the order the inventory listed them.
   *
   * Declaration files reached through module resolution — anything in
   * `node_modules` — are part of the program and therefore resolvable by the type
   * checker, but are deliberately absent here. This list is what to analyse; the
   * checker's reach is wider.
   */
  get sourceFiles(): readonly SourceFile[] {
    return this.#assertAlive(this.#sourceFiles);
  }

  /**
   * Looks a source file up by its repository-relative path.
   *
   * Provided because every consumer needs this mapping and would otherwise build
   * the same index itself. It is a lookup, not resolution: nothing is interpreted.
   */
  findSourceFile(repoRelativePath: string): SourceFile | undefined {
    return this.#assertAlive(this.#sourceFilesByPath).get(repoRelativePath);
  }

  get isDisposed(): boolean {
    return this.#project === null;
  }

  /**
   * Releases the compiler's memory by dropping every reference this context holds.
   *
   * ts-morph exposes no teardown of its own, so releasing references is the whole
   * mechanism. Idempotent.
   */
  dispose(): void {
    this.#project = null;
    this.#typeChecker = null;
    this.#sourceFiles = null;
    this.#sourceFilesByPath = null;
    this.#compilerOptions = null;
  }

  #assertAlive<T>(value: T | null): T {
    if (value === null) {
      throw new ProjectContextDisposedError(this.rootPath);
    }

    return value;
  }
}
