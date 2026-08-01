import path from 'node:path';

import type { WorkspacePackage } from '@traceiq/scanner';

/** A TypeScript `paths` table: pattern to the substitutions tried, in order. */
export type PathMappings = Record<string, string[]>;

/**
 * Builds the path mappings that make a workspace's own packages resolvable to source.
 *
 * Without them, `import { IrBuilder } from '@traceiq/ir'` resolves through node_modules
 * to `packages/ir/dist/index.d.ts` — build output, which the scan ignores. The reference
 * lands outside the analysed file set, so it becomes a nameless external and every fact
 * that depended on it is lost. In a monorepo that silently erases the dependency graph
 * between packages, which is the structure a reader most wants to see.
 *
 * Two mappings per package:
 *
 * ```
 * '@traceiq/ir'   → packages/ir/src/index.ts     the bare specifier
 * '@traceiq/ir/*' → packages/ir/src/*            every subpath export
 * ```
 *
 * The wildcard is what lets `@traceiq/ai/testing` reach `packages/ai/src/testing.ts`
 * without reading a single `exports` map: TypeScript applies its own extension
 * resolution to the substituted path, so the mapping stays a directory redirect and
 * never has to model conditional exports.
 *
 * TypeScript prefers the longest matching pattern rather than declaration order, so the
 * exact mapping always wins over the wildcard for the bare specifier.
 *
 * Substitutions are absolute. A relative substitution is interpreted against `baseUrl`,
 * and setting `baseUrl` would additionally make every bare specifier resolvable against
 * the repository root — turning a stray `utils` import into a match on a top-level
 * `utils/` directory. Absolute paths buy the same redirect with no such side effect.
 *
 * Pure, and does no filesystem work: it maps what the scan already established.
 */
export function workspacePathMappings(input: {
  readonly rootPath: string;
  readonly workspacePackages: readonly WorkspacePackage[];
}): PathMappings {
  const mappings: PathMappings = {};

  for (const workspacePackage of input.workspacePackages) {
    // A package with no index file gets the wildcard only. An application such as a
    // Next.js app is imported by nobody but may still be imported *from*, and inventing
    // an entry file it does not have would map its bare specifier onto nothing.
    if (workspacePackage.entryFile !== null) {
      append(
        mappings,
        workspacePackage.name,
        path.join(input.rootPath, workspacePackage.entryFile),
      );
    }

    append(
      mappings,
      `${workspacePackage.name}/*`,
      path.join(input.rootPath, workspacePackage.sourceDirectory, '*'),
    );
  }

  return mappings;
}

/**
 * Merges path mappings, keeping every substitution for a repeated pattern.
 *
 * Two packages can legitimately declare the same alias — `@/*` is near-universal in
 * Next.js applications — and picking a winner would silently misresolve one of them.
 * TypeScript tries a pattern's substitutions in order and takes the first that exists on
 * disk, so concatenating lets both resolve correctly rather than making this decide.
 *
 * Earlier arguments take precedence, and a substitution already present is not repeated.
 */
export function mergePathMappings(...tables: readonly PathMappings[]): PathMappings {
  const merged: PathMappings = {};

  for (const table of tables) {
    for (const [pattern, substitutions] of Object.entries(table)) {
      for (const substitution of substitutions) {
        append(merged, pattern, substitution);
      }
    }
  }

  return merged;
}

/**
 * Rewrites a tsconfig's own `paths` so they mean the same thing from anywhere.
 *
 * A tsconfig's substitutions are relative to its `baseUrl`, which defaults to the
 * directory holding it. Once several packages' tables are merged into one program that
 * anchor is gone, so each substitution is resolved against its original directory and
 * recorded absolute.
 */
export function rebasePathMappings(input: {
  readonly paths: PathMappings;
  /** Absolute directory the substitutions are currently relative to. */
  readonly baseDirectory: string;
}): PathMappings {
  const rebased: PathMappings = {};

  for (const [pattern, substitutions] of Object.entries(input.paths)) {
    for (const substitution of substitutions) {
      append(
        rebased,
        pattern,
        path.isAbsolute(substitution)
          ? substitution
          : path.join(input.baseDirectory, substitution),
      );
    }
  }

  return rebased;
}

function append(mappings: PathMappings, pattern: string, substitution: string): void {
  const existing = mappings[pattern];

  if (existing === undefined) {
    mappings[pattern] = [substitution];
    return;
  }

  if (!existing.includes(substitution)) {
    existing.push(substitution);
  }
}
