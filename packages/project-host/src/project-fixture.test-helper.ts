import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RepositoryInventory } from '@traceiq/scanner';

export type FixtureFiles = Readonly<Record<string, string>>;

/**
 * A real temporary TypeScript project on disk.
 *
 * Inventories are built by hand rather than by running the Repository Scanner, so
 * a failure here is a Project Host failure and never a scanner one.
 */
export class ProjectFixture {
  private constructor(readonly rootPath: string) {}

  static async create(files: FixtureFiles = {}): Promise<ProjectFixture> {
    const rootPath = await mkdtemp(path.join(tmpdir(), 'traceiq-project-host-'));
    const fixture = new ProjectFixture(rootPath);

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

  path(relativePath: string): string {
    return path.join(this.rootPath, relativePath);
  }

  inventory(overrides: Partial<RepositoryInventory> = {}): RepositoryInventory {
    return {
      name: 'fixture',
      rootPath: this.rootPath,
      language: 'typescript',
      framework: 'unknown',
      packageManager: 'unknown',
      sourceFiles: [],
      directories: [],
      tsconfigPath: null,
      packageJsonPath: null,
      lockfile: null,
      entryPoints: [],
      ignoredPaths: [],
      ...overrides,
    };
  }

  async remove(): Promise<void> {
    await rm(this.rootPath, { recursive: true, force: true });
  }
}

/** A tsconfig resolving `node_modules` the classic way, to keep fixtures simple. */
export const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    strict: true,
    skipLibCheck: true,
  },
});
