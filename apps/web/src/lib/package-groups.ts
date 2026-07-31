import type { PackageSummary } from '@/types/api';

/**
 * Packages, grouped for navigation.
 *
 * **The grouping is the repository's own directory hierarchy, nothing more.** Package names are already
 * derived from file paths — `apps/api`, `packages/query` — so their first segment is a real structural
 * fact, and grouping by it invents nothing.
 *
 * Semantic groupings such as "Core", "Infrastructure" or "Utilities" would be a *classification*, and the
 * graph records nothing that supports one: roles are per-declaration annotations, not package categories.
 * Producing those labels here would mean the interface deciding what a package is for, which is both an
 * invention and analysis in the wrong layer. So the labels are the directories that actually exist.
 */

export interface PackageGroup {
  /** The directory, e.g. `apps`. Never a category invented here. */
  readonly name: string;
  readonly packages: readonly PackageSummary[];
  readonly files: number;
  readonly declarations: number;
}

/** Where a package with no directory above it is grouped. */
export const ROOT_GROUP = 'repository root';

/**
 * Groups by first path segment, largest group first.
 *
 * Order is by declaration count then name, so the same repository always produces the same navigation —
 * a sidebar that reshuffles between visits is one you cannot learn.
 */
export function groupPackages(entries: readonly PackageSummary[]): readonly PackageGroup[] {
  const groups = new Map<string, PackageSummary[]>();

  for (const entry of entries) {
    const separator = entry.name.indexOf('/');
    const key = separator === -1 ? ROOT_GROUP : entry.name.slice(0, separator);

    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([name, packages]) => ({
      name,
      // Alphabetical within a group: this is a navigation list, and a reader scans it by name.
      packages: [...packages].sort((left, right) => left.name.localeCompare(right.name)),
      files: packages.reduce((total, entry) => total + entry.files, 0),
      declarations: packages.reduce((total, entry) => total + entry.declarations, 0),
    }))
    .sort((left, right) => right.declarations - left.declarations || left.name.localeCompare(right.name));
}

/**
 * Which groups start open.
 *
 * The group holding the current selection, so a shared link opens showing where it points. With nothing
 * selected only the largest opens — the sidebar's job on arrival is to answer "where should I go?", and
 * every package at once does not answer it.
 */
export function initialOpenGroups(
  groups: readonly PackageGroup[],
  selectedPackage: string | null,
): ReadonlySet<string> {
  if (selectedPackage !== null) {
    const holding = groups.find((group) => group.packages.some((entry) => entry.name === selectedPackage));

    if (holding !== undefined) {
      return new Set([holding.name]);
    }
  }

  const first = groups[0];

  return first === undefined ? new Set() : new Set([first.name]);
}

/**
 * The directories inside one package, from its file paths.
 *
 * A package's files are all the API reports; the folders between the package and each file are implied by
 * the paths themselves. Reading them back is formatting, not analysis — no path is invented, and a file
 * sitting directly in the package is grouped under the package itself rather than a fabricated folder.
 */
export function directoriesOf(packageName: string, filePaths: readonly string[]): readonly {
  readonly name: string;
  readonly files: number;
}[] {
  const counts = new Map<string, number>();

  for (const path of filePaths) {
    const relative = path.startsWith(`${packageName}/`) ? path.slice(packageName.length + 1) : path;
    const separator = relative.lastIndexOf('/');
    const directory = separator === -1 ? '.' : relative.slice(0, separator);

    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}
