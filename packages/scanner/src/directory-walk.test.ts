import { afterEach, describe, expect, it } from 'vitest';

import { walkDirectories } from './directory-walk.js';
import { RepositoryFixture, type FixtureFiles } from './repository-fixture.test-helper.js';

const fixtures: RepositoryFixture[] = [];

async function repository(files: FixtureFiles = {}): Promise<RepositoryFixture> {
  const fixture = await RepositoryFixture.create(files);

  fixtures.push(fixture);

  return fixture;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe('walkDirectories', () => {
  it('reports nothing for an empty repository', async () => {
    const fixture = await repository();

    await expect(walkDirectories(fixture.rootPath)).resolves.toEqual({
      directories: [],
      ignoredPaths: [],
    });
  });

  it('reports nothing for a repository containing only files', async () => {
    const fixture = await repository({ 'index.ts': '', 'package.json': '{}' });
    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual([]);
  });

  it('reports nested directories, sorted', async () => {
    const fixture = await repository({
      'src/auth/auth.service.ts': '',
      'src/users/users.service.ts': '',
      'docs/readme.md': '',
    });

    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual(['docs', 'src', 'src/auth', 'src/users']);
  });

  it('reaches arbitrary depth', async () => {
    const fixture = await repository({ 'a/b/c/d/e/file.ts': '' });
    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e']);
  });

  it('records an ignored directory without listing it as a directory', async () => {
    const fixture = await repository({ 'node_modules/dep/index.js': '', 'src/index.ts': '' });
    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual(['src']);
    expect(walk.ignoredPaths).toEqual(['node_modules']);
  });

  it('records ignored directories nested inside the source tree', async () => {
    const fixture = await repository({
      'packages/api/src/index.ts': '',
      'packages/api/dist/index.js': '',
      'packages/web/.next/build.js': '',
    });

    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual([
      'packages',
      'packages/api',
      'packages/api/src',
      'packages/web',
    ]);
    expect(walk.ignoredPaths).toEqual(['packages/api/dist', 'packages/web/.next']);
  });

  it('does not descend into an ignored directory', async () => {
    const fixture = await repository({
      'node_modules/dep/dist/index.js': '',
      'node_modules/dep/node_modules/nested/index.js': '',
      'node_modules/dep/src/index.js': '',
    });

    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual([]);
    expect(walk.ignoredPaths).toEqual(['node_modules']);
  });

  it('records several ignored directories at the root, sorted', async () => {
    const fixture = await repository({
      'dist/a.js': '',
      'coverage/b.json': '',
      'node_modules/c/index.js': '',
    });

    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.ignoredPaths).toEqual(['coverage', 'dist', 'node_modules']);
  });

  it('treats a symlinked directory as neither analysed nor ignored, so the walk cannot leave the repository', async () => {
    const fixture = await repository({ 'real/module.ts': '' });

    await fixture.createSymlink('real', 'linked');

    const walk = await walkDirectories(fixture.rootPath);

    expect(walk.directories).toEqual(['real']);
    expect(walk.ignoredPaths).toEqual([]);
  });

  it('cannot loop on a symlink cycle', async () => {
    const fixture = await repository({ 'a/file.ts': '' });

    await fixture.createSymlink('a', 'a/self');

    await expect(walkDirectories(fixture.rootPath)).resolves.toEqual({
      directories: ['a'],
      ignoredPaths: [],
    });
  });

  it('rejects when the root cannot be read', async () => {
    const fixture = await repository();

    await expect(walkDirectories(fixture.path('missing'))).rejects.toThrow();
  });
});
