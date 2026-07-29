/**
 * The Repository Scanner's output vocabulary.
 *
 * These types are local to the scanner rather than shared, because the contract
 * does not enumerate languages, frameworks or package managers as domain
 * vocabulary. Promoting them to `@traceiq/types` would be an architectural
 * decision, not an implementation one.
 *
 * Every path in an inventory is repository-relative and POSIX-separated, except
 * `rootPath`, which is absolute. Repository-relative paths are the form node
 * identifiers are built from.
 */

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;

export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/** `'unknown'` when no recognised lockfile is present at the repository root. */
export type DetectedPackageManager = PackageManagerName | 'unknown';

/** Version 1 supports TypeScript only. */
export type DetectedLanguage = 'typescript' | 'unknown';

/** Version 1 supports Express only. */
export type DetectedFramework = 'express' | 'unknown';

export interface Lockfile {
  /** Repository-relative path. */
  readonly path: string;
  readonly packageManager: PackageManagerName;
}

/**
 * Where an entry point came from. A `'manifest'` entry was declared in
 * package.json; a `'convention'` entry is a guess based on a conventional file
 * name, and callers should treat it with less trust.
 */
export type EntryPointOrigin = 'manifest' | 'convention';

export interface EntryPoint {
  /** Repository-relative path to a discovered source file. */
  readonly path: string;
  readonly origin: EntryPointOrigin;
  /**
   * The package.json field the entry was declared in — `'main'`, `'bin.cli'`,
   * `'exports.".".import'` — or `null` for conventional entries.
   */
  readonly field: string | null;
}

export interface RepositoryInventory {
  /** package.json `name` when present, otherwise the root directory name. */
  readonly name: string;
  /** Absolute, resolved path to the repository root. */
  readonly rootPath: string;
  readonly language: DetectedLanguage;
  readonly framework: DetectedFramework;
  readonly packageManager: DetectedPackageManager;
  /** Discovered TypeScript sources, repository-relative, sorted. */
  readonly sourceFiles: readonly string[];
  /** Discovered directories excluding ignored ones, repository-relative, sorted. */
  readonly directories: readonly string[];
  /** Repository-relative path to the root tsconfig.json, or `null`. */
  readonly tsconfigPath: string | null;
  /** Repository-relative path to the root package.json, or `null`. */
  readonly packageJsonPath: string | null;
  readonly lockfile: Lockfile | null;
  readonly entryPoints: readonly EntryPoint[];
  /** Ignored directories that actually exist, repository-relative, sorted. */
  readonly ignoredPaths: readonly string[];
}
