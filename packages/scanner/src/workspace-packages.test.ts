import { afterEach, describe, expect, it } from 'vitest';

import { RepositoryFixture, type FixtureFiles } from './repository-fixture.test-helper.js';
import { RepositoryScanner } from './repository-scanner.js';

let fixture: RepositoryFixture | null = null;

afterEach(async () => {
  await fixture?.remove();
  fixture = null;
});

/**
 * Scans a real repository. Workspace discovery reads manifests off disk and matches
 * against a real directory walk, so a fixture proves more here than a hand-built input.
 */
async function scan(files: FixtureFiles) {
  fixture = await RepositoryFixture.create(files);

  return new RepositoryScanner().scan(fixture.rootPath);
}

const PNPM_WORKSPACE = "packages:\n  - 'packages/*'\n";

describe('discovery', () => {
  it('finds the packages a pnpm workspace declares', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'package.json': '{"name":"root"}',
      'packages/alpha/package.json': '{"name":"@scope/alpha"}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
      'packages/beta/package.json': '{"name":"@scope/beta"}',
      'packages/beta/src/index.ts': 'export const b = 2;',
    });

    expect(inventory.workspacePackages).toEqual([
      {
        name: '@scope/alpha',
        directory: 'packages/alpha',
        sourceDirectory: 'packages/alpha/src',
        entryFile: 'packages/alpha/src/index.ts',
        tsconfigPath: null,
      },
      {
        name: '@scope/beta',
        directory: 'packages/beta',
        sourceDirectory: 'packages/beta/src',
        entryFile: 'packages/beta/src/index.ts',
        tsconfigPath: null,
      },
    ]);
  });

  it('finds the packages a package.json workspaces field declares', async () => {
    const inventory = await scan({
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages.map((entry) => entry.name)).toEqual(['alpha']);
  });

  it('prefers the pnpm workspace file when both declare packages', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'package.json': '{"name":"root","workspaces":["apps/*"]}',
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/src/index.ts': 'export const w = 1;',
    });

    expect(inventory.workspacePackages.map((entry) => entry.name)).toEqual(['alpha']);
  });

  it('reports nothing for a repository that is not a workspace', async () => {
    const inventory = await scan({
      'package.json': '{"name":"single"}',
      'src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages).toEqual([]);
  });

  it('records a package tsconfig when it has one', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages[0]?.tsconfigPath).toBe('packages/alpha/tsconfig.json');
  });

  it('sorts by name, so two scans of one repository agree', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/zulu/package.json': '{"name":"zulu"}',
      'packages/zulu/src/index.ts': 'export const z = 1;',
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages.map((entry) => entry.name)).toEqual(['alpha', 'zulu']);
  });
});

describe('source directory', () => {
  it('prefers src when sources are there', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages[0]?.sourceDirectory).toBe('packages/alpha/src');
  });

  it('falls back to the package root for a package keeping sources there', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages[0]).toMatchObject({
      sourceDirectory: 'packages/alpha',
      entryFile: 'packages/alpha/index.ts',
    });
  });

  it('finds a .tsx index', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/src/index.tsx': 'export const a = 1;',
    });

    expect(inventory.workspacePackages[0]?.entryFile).toBe('packages/alpha/src/index.tsx');
  });

  it('reports no entry file for a package without an index', async () => {
    // A Next.js application is imported by nobody but still has sources worth mapping.
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/alpha/package.json': '{"name":"alpha"}',
      'packages/alpha/src/thing.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages[0]).toMatchObject({
      sourceDirectory: 'packages/alpha/src',
      entryFile: null,
    });
  });
});

describe('packages that are not reported', () => {
  it('skips a package with no analysed sources', async () => {
    // Mapping its specifier would resolve imports into a directory producing no nodes,
    // which looks like success and is worse than leaving them external.
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/empty/package.json': '{"name":"empty"}',
      'packages/empty/README.md': '# nothing here',
    });

    expect(inventory.workspacePackages).toEqual([]);
  });

  it('skips a package whose sources are all in an ignored directory', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/built/package.json': '{"name":"built"}',
      'packages/built/dist/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages).toEqual([]);
  });

  it('skips a nameless package', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/alpha/package.json': '{"private":true}',
      'packages/alpha/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages).toEqual([]);
  });

  it('skips a package with a malformed manifest without failing the scan', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/broken/package.json': '{ not json',
      'packages/broken/src/index.ts': 'export const a = 1;',
      'packages/fine/package.json': '{"name":"fine"}',
      'packages/fine/src/index.ts': 'export const b = 1;',
    });

    expect(inventory.workspacePackages.map((entry) => entry.name)).toEqual(['fine']);
  });

  it('skips a directory matched by a glob that holds no manifest', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'packages/notapackage/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages).toEqual([]);
  });

  it('never reaches into an ignored directory', async () => {
    const inventory = await scan({
      'pnpm-workspace.yaml': "packages:\n  - '**'\n",
      'node_modules/dep/package.json': '{"name":"dep"}',
      'node_modules/dep/src/index.ts': 'export const a = 1;',
    });

    expect(inventory.workspacePackages).toEqual([]);
  });
});
