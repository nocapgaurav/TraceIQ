import { CallGraphResolver } from '@traceiq/call-graph';
import { FrameworkExtractor } from '@traceiq/framework';
import { GraphBuilder, GraphStore, SqliteGraphApi } from '@traceiq/graph';
import { IrBuilder } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { Resolver } from '@traceiq/resolver';
import { RepositoryScanner } from '@traceiq/scanner';

import type { RepositorySession, ScanInput, ScanSummary } from './types.js';

/**
 * The write path, and the only door onto a stored graph.
 *
 * Every analysis package already exists; this wires them in the one order they compose in, and hands
 * back an abstract `RepositoryGraphApi`. It exists so an **interface** — a CLI, an HTTP surface, a
 * context builder — can build and open a repository graph without importing the scanner, the compiler
 * host, the IR, the resolver, the graph builder, the store or SQLite.
 *
 * **It contains no analysis of its own.** Nothing here parses, resolves, infers or interprets: every
 * line delegates, and removing it would change no result, only who has to know the order.
 *
 * The pipeline is stateless. A scan takes its inputs and returns counts; an open returns a session the
 * caller closes. There is no singleton and nothing cached across calls, so two scans cannot interfere.
 */
export class RepositoryPipeline {
  /**
   * Builds the repository graph and stores it.
   *
   * scanner → project host → IR → resolver → call graph → framework → graph builder → store.
   * The compiler host is disposed before the store is opened, so no compiler state outlives the build.
   */
  async scan(input: ScanInput): Promise<ScanSummary> {
    const inventory = await new RepositoryScanner().scan(input.repositoryPath);
    const context = new ProjectHost().load(inventory);

    try {
      const ir = new IrBuilder().build(context);
      const resolved = new Resolver().resolve({ ir, context });
      const callGraph = new CallGraphResolver().resolve({ ir, resolved });
      const annotations = new FrameworkExtractor().extract({ ir, resolved });
      const graph = new GraphBuilder().build({ ir, resolved, annotations, callGraph });

      const store = GraphStore.open(input.databasePath);

      try {
        store.write(graph, input.createdAt);
      } finally {
        store.close();
      }

      const kind = (name: string): number =>
        graph.nodes.filter((node) => node.kind === name).length;

      return {
        repository: inventory.name,
        repositoryPath: input.repositoryPath,
        databasePath: input.databasePath,
        files: graph.fileIds.length,
        declarations: graph.nodes.length - kind('File') - kind('Route') - kind('EnvironmentVariable') - kind('External'),
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        unresolvedReferences: graph.unresolved.length,
        routes: kind('Route'),
        environmentVariables: kind('EnvironmentVariable'),
        externalPackages: graph.nodes.filter((node) => node.externalKind === 'npm').length,
        callEdges: callGraph.calls.length,
        unresolvedCalls: callGraph.unresolved.length,
      };
    } finally {
      context.dispose();
    }
  }

  /**
   * Opens a stored graph.
   *
   * The caller receives a `RepositoryGraphApi` and a `close`, and never learns what implements it.
   */
  open(databasePath: string): RepositorySession {
    const api = SqliteGraphApi.open(databasePath);

    return {
      api,
      databasePath,
      close: () => {
        api.close();
      },
    };
  }
}
