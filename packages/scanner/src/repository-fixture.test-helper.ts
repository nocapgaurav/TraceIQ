import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Repository-relative path to file contents. Parent directories are created. */
export type FixtureFiles = Readonly<Record<string, string>>;

/**
 * A real temporary repository on disk.
 *
 * The scanner's job is to observe a filesystem, so its tests use one rather than
 * a mocked `fs`. A fake would only prove the scanner matches our model of the
 * filesystem, which is precisely the thing worth testing.
 */
export class RepositoryFixture {
  private constructor(readonly rootPath: string) {}

  static async create(files: FixtureFiles = {}): Promise<RepositoryFixture> {
    const rootPath = await mkdtemp(path.join(tmpdir(), 'traceiq-scanner-'));
    const fixture = new RepositoryFixture(rootPath);

    await fixture.writeFiles(files);

    return fixture;
  }

  async writeFiles(files: FixtureFiles): Promise<void> {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = this.path(relativePath);

      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }
  }

  async createDirectory(relativePath: string): Promise<void> {
    await mkdir(this.path(relativePath), { recursive: true });
  }

  async createSymlink(target: string, linkPath: string): Promise<void> {
    await symlink(this.path(target), this.path(linkPath));
  }

  path(relativePath: string): string {
    return path.join(this.rootPath, relativePath);
  }

  async remove(): Promise<void> {
    await rm(this.rootPath, { recursive: true, force: true });
  }
}
