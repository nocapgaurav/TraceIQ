import type { NodeId } from '@traceiq/types';

/**
 * Maps Go import paths onto the repository's directories.
 *
 * **In Go a package is a directory, which makes this the most tractable of the four languages.** An
 * import path is the module path joined to the directory's path relative to the module root, so
 * `module github.com/acme/svc` plus `internal/store` resolves `github.com/acme/svc/internal/store`
 * to `internal/store/`. That is a rule with no ambiguity, so a binding through it is `RESOLVED`.
 *
 * A workspace — `go.work` naming several module directories — is handled by indexing each module with
 * its own path, so a repository holding two modules resolves each one's imports correctly rather than
 * assuming a single root.
 */
export interface GoPackageIndex {
  /** The directory an import path names, or `null` when it lies outside this repository. */
  directoryFor(importPath: string): string | null;
  /** Every declaration a directory's package exports, by name. */
  exported(directory: string, name: string): readonly NodeId[];
  /** The declared package name of a directory, for evidence a reader can check. */
  packageNameOf(directory: string): string | null;
  /** Every module root discovered, longest path first. */
  readonly modules: readonly ModuleRoot[];
}

export interface ModuleRoot {
  /** The `module` line's path: `github.com/acme/svc`. */
  readonly modulePath: string;
  /** The directory holding `go.mod`, repository-relative. `''` for the repository root. */
  readonly directory: string;
}

export interface PackageMember {
  readonly declarationId: NodeId;
  readonly name: string;
  /** The directory the declaring file sits in. */
  readonly directory: string;
  readonly isExported: boolean;
}

export function buildPackageIndex(input: {
  readonly modules: readonly ModuleRoot[];
  readonly members: readonly PackageMember[];
  /** Declared package name by directory, from each file's `package` clause. */
  readonly packageNames: ReadonlyMap<string, string>;
}): GoPackageIndex {
  // Longest module path first, so a nested module wins over the one containing it — which is what the
  // Go toolchain does, and the opposite would attribute a nested module's packages to its parent.
  const modules = [...input.modules].sort(
    (left, right) => right.modulePath.length - left.modulePath.length,
  );

  const byDirectory = new Map<string, Map<string, NodeId[]>>();

  for (const member of input.members) {
    const bucket = byDirectory.get(member.directory) ?? new Map<string, NodeId[]>();
    const names = bucket.get(member.name) ?? [];

    names.push(member.declarationId);
    bucket.set(member.name, names);
    byDirectory.set(member.directory, bucket);
  }

  const directoryFor = (importPath: string): string | null => {
    for (const module of modules) {
      if (importPath === module.modulePath) {
        return module.directory;
      }

      if (!importPath.startsWith(`${module.modulePath}/`)) {
        continue;
      }

      const relative = importPath.slice(module.modulePath.length + 1);
      const directory = module.directory === '' ? relative : `${module.directory}/${relative}`;

      // Only a directory the scan actually found. An import path that looks like this module's but
      // names nothing present is a dead end, not a resolution.
      return byDirectory.has(directory) || input.packageNames.has(directory) ? directory : null;
    }

    return null;
  };

  return {
    directoryFor,
    exported: (directory, name) => byDirectory.get(directory)?.get(name) ?? [],
    packageNameOf: (directory) => input.packageNames.get(directory) ?? null,
    modules,
  };
}

/**
 * Reads the `module` path out of a `go.mod`.
 *
 * A single line, deliberately: `go.mod` is a small declarative format and the module path is the only
 * thing resolution needs from it. The `require` block is read by the scanner as declared dependencies,
 * which is a different fact and already handled.
 */
export function modulePathOf(goModContents: string): string | null {
  for (const line of goModContents.split('\n')) {
    const match = /^\s*module\s+(\S+)/.exec(line);

    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  return null;
}

/** The directory part of a repository-relative path, or `''` for a file at the root. */
export function directoryOf(repoRelativePath: string): string {
  const index = repoRelativePath.lastIndexOf('/');

  return index === -1 ? '' : repoRelativePath.slice(0, index);
}
