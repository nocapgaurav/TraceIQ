import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProjectHost } from '@traceiq/project-host';
import type { RepositoryInventory } from '@traceiq/scanner';

import { IrBuilder } from './ir-builder.js';
import type { DeclarationIR, ExportIR, ImportIR, RepositoryIR } from './types.js';

export type FixtureFiles = Readonly<Record<string, string>>;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    skipLibCheck: true,
  },
});

/**
 * A real temporary repository, loaded through the real Project Host.
 *
 * The IR Builder's input is a loaded TypeScript program, so its tests use one.
 * Inventories are hand-built rather than produced by the scanner, so a failure
 * here is an IR Builder failure.
 */
export class IrFixture {
  private constructor(
    readonly rootPath: string,
    readonly ir: RepositoryIR,
  ) {}

  static async create(files: FixtureFiles): Promise<IrFixture> {
    const rootPath = await mkdtemp(path.join(tmpdir(), 'traceiq-ir-'));

    for (const [relativePath, contents] of Object.entries({ 'tsconfig.json': TSCONFIG, ...files })) {
      const absolutePath = path.join(rootPath, relativePath);

      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }

    const inventory: RepositoryInventory = {
      name: 'fixture',
      rootPath,
      language: 'typescript',
      framework: 'unknown',
      packageManager: 'unknown',
      sourceFiles: Object.keys(files).sort(),
      directories: [],
      tsconfigPath: 'tsconfig.json',
      packageJsonPath: null,
      lockfile: null,
      entryPoints: [],
      ignoredPaths: [],
    };

    const context = new ProjectHost().load(inventory);

    try {
      return new IrFixture(rootPath, new IrBuilder().build(context));
    } finally {
      context.dispose();
    }
  }

  /** Finds a declaration by the identifier its path and chain imply. */
  declaration(repoRelativePath: string, chain: string): DeclarationIR | undefined {
    return this.ir.declarations.find(
      (candidate) => candidate.id === `sym:${repoRelativePath}#${chain}`,
    );
  }

  declarationsIn(repoRelativePath: string): readonly DeclarationIR[] {
    return this.ir.declarations.filter(
      (candidate) => candidate.fileId === `file:${repoRelativePath}`,
    );
  }

  importsIn(repoRelativePath: string): readonly ImportIR[] {
    return this.ir.imports.filter((candidate) => candidate.fileId === `file:${repoRelativePath}`);
  }

  exportsIn(repoRelativePath: string): readonly ExportIR[] {
    return this.ir.exports.filter((candidate) => candidate.fileId === `file:${repoRelativePath}`);
  }

  async remove(): Promise<void> {
    await rm(this.rootPath, { recursive: true, force: true });
  }
}
