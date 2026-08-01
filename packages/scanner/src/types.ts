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

import type { Ecosystem, FileRole, LanguageName } from './languages.js';

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

/**
 * Every file the scan found, with what it is written in and what it is for.
 *
 * Reported for *all* files, not only analysable ones. A repository's shape is carried by
 * its Markdown, its Dockerfiles and its manifests as much as by its source, and a scanner
 * that discarded them could not describe a repository it cannot parse.
 */
export interface RepositoryFile {
  /** Repository-relative, POSIX-separated. */
  readonly path: string;
  /** `null` when no language is recognised — a binary, a licence, a lockfile. */
  readonly language: LanguageName | null;
  readonly role: FileRole;
  readonly bytes: number;
}

/** How many files one language accounts for. */
export interface LanguageCount {
  readonly language: LanguageName;
  readonly files: number;
}

/** A dependency or project manifest, and the dependency names it declares. */
export interface ManifestFile {
  /** Repository-relative path. */
  readonly path: string;
  readonly ecosystem: Ecosystem;
  /**
   * The name this manifest gives its own package, or `null`.
   *
   * **A framework's own repository never declares itself as a dependency.** NestJS's
   * `packages/core/package.json` is *named* `@nestjs/core`; it does not depend on it. Without this,
   * pointing TraceIQ at nestjs/nest, fastify/fastify or honojs/hono detected every framework those
   * repositories *use* and not the one they *are* — which is the single thing a reader opening a
   * framework repository wants to know.
   */
  readonly declaredName: string | null;
  /**
   * Names this manifest declares, sorted.
   *
   * Declaration, never resolution: no version is interpreted and no lockfile consulted.
   * Empty when the manifest declares none, or could not be read.
   */
  readonly declaredDependencies: readonly string[];
}

/**
 * One technology a repository is built from, and where it lives.
 *
 * A polyglot repository has several. Anchored on a dependency manifest, because that is
 * the one signal available without parsing that marks where a project begins.
 */
export interface TechnologyRegion {
  /** Repository-relative directory; `''` for the repository root. */
  readonly path: string;
  /** Manifests anchoring this region, repository-relative, sorted. */
  readonly manifests: readonly string[];
  readonly ecosystems: readonly Ecosystem[];
  /** Languages present here, by file count descending. */
  readonly languages: readonly LanguageCount[];
  /** The dominant *source* language, or `null` for a docs or config region. */
  readonly primaryLanguage: LanguageName | null;
  readonly fileCount: number;
  readonly sourceFileCount: number;
}

/**
 * A package belonging to a workspace, and where its sources are.
 *
 * Reported so that a sibling's `@scope/thing` import can be pointed at source instead
 * of at the published types under `dist`, which the scan ignores. Every path is
 * repository-relative.
 */
export interface WorkspacePackage {
  /** package.json `name`. Never empty; a nameless package is not reported. */
  readonly name: string;
  /** The package's own directory, e.g. `packages/ir`. */
  readonly directory: string;
  /**
   * The directory its analysed sources live in, e.g. `packages/ir/src`.
   *
   * Chosen because the scan found source files under it, not because a manifest or a
   * tsconfig named it. Equal to `directory` for a package keeping sources at its root.
   */
  readonly sourceDirectory: string;
  /** Its `index` source file, when one exists, e.g. `packages/ir/src/index.ts`. */
  readonly entryFile: string | null;
  /** Its own tsconfig.json, when it has one. */
  readonly tsconfigPath: string | null;
}

export interface RepositoryInventory {
  /** package.json `name` when present, otherwise the root directory name. */
  readonly name: string;
  /** Absolute, resolved path to the repository root. */
  readonly rootPath: string;
  /**
   * Whether the repository holds TypeScript the compiler can be pointed at.
   *
   * Retained for the TypeScript enrichment stage, which needs a yes or no. It is **not**
   * the repository's language: `languages` and `regions` answer that, and a repository
   * reported `'unknown'` here is still fully scannable.
   */
  readonly language: DetectedLanguage;
  readonly framework: DetectedFramework;
  readonly packageManager: DetectedPackageManager;
  /**
   * TypeScript sources the Project Host will load, repository-relative, sorted.
   *
   * A subset of `files`, and the only language-specific file list in the inventory. It
   * exists because the TypeScript analyser needs exactly this set; every other consumer
   * should read `files`.
   */
  readonly sourceFiles: readonly string[];
  /** Every file discovered, classified, repository-relative, sorted by path. */
  readonly files: readonly RepositoryFile[];
  /** Language totals across the repository, by file count descending. */
  readonly languages: readonly LanguageCount[];
  /** Every dependency or project manifest found, sorted by path. */
  readonly manifests: readonly ManifestFile[];
  /**
   * The technologies this repository is built from, sorted by path.
   *
   * Never empty for a repository containing files: a repository with no manifest is one
   * region rooted at `''`.
   */
  readonly regions: readonly TechnologyRegion[];
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
  /**
   * Packages making up the workspace, sorted by name. Empty for a single-package
   * repository, which is the common case and not an error.
   */
  readonly workspacePackages: readonly WorkspacePackage[];
}
