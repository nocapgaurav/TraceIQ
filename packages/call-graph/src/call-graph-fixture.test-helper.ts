import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IrBuilder, type RepositoryIR } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { Resolver, type ResolvedRepository } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';

import { CallGraphResolver } from './call-graph-resolver.js';
import type { CallGraph, CallRelationship, UnresolvedCall } from './types.js';

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
 * A real repository taken through the Project Host, IR Builder and Resolver, then bound
 * into a call graph.
 *
 * The binding rules depend on details of what the IR records — which expressions, how
 * they are attributed, how a callee is split into root and member — so the tests build a
 * real IR rather than a stand-in that could disagree with it.
 */
export class CallGraphFixture {
  private constructor(
    readonly rootPath: string,
    readonly ir: RepositoryIR,
    readonly resolved: ResolvedRepository,
    readonly callGraph: CallGraph,
  ) {}

  static async create(files: FixtureFiles): Promise<CallGraphFixture> {
    const rootPath = await mkdtemp(path.join(tmpdir(), 'traceiq-call-graph-'));

    for (const [relativePath, contents] of Object.entries({ 'tsconfig.json': TSCONFIG, ...files })) {
      const absolutePath = path.join(rootPath, relativePath);

      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }

    const inventory: RepositoryInventory = {
      name: 'call-fixture',
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
      const ir = new IrBuilder().build(context);
      const resolved = new Resolver().resolve({ ir, context });

      return new CallGraphFixture(
        rootPath,
        ir,
        resolved,
        new CallGraphResolver().resolve({ ir, resolved }),
      );
    } finally {
      context.dispose();
    }
  }

  /** Re-binds the same inputs, for determinism checks. */
  rebind(): CallGraph {
    return new CallGraphResolver().resolve({ ir: this.ir, resolved: this.resolved });
  }

  /** The call bound from a particular callee expression. */
  call(calleeText: string): CallRelationship | undefined {
    return this.callGraph.calls.find((entry) => entry.calleeText === calleeText);
  }

  callsFrom(sourceId: string): readonly CallRelationship[] {
    return this.callGraph.calls.filter((entry) => entry.sourceId === sourceId);
  }

  unresolved(calleeText: string): UnresolvedCall | undefined {
    return this.callGraph.unresolved.find((entry) => entry.calleeText === calleeText);
  }

  async remove(): Promise<void> {
    await rm(this.rootPath, { recursive: true, force: true });
  }
}
