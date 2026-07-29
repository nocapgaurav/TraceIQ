import { afterEach, describe, expect, it } from 'vitest';

import { MalformedManifestError, readPackageManifest } from './manifest.js';
import { RepositoryFixture } from './repository-fixture.test-helper.js';

const fixtures: RepositoryFixture[] = [];

async function manifestAt(contents: string): Promise<string> {
  const fixture = await RepositoryFixture.create({ 'package.json': contents });

  fixtures.push(fixture);

  return fixture.path('package.json');
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe('readPackageManifest', () => {
  it('returns null when the manifest does not exist', async () => {
    const fixture = await RepositoryFixture.create();

    fixtures.push(fixture);

    await expect(readPackageManifest(fixture.path('package.json'))).resolves.toBeNull();
  });

  it('reads the package name', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"name":"my-api"}'));

    expect(manifest?.name).toBe('my-api');
  });

  it('trims the package name', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"name":"  my-api  "}'));

    expect(manifest?.name).toBe('my-api');
  });

  it.each([
    ['a missing name', '{}'],
    ['a blank name', '{"name":"   "}'],
    ['a non-string name', '{"name":42}'],
  ])('reports null for %s', async (_description, contents) => {
    const manifest = await readPackageManifest(await manifestAt(contents));

    expect(manifest?.name).toBeNull();
  });

  it('collects dependency names from all four sections, sorted and deduplicated', async () => {
    const manifest = await readPackageManifest(
      await manifestAt(
        JSON.stringify({
          dependencies: { express: '^4.0.0' },
          devDependencies: { vitest: '^4.0.0', express: '^4.0.0' },
          peerDependencies: { typescript: '^7.0.0' },
          optionalDependencies: { fsevents: '^2.0.0' },
        }),
      ),
    );

    expect(manifest?.dependencyNames).toEqual([
      'express',
      'fsevents',
      'typescript',
      'vitest',
    ]);
  });

  it('reports no dependencies when none are declared', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"name":"bare"}'));

    expect(manifest?.dependencyNames).toEqual([]);
  });

  it('ignores a dependency section that is not an object', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"dependencies":"express"}'));

    expect(manifest?.dependencyNames).toEqual([]);
  });

  it('collects main and module entry fields', async () => {
    const manifest = await readPackageManifest(
      await manifestAt('{"main":"dist/index.js","module":"dist/index.mjs"}'),
    );

    expect(manifest?.entryFields).toEqual([
      { field: 'main', target: 'dist/index.js' },
      { field: 'module', target: 'dist/index.mjs' },
    ]);
  });

  it('collects a string bin', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"bin":"src/cli.ts"}'));

    expect(manifest?.entryFields).toEqual([{ field: 'bin', target: 'src/cli.ts' }]);
  });

  it('collects every command from an object bin', async () => {
    const manifest = await readPackageManifest(
      await manifestAt('{"bin":{"traceiq":"src/cli.ts","traceiq-dev":"src/dev.ts"}}'),
    );

    expect(manifest?.entryFields).toEqual([
      { field: 'bin.traceiq', target: 'src/cli.ts' },
      { field: 'bin["traceiq-dev"]', target: 'src/dev.ts' },
    ]);
  });

  it('collects a string exports target', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"exports":"src/index.ts"}'));

    expect(manifest?.entryFields).toEqual([{ field: 'exports', target: 'src/index.ts' }]);
  });

  it('walks nested exports condition maps', async () => {
    const manifest = await readPackageManifest(
      await manifestAt(
        JSON.stringify({
          exports: {
            '.': { import: 'src/index.ts', require: 'dist/index.cjs' },
            './scanner': { import: 'src/scanner.ts' },
          },
        }),
      ),
    );

    expect(manifest?.entryFields).toEqual([
      { field: 'exports["."].import', target: 'src/index.ts' },
      { field: 'exports["."].require', target: 'dist/index.cjs' },
      { field: 'exports["./scanner"].import', target: 'src/scanner.ts' },
    ]);
  });

  it('walks exports fallback arrays', async () => {
    const manifest = await readPackageManifest(
      await manifestAt('{"exports":{"import":["src/index.ts","dist/index.js"]}}'),
    );

    expect(manifest?.entryFields).toEqual([
      { field: 'exports.import[0]', target: 'src/index.ts' },
      { field: 'exports.import[1]', target: 'dist/index.js' },
    ]);
  });

  it('ignores non-string leaves in exports', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"exports":{"import":null}}'));

    expect(manifest?.entryFields).toEqual([]);
  });

  it('reports no entry fields when none are declared', async () => {
    const manifest = await readPackageManifest(await manifestAt('{"name":"bare"}'));

    expect(manifest?.entryFields).toEqual([]);
  });

  it('throws on invalid JSON rather than reporting an empty manifest', async () => {
    await expect(readPackageManifest(await manifestAt('{ not json'))).rejects.toThrow(
      MalformedManifestError,
    );
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"express"'],
    ['null', 'null'],
  ])('throws when the top level value is %s', async (_description, contents) => {
    await expect(readPackageManifest(await manifestAt(contents))).rejects.toThrow(
      MalformedManifestError,
    );
  });

  it('names the offending file in the error message', async () => {
    const manifestPath = await manifestAt('{ not json');

    await expect(readPackageManifest(manifestPath)).rejects.toThrow(manifestPath);
  });

  it('throws when the path is a directory rather than a file', async () => {
    const fixture = await RepositoryFixture.create();

    fixtures.push(fixture);
    await fixture.createDirectory('package.json');

    await expect(readPackageManifest(fixture.path('package.json'))).rejects.toThrow(
      MalformedManifestError,
    );
  });
});
