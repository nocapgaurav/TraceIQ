import type { WorkspacePackage } from '@traceiq/scanner';
import { describe, expect, it } from 'vitest';

import {
  mergePathMappings,
  rebasePathMappings,
  workspacePathMappings,
} from './workspace-paths.js';

const ROOT = '/repo';

const workspacePackage = (overrides: Partial<WorkspacePackage>): WorkspacePackage => ({
  name: '@scope/thing',
  directory: 'packages/thing',
  sourceDirectory: 'packages/thing/src',
  entryFile: 'packages/thing/src/index.ts',
  tsconfigPath: null,
  ...overrides,
});

describe('workspace mappings', () => {
  it('maps the bare specifier to the entry file and the subpath wildcard to the source directory', () => {
    const mappings = workspacePathMappings({
      rootPath: ROOT,
      workspacePackages: [workspacePackage({})],
    });

    expect(mappings).toEqual({
      '@scope/thing': ['/repo/packages/thing/src/index.ts'],
      '@scope/thing/*': ['/repo/packages/thing/src/*'],
    });
  });

  it('maps only the wildcard for a package with no entry file', () => {
    // An application has sources worth reaching but no index to name, and inventing one
    // would map its bare specifier onto nothing.
    const mappings = workspacePathMappings({
      rootPath: ROOT,
      workspacePackages: [workspacePackage({ name: 'web', entryFile: null })],
    });

    expect(mappings).toEqual({ 'web/*': ['/repo/packages/thing/src/*'] });
  });

  it('produces absolute substitutions, so no baseUrl is needed', () => {
    const mappings = workspacePathMappings({
      rootPath: ROOT,
      workspacePackages: [workspacePackage({})],
    });

    for (const substitutions of Object.values(mappings)) {
      for (const substitution of substitutions) {
        expect(substitution.startsWith('/')).toBe(true);
      }
    }
  });

  it('maps a package keeping sources at its root', () => {
    const mappings = workspacePathMappings({
      rootPath: ROOT,
      workspacePackages: [
        workspacePackage({
          sourceDirectory: 'packages/thing',
          entryFile: 'packages/thing/index.ts',
        }),
      ],
    });

    expect(mappings['@scope/thing/*']).toEqual(['/repo/packages/thing/*']);
  });

  it('keeps both when two packages share a name', () => {
    const mappings = workspacePathMappings({
      rootPath: ROOT,
      workspacePackages: [
        workspacePackage({ entryFile: 'a/src/index.ts', sourceDirectory: 'a/src' }),
        workspacePackage({ entryFile: 'b/src/index.ts', sourceDirectory: 'b/src' }),
      ],
    });

    expect(mappings['@scope/thing']).toEqual(['/repo/a/src/index.ts', '/repo/b/src/index.ts']);
  });

  it('yields nothing for a repository with no workspace packages', () => {
    expect(workspacePathMappings({ rootPath: ROOT, workspacePackages: [] })).toEqual({});
  });
});

describe('merging', () => {
  it('keeps every substitution for a repeated pattern, in argument order', () => {
    // Two Next.js applications both declaring `@/*` is ordinary. TypeScript tries each
    // substitution and takes the first that exists, so both resolve correctly.
    const merged = mergePathMappings(
      { '@/*': ['/repo/apps/web/src/*'] },
      { '@/*': ['/repo/apps/admin/src/*'] },
    );

    expect(merged['@/*']).toEqual(['/repo/apps/web/src/*', '/repo/apps/admin/src/*']);
  });

  it('does not repeat an identical substitution', () => {
    const merged = mergePathMappings({ '@/*': ['/repo/src/*'] }, { '@/*': ['/repo/src/*'] });

    expect(merged['@/*']).toEqual(['/repo/src/*']);
  });

  it('unions distinct patterns', () => {
    expect(mergePathMappings({ a: ['/x'] }, { b: ['/y'] })).toEqual({ a: ['/x'], b: ['/y'] });
  });

  it('returns an empty table for no arguments', () => {
    expect(mergePathMappings()).toEqual({});
  });
});

describe('rebasing', () => {
  it('resolves a relative substitution against the directory it came from', () => {
    const rebased = rebasePathMappings({
      paths: { '@/*': ['./src/*'] },
      baseDirectory: '/repo/apps/web',
    });

    expect(rebased['@/*']).toEqual(['/repo/apps/web/src/*']);
  });

  it('leaves an absolute substitution alone', () => {
    const rebased = rebasePathMappings({
      paths: { '@/*': ['/elsewhere/src/*'] },
      baseDirectory: '/repo/apps/web',
    });

    expect(rebased['@/*']).toEqual(['/elsewhere/src/*']);
  });

  it('rebases a substitution reaching outside its own directory', () => {
    const rebased = rebasePathMappings({
      paths: { '~shared/*': ['../../packages/shared/src/*'] },
      baseDirectory: '/repo/apps/web',
    });

    expect(rebased['~shared/*']).toEqual(['/repo/packages/shared/src/*']);
  });

  it('rebases every substitution of a multi-target pattern', () => {
    const rebased = rebasePathMappings({
      paths: { '@/*': ['./src/*', './generated/*'] },
      baseDirectory: '/repo/app',
    });

    expect(rebased['@/*']).toEqual(['/repo/app/src/*', '/repo/app/generated/*']);
  });
});
