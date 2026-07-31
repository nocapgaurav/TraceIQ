import { describe, expect, it } from 'vitest';

import { directoriesOf, groupPackages, initialOpenGroups, ROOT_GROUP } from '@/lib/package-groups';
import type { PackageSummary } from '@/types/api';

/**
 * The Explorer's navigation grouping.
 *
 * The important property is that grouping introduces nothing: every group name is a directory that
 * appears in a package name, and every package lands in exactly one group.
 */
function pkg(name: string, overrides: Partial<PackageSummary> = {}): PackageSummary {
  return { name, files: 1, declarations: 10, dependencies: 0, dependents: 0, ...overrides };
}

describe('groupPackages', () => {
  it('groups by the first path segment', () => {
    const groups = groupPackages([pkg('apps/api'), pkg('apps/web'), pkg('packages/core')]);

    expect(groups.map((group) => group.name)).toEqual(['apps', 'packages']);
    expect(groups[0]?.packages.map((entry) => entry.name)).toEqual(['apps/api', 'apps/web']);
  });

  it('invents no group name — every label is a directory that exists in the input', () => {
    const entries = [pkg('apps/api'), pkg('packages/core'), pkg('vitest.config.ts')];
    const directories = new Set([...entries.map((entry) => entry.name.split('/')[0]), ROOT_GROUP]);

    for (const group of groupPackages(entries)) {
      expect(directories).toContain(group.name);
    }
  });

  it('places every package in exactly one group', () => {
    const entries = [pkg('apps/api'), pkg('apps/web'), pkg('packages/core'), pkg('root.ts')];
    const placed = groupPackages(entries).flatMap((group) => group.packages.map((entry) => entry.name));

    expect(placed.sort()).toEqual(entries.map((entry) => entry.name).sort());
  });

  it('groups a package with no directory under the repository root', () => {
    // Real payloads contain these: a root-level file such as `vitest.config.ts` is its own package.
    expect(groupPackages([pkg('vitest.config.ts')])[0]?.name).toBe(ROOT_GROUP);
  });

  it('orders groups by declarations then name, and packages alphabetically', () => {
    const groups = groupPackages([
      pkg('z/one', { declarations: 5 }),
      pkg('a/two', { declarations: 5 }),
      pkg('a/one', { declarations: 5 }),
      pkg('m/one', { declarations: 90 }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['m', 'a', 'z']);
    expect(groups[1]?.packages.map((entry) => entry.name)).toEqual(['a/one', 'a/two']);
  });

  it('totals files and declarations per group', () => {
    const groups = groupPackages([
      pkg('apps/api', { files: 2, declarations: 20 }),
      pkg('apps/web', { files: 3, declarations: 30 }),
    ]);

    expect(groups[0]).toMatchObject({ name: 'apps', files: 5, declarations: 50 });
  });

  it('returns nothing for no packages', () => {
    expect(groupPackages([])).toEqual([]);
  });
});

describe('initialOpenGroups', () => {
  const groups = groupPackages([pkg('apps/api', { declarations: 5 }), pkg('packages/core', { declarations: 90 })]);

  it('opens the group holding the selection, so a shared link reveals where it points', () => {
    expect(initialOpenGroups(groups, 'apps/api')).toEqual(new Set(['apps']));
  });

  it('opens only the largest group when nothing is selected', () => {
    expect(initialOpenGroups(groups, null)).toEqual(new Set(['packages']));
  });

  it('falls back to the largest group when the selection is not among the packages', () => {
    expect(initialOpenGroups(groups, 'gone/missing')).toEqual(new Set(['packages']));
  });

  it('opens nothing when there are no groups', () => {
    expect(initialOpenGroups([], null)).toEqual(new Set());
  });
});

describe('directoriesOf', () => {
  it('reads directories back from the file paths, relative to the package', () => {
    expect(
      directoriesOf('packages/core', [
        'packages/core/src/service.ts',
        'packages/core/src/util.ts',
        'packages/core/test/service.test.ts',
      ]),
    ).toEqual([
      { name: 'src', files: 2 },
      { name: 'test', files: 1 },
    ]);
  });

  it('groups a file sitting directly in the package under the package itself', () => {
    expect(directoriesOf('packages/core', ['packages/core/index.ts'])).toEqual([{ name: '.', files: 1 }]);
  });

  it('keeps a nested path whole rather than only its first segment', () => {
    expect(directoriesOf('apps/web', ['apps/web/src/components/ui/button.tsx'])).toEqual([
      { name: 'src/components/ui', files: 1 },
    ]);
  });

  it('returns nothing for a package with no files', () => {
    expect(directoriesOf('packages/core', [])).toEqual([]);
  });
});
