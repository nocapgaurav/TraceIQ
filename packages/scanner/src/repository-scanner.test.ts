import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MalformedManifestError } from './manifest.js';
import { RepositoryFixture, type FixtureFiles } from './repository-fixture.test-helper.js';
import { RepositoryScanError, RepositoryScanner } from './repository-scanner.js';
import { IGNORED_DIRECTORY_NAMES } from './ignore.js';

const fixtures: RepositoryFixture[] = [];

async function repository(files: FixtureFiles = {}): Promise<RepositoryFixture> {
  const fixture = await RepositoryFixture.create(files);

  fixtures.push(fixture);

  return fixture;
}

const scanner = new RepositoryScanner();

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe('RepositoryScanner: repository identity', () => {
  it('takes the name from package.json', async () => {
    const fixture = await repository({ 'package.json': '{"name":"my-api"}' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({ name: 'my-api' });
  });

  it('falls back to the directory name when there is no package.json', async () => {
    const fixture = await repository({ 'src/index.ts': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.name).toBe(path.basename(fixture.rootPath));
  });

  it('falls back to the directory name when package.json declares none', async () => {
    const fixture = await repository({ 'package.json': '{"version":"1.0.0"}' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.name).toBe(path.basename(fixture.rootPath));
  });

  it('reports an absolute, resolved root path', async () => {
    const fixture = await repository();
    const inventory = await scanner.scan(path.join(fixture.rootPath, '.'));

    expect(path.isAbsolute(inventory.rootPath)).toBe(true);
    expect(inventory.rootPath).toBe(fixture.rootPath);
  });
});

describe('RepositoryScanner: source discovery', () => {
  it('discovers every TypeScript extension', async () => {
    const fixture = await repository({
      'a.ts': '',
      'b.tsx': '',
      'c.mts': '',
      'd.cts': '',
      'e.d.ts': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.d.ts']);
  });

  it('offers the compiler its TypeScript and JavaScript, and nothing else', async () => {
    // `sourceFiles` is what the compiler-backed analyser will read, not the repository's file
    // list — `files` is that, and it holds the CSS, the Markdown and the JSON as well.
    const fixture = await repository({
      'src/index.ts': '',
      'src/legacy.js': '',
      'src/component.jsx': '',
      'src/module.mjs': '',
      'src/script.cjs': '',
      'src/styles.css': '',
      'README.md': '',
      'data.json': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual([
      'src/component.jsx',
      'src/index.ts',
      'src/legacy.js',
      'src/module.mjs',
      'src/script.cjs',
    ]);
    expect(inventory.files.map((file) => file.path)).toContain('src/styles.css');
  });

  it('reports repository-relative POSIX paths', async () => {
    const fixture = await repository({ 'src/auth/auth.service.ts': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['src/auth/auth.service.ts']);
  });

  it('discovers sources inside hidden directories', async () => {
    const fixture = await repository({ '.storybook/main.ts': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['.storybook/main.ts']);
  });

  it('sorts results so repeated scans produce an identical inventory', async () => {
    const fixture = await repository({
      'z.ts': '',
      'a.ts': '',
      'm/nested.ts': '',
      'b.ts': '',
    });

    const first = await scanner.scan(fixture.rootPath);
    const second = await scanner.scan(fixture.rootPath);

    expect(first.sourceFiles).toEqual(['a.ts', 'b.ts', 'm/nested.ts', 'z.ts']);
    expect(second).toEqual(first);
  });

  it('does not follow symlinked directories', async () => {
    const fixture = await repository({ 'real/module.ts': '' });

    await fixture.createSymlink('real', 'linked');

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['real/module.ts']);
  });

  it('does not follow symlinked files', async () => {
    const fixture = await repository({ 'real.ts': '' });

    await fixture.createSymlink('real.ts', 'alias.ts');

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['real.ts']);
  });

  it('never reads source contents, so unparseable TypeScript still scans', async () => {
    const fixture = await repository({
      'src/broken.ts': 'class {{{ this is not typescript at all',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['src/broken.ts']);
    expect(inventory.language).toBe('typescript');
  });

  it('reports an empty repository without failing', async () => {
    const fixture = await repository();
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual([]);
    expect(inventory.directories).toEqual([]);
    expect(inventory.entryPoints).toEqual([]);
    expect(inventory.ignoredPaths).toEqual([]);
    expect(inventory.language).toBe('unknown');
  });
});

describe('RepositoryScanner: ignored directories', () => {
  it.each(IGNORED_DIRECTORY_NAMES)('does not discover sources inside %s', async (name) => {
    const fixture = await repository({
      'src/index.ts': '',
      [`${name}/ignored.ts`]: '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['src/index.ts']);
  });

  it.each(IGNORED_DIRECTORY_NAMES)('does not list %s as a directory', async (name) => {
    const fixture = await repository({ [`${name}/ignored.ts`]: '', 'src/index.ts': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.directories).toEqual(['src']);
  });

  it('ignores nested ignored directories', async () => {
    const fixture = await repository({
      'packages/api/src/index.ts': '',
      'packages/api/dist/index.ts': '',
      'packages/api/node_modules/dep/index.ts': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.sourceFiles).toEqual(['packages/api/src/index.ts']);
    expect(inventory.directories).toEqual(['packages', 'packages/api', 'packages/api/src']);
  });

  it('reports which ignored directories actually exist', async () => {
    const fixture = await repository({
      'node_modules/dep/index.js': '',
      'dist/index.js': '',
      'src/index.ts': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.ignoredPaths).toEqual(['dist', 'node_modules']);
  });

  it('reports nested ignored directories', async () => {
    const fixture = await repository({ 'packages/api/dist/index.js': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.ignoredPaths).toEqual(['packages/api/dist']);
  });

  it('does not descend into an ignored directory to report ignored directories inside it', async () => {
    const fixture = await repository({
      'node_modules/dep/dist/index.js': '',
      'node_modules/dep/node_modules/nested/index.js': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.ignoredPaths).toEqual(['node_modules']);
  });

  it('reports no ignored paths when none of the ignored directories exist', async () => {
    const fixture = await repository({ 'src/index.ts': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.ignoredPaths).toEqual([]);
  });
});

describe('RepositoryScanner: detection', () => {
  it('detects TypeScript from a tsconfig alone', async () => {
    const fixture = await repository({ 'tsconfig.json': '{}' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.language).toBe('typescript');
    expect(inventory.tsconfigPath).toBe('tsconfig.json');
  });

  it('reports a null tsconfig path when there is none', async () => {
    const fixture = await repository({ 'src/index.ts': '' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({ tsconfigPath: null });
  });

  it('does not treat a nested tsconfig as the repository tsconfig', async () => {
    const fixture = await repository({ 'packages/api/tsconfig.json': '{}' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({ tsconfigPath: null });
  });

  it('detects Express from dependencies', async () => {
    const fixture = await repository({
      'package.json': '{"dependencies":{"express":"^4.19.0"}}',
    });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      framework: 'express',
    });
  });

  it('detects Express from devDependencies', async () => {
    const fixture = await repository({
      'package.json': '{"devDependencies":{"express":"^4.19.0"}}',
    });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      framework: 'express',
    });
  });

  it('reports an unknown framework when Express is not declared', async () => {
    const fixture = await repository({
      'package.json': '{"dependencies":{"fastify":"^4.0.0"}}',
    });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      framework: 'unknown',
    });
  });

  it('reports an unknown framework when there is no manifest', async () => {
    const fixture = await repository({ 'src/index.ts': '' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      framework: 'unknown',
    });
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ])('detects the package manager from %s', async (fileName, packageManager) => {
    const fixture = await repository({ [fileName]: '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.packageManager).toBe(packageManager);
    expect(inventory.lockfile).toEqual({ path: fileName, packageManager });
  });

  it('reports an unknown package manager with no lockfile', async () => {
    const fixture = await repository({ 'package.json': '{}' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.packageManager).toBe('unknown');
    expect(inventory.lockfile).toBeNull();
  });

  it('ignores a lockfile that is not at the repository root', async () => {
    const fixture = await repository({ 'packages/api/pnpm-lock.yaml': '' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      packageManager: 'unknown',
      lockfile: null,
    });
  });

  it('records the package.json path when present', async () => {
    const fixture = await repository({ 'package.json': '{}' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      packageJsonPath: 'package.json',
    });
  });

  it('reports a null package.json path when absent', async () => {
    const fixture = await repository({ 'src/index.ts': '' });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({
      packageJsonPath: null,
    });
  });
});

describe('RepositoryScanner: entry points', () => {
  it('resolves a declared entry to a discovered source file', async () => {
    const fixture = await repository({
      'package.json': '{"main":"src/server.ts"}',
      'src/server.ts': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.entryPoints).toEqual([
      { path: 'src/server.ts', origin: 'manifest', field: 'main' },
    ]);
  });

  it('falls back to a conventional entry when the manifest points at build output', async () => {
    const fixture = await repository({
      'package.json': '{"main":"dist/index.js"}',
      'src/index.ts': '',
    });

    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.entryPoints).toEqual([
      { path: 'src/index.ts', origin: 'convention', field: null },
    ]);
  });

  it('finds conventional entries with no manifest at all', async () => {
    const fixture = await repository({ 'src/index.ts': '', 'src/server.ts': '' });
    const inventory = await scanner.scan(fixture.rootPath);

    expect(inventory.entryPoints.map((entry) => entry.path)).toEqual([
      'src/index.ts',
      'src/server.ts',
    ]);
  });

  it('does not report an entry point inside an ignored directory', async () => {
    const fixture = await repository({
      'package.json': '{"main":"dist/index.ts"}',
      'dist/index.ts': '',
    });

    await expect(scanner.scan(fixture.rootPath)).resolves.toMatchObject({ entryPoints: [] });
  });
});

describe('RepositoryScanner: failure modes', () => {
  it('rejects a path that does not exist', async () => {
    const fixture = await repository();

    await expect(scanner.scan(fixture.path('missing'))).rejects.toThrow(RepositoryScanError);
  });

  it('explains that the path does not exist', async () => {
    const fixture = await repository();

    await expect(scanner.scan(fixture.path('missing'))).rejects.toThrow(/does not exist/);
  });

  it('rejects a file', async () => {
    const fixture = await repository({ 'package.json': '{}' });

    await expect(scanner.scan(fixture.path('package.json'))).rejects.toThrow(
      /is not a directory/,
    );
  });

  it('rejects an empty path', async () => {
    await expect(scanner.scan('   ')).rejects.toThrow(RepositoryScanError);
  });

  it('names the offending path in the error message', async () => {
    const fixture = await repository();
    const missing = fixture.path('missing');

    await expect(scanner.scan(missing)).rejects.toThrow(missing);
  });

  it('fails loudly on a malformed package.json rather than reporting unknowns', async () => {
    const fixture = await repository({ 'package.json': '{ not json' });

    await expect(scanner.scan(fixture.rootPath)).rejects.toThrow(MalformedManifestError);
  });
});
