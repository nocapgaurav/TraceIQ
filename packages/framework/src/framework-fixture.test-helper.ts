import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IrBuilder, type RepositoryIR } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { Resolver, type ResolvedRepository } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';

import { FrameworkExtractor } from './framework-extractor.js';
import type { FrameworkAnnotations, RoleAnnotation, RouteAnnotation } from './types.js';

export type FixtureFiles = Readonly<Record<string, string>>;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    strict: false,
    skipLibCheck: true,
  },
});

/**
 * A real repository taken through the Project Host, IR Builder and Resolver, then
 * annotated.
 *
 * The extractor consumes a real IR, so the tests build one rather than hand-rolling a
 * stand-in that could disagree with what the IR Builder actually produces — the
 * extraction depends on details like which expressions the IR records and how it
 * attributes them.
 */
export class FrameworkFixture {
  private constructor(
    readonly rootPath: string,
    readonly ir: RepositoryIR,
    readonly resolved: ResolvedRepository,
    readonly annotations: FrameworkAnnotations,
  ) {}

  static async create(files: FixtureFiles): Promise<FrameworkFixture> {
    const rootPath = await mkdtemp(path.join(tmpdir(), 'traceiq-framework-'));

    for (const [relativePath, contents] of Object.entries({
      'tsconfig.json': TSCONFIG,
      ...files,
    })) {
      const absolutePath = path.join(rootPath, relativePath);

      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }

    const inventory: RepositoryInventory = {
      name: 'fixture',
      rootPath,
      language: 'typescript',
      framework: 'express',
      packageManager: 'unknown',
      sourceFiles: Object.keys(files).sort(),
      directories: [],
      tsconfigPath: 'tsconfig.json',
      packageJsonPath: null,
      lockfile: null,
      entryPoints: [],
      ignoredPaths: [],
      workspacePackages: [],
      files: [],
      languages: [],
      manifests: [],
      regions: [],
    };

    const context = new ProjectHost().load(inventory);

    try {
      const ir = new IrBuilder().build(context);
      const resolved = new Resolver().resolve({ ir, context });
      const annotations = new FrameworkExtractor().extract({ ir, resolved });

      return new FrameworkFixture(rootPath, ir, resolved, annotations);
    } finally {
      context.dispose();
    }
  }

  /** Re-runs extraction on the same inputs, for determinism checks. */
  reextract(): FrameworkAnnotations {
    return new FrameworkExtractor().extract({ ir: this.ir, resolved: this.resolved });
  }

  route(method: string, routePath: string): RouteAnnotation | undefined {
    return this.annotations.routes.find(
      (entry) => entry.method === method && entry.path === routePath,
    );
  }

  rolesOf(declarationId: string): readonly RoleAnnotation[] {
    return this.annotations.roles.filter((entry) => entry.declarationId === declarationId);
  }

  roleNames(declarationId: string): readonly string[] {
    return this.rolesOf(declarationId).map((entry) => entry.role);
  }

  envNames(): readonly string[] {
    return this.annotations.environmentVariables.map((entry) => entry.name);
  }

  async remove(): Promise<void> {
    await rm(this.rootPath, { recursive: true, force: true });
  }
}
