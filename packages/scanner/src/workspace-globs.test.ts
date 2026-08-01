import { describe, expect, it } from 'vitest';

import {
  matchWorkspaceDirectories,
  parsePnpmWorkspaceGlobs,
  readManifestWorkspaceGlobs,
} from './workspace-globs.js';

describe('pnpm-workspace.yaml', () => {
  it('reads the documented shape', () => {
    const globs = parsePnpmWorkspaceGlobs(
      ['packages:', "  - 'apps/*'", "  - 'packages/*'", ''].join('\n'),
    );

    expect(globs.include).toEqual(['apps/*', 'packages/*']);
  });

  it('accepts double quotes and no quotes', () => {
    const globs = parsePnpmWorkspaceGlobs(
      ['packages:', '  - "apps/*"', '  - packages/*'].join('\n'),
    );

    expect(globs.include).toEqual(['apps/*', 'packages/*']);
  });

  it('separates negations, which pnpm permits', () => {
    const globs = parsePnpmWorkspaceGlobs(
      ['packages:', "  - 'packages/*'", "  - '!packages/legacy'"].join('\n'),
    );

    expect(globs).toEqual({ include: ['packages/*'], exclude: ['packages/legacy'] });
  });

  it('strips comments, including a trailing one', () => {
    const globs = parsePnpmWorkspaceGlobs(
      ['# the workspace', 'packages:', "  - 'apps/*' # the applications"].join('\n'),
    );

    expect(globs.include).toEqual(['apps/*']);
  });

  it('stops at the next top-level key', () => {
    const globs = parsePnpmWorkspaceGlobs(
      ['packages:', "  - 'apps/*'", 'allowBuilds:', '  esbuild: true'].join('\n'),
    );

    expect(globs.include).toEqual(['apps/*']);
  });

  it('ignores a list that is not under packages', () => {
    const globs = parsePnpmWorkspaceGlobs(
      ['catalog:', '  - not-a-package', 'packages:', "  - 'apps/*'"].join('\n'),
    );

    expect(globs.include).toEqual(['apps/*']);
  });

  it('yields nothing for a shape outside the supported subset, rather than guessing', () => {
    // A flow sequence. Returning nothing degrades to single-package behaviour, which is
    // never a wrong answer stated confidently.
    expect(parsePnpmWorkspaceGlobs("packages: ['apps/*']").include).toEqual([]);
  });

  it('yields nothing for an empty or unrelated file', () => {
    expect(parsePnpmWorkspaceGlobs('').include).toEqual([]);
    expect(parsePnpmWorkspaceGlobs('onlyBuiltDependencies:\n  - esbuild').include).toEqual([]);
  });
});

describe('package.json workspaces', () => {
  it('reads the array shape', () => {
    expect(readManifestWorkspaceGlobs({ workspaces: ['packages/*'] }).include).toEqual([
      'packages/*',
    ]);
  });

  it('reads the object shape yarn uses', () => {
    expect(
      readManifestWorkspaceGlobs({ workspaces: { packages: ['packages/*'], nohoist: ['x'] } })
        .include,
    ).toEqual(['packages/*']);
  });

  it('separates negations', () => {
    expect(readManifestWorkspaceGlobs({ workspaces: ['packages/*', '!packages/old'] })).toEqual({
      include: ['packages/*'],
      exclude: ['packages/old'],
    });
  });

  it.each([{}, { workspaces: 'packages/*' }, { workspaces: null }, null, 'not an object'])(
    'yields nothing for %s',
    (manifest) => {
      expect(readManifestWorkspaceGlobs(manifest).include).toEqual([]);
    },
  );
});

describe('matching directories', () => {
  const directories = [
    'apps',
    'apps/api',
    'apps/api/src',
    'apps/web',
    'packages',
    'packages/ir',
    'packages/ir/src',
    'packages/scoped',
    'packages/scoped/inner',
    'tools',
  ];

  const match = (include: readonly string[], exclude: readonly string[] = []) =>
    matchWorkspaceDirectories({ include, exclude }, directories);

  it('matches one level with a single star', () => {
    expect(match(['packages/*'])).toEqual(['packages/ir', 'packages/scoped']);
  });

  it('does not let a single star cross a separator', () => {
    expect(match(['packages/*'])).not.toContain('packages/ir/src');
  });

  it('crosses separators with a double star', () => {
    expect(match(['packages/**'])).toEqual([
      'packages/ir',
      'packages/ir/src',
      'packages/scoped',
      'packages/scoped/inner',
    ]);
  });

  it('matches several globs at once', () => {
    expect(match(['apps/*', 'packages/*'])).toEqual([
      'apps/api',
      'apps/web',
      'packages/ir',
      'packages/scoped',
    ]);
  });

  it('applies negations', () => {
    expect(match(['packages/*'], ['packages/scoped'])).toEqual(['packages/ir']);
  });

  it('matches a literal path with no glob syntax', () => {
    expect(match(['tools'])).toEqual(['tools']);
  });

  it('tolerates a leading ./ and a trailing slash', () => {
    expect(match(['./packages/*/'])).toEqual(['packages/ir', 'packages/scoped']);
  });

  it('returns nothing when no glob is declared', () => {
    expect(match([])).toEqual([]);
  });

  it('returns nothing for a glob that matches no directory', () => {
    expect(match(['nonexistent/*'])).toEqual([]);
  });

  it('returns results sorted, so a repository yields one order', () => {
    const matched = match(['packages/*', 'apps/*']);

    expect([...matched]).toEqual([...matched].sort());
  });
});
