import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IrBuilder, type RepositoryIR } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import type { RepositoryInventory } from '@traceiq/scanner';
import type { NodeId } from '@traceiq/types';

import { Resolver } from './resolver.js';
import type {
  ResolvedDeclaration,
  ResolvedRelationship,
  ResolvedRelationshipType,
  ResolvedRepository,
  UnresolvedReference,
} from './types.js';

export type FixtureFiles = Readonly<Record<string, string>>;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    strict: true,
    skipLibCheck: true,
  },
});

/**
 * A real temporary repository taken through the whole pipeline: Project Host, IR
 * Builder, Resolver.
 *
 * The Resolver's input is a real IR and a real program, so the tests build both
 * rather than hand-rolling stand-ins that could disagree with what the earlier
 * stages actually produce — which is precisely the correlation being tested.
 */
export class ResolverFixture {
  private constructor(
    readonly rootPath: string,
    readonly ir: RepositoryIR,
    readonly resolved: ResolvedRepository,
    readonly dispose: () => void,
  ) {}

  static async create(files: FixtureFiles): Promise<ResolverFixture> {
    const rootPath = await mkdtemp(path.join(tmpdir(), 'traceiq-resolver-'));

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
      framework: 'unknown',
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
    const ir = new IrBuilder().build(context);
    const resolved = new Resolver().resolve({ ir, context });

    return new ResolverFixture(rootPath, ir, resolved, () => {
      context.dispose();
    });
  }

  relationships(type: ResolvedRelationshipType): readonly ResolvedRelationship[] {
    return this.resolved.relationships.filter((entry) => entry.type === type);
  }

  /** Relationships of one type carrying one name, in discovery order. */
  named(type: ResolvedRelationshipType, name: string): readonly ResolvedRelationship[] {
    return this.relationships(type).filter((entry) => entry.name === name);
  }

  /** Relationships whose source is a specific declaration or file. */
  from(sourceId: string): readonly ResolvedRelationship[] {
    return this.resolved.relationships.filter((entry) => entry.sourceId === sourceId);
  }

  declaration(declarationId: string): ResolvedDeclaration | undefined {
    return this.resolved.declarations.find((entry) => entry.declarationId === declarationId);
  }

  unresolved(reason?: UnresolvedReference['reason']): readonly UnresolvedReference[] {
    return reason === undefined
      ? this.resolved.unresolved
      : this.resolved.unresolved.filter((entry) => entry.reason === reason);
  }

  /** The single target declaration id of a uniquely resolved relationship. */
  static targetId(relationship: ResolvedRelationship | undefined): NodeId | null {
    const target = relationship?.target;

    if (target === undefined) {
      return null;
    }

    if (target.kind === 'declaration') {
      return target.declarationId;
    }

    return target.kind === 'file' ? target.fileId : null;
  }

  async remove(): Promise<void> {
    this.dispose();
    await rm(this.rootPath, { recursive: true, force: true });
  }
}
