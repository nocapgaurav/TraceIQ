import type { GraphNode } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import { dependentsClosure, type RouteReach } from './dependents-closure.js';
import { LIMITATION_DETAIL } from './limitations.js';
import {
  LIMITATION_CODES,
  type AffectedNode,
  type EnvironmentVariableImpact,
  type ExternalDependencyImpact,
  type ImpactAnalysisResult,
  type ImpactQueries,
  type Limitation,
  type LimitationCode,
  type RouteImpact,
  type UnknownImpact,
} from './types.js';

/**
 * Everything inside the repository a change to one declaration could affect.
 *
 * Static repository intelligence over the existing graph. **Nothing is predicted, simulated,
 * ranked, scored or generated**: every reported relationship is an edge that already exists,
 * carried with the edge itself so it can be justified.
 *
 * **Traversal strategy.** One breadth-first walk outwards along incoming edges — who depends
 * on this — using `findReferences` as the only primitive. The four whole-collection queries
 * are issued **once each** regardless of how large the closure grows, and then scoped to it,
 * so cost is one query per affected node plus a fixed five.
 *
 * **No storage, no compiler, no parser.** The constructor takes `ImpactQueries`, which names
 * seven questions and no connection, statement or path.
 */
export class ImpactAnalyzer {
  readonly #queries: ImpactQueries;

  constructor(queries: ImpactQueries) {
    this.#queries = queries;
  }

  /**
   * Analyses a declaration, or returns `null` when the identifier names none.
   *
   * `null` rather than an empty result: a file, a route, an external or an unknown identifier
   * is not a declaration, and a hollow result would say "nothing is affected" when the truth
   * is "this is not a symbol".
   */
  analyze(id: NodeId): ImpactAnalysisResult | null {
    const target = this.#queries.findDeclaration(id);

    if (target === null) {
      return null;
    }

    const closure = dependentsClosure(this.#queries, id);

    // Projections of the target's own incoming edges, which the closure already fetched at
    // depth 0. Asking findCallers and findTypeReferences would re-read the same edges.
    const callers = closure.directReferences.filter((entry) => entry.edge.type === 'CALLS');
    const typeReferences = closure.directReferences.filter(
      (entry) => entry.edge.type === 'REFERENCES_TYPE',
    );
    const imports = closure.directReferences.filter((entry) => entry.edge.type === 'IMPORTS');

    // Callees are reported but never expanded: a callee does not break when the target
    // changes, so its own callees are not affected and following them would inflate the
    // closure with declarations the change cannot reach.
    const callees = this.#queries.findCallees(id);

    // The file set is computed once and used twice: to scope external dependencies, and to
    // tell a file-sourced unresolved reference from a declaration-sourced one.
    const fileIds = filesOf(target.node, closure.affected);

    const routesAffected = this.#routes(closure.routeReaches);
    const environmentVariables = this.#environmentVariables(closure.members);
    const externalDependencies = this.#externalDependencies(fileIds);
    const unknown = this.#unknown(closure.members, fileIds);

    const directlyAffected = closure.affected.filter((entry) => entry.category === 'DIRECT');
    const indirectlyAffected = closure.affected.filter((entry) => entry.category === 'INDIRECT');

    return {
      target,
      directlyAffected,
      indirectlyAffected,
      callers,
      callees,
      typeReferences,
      imports,
      routesAffected,
      environmentVariables,
      externalDependencies,
      unknown: unknown.entries,
      confidence: target.node.confidence,
      provenance: target.node.provenance,
      limitations: limitationsFor({
        inferredCalls: [...callers, ...callees].filter((entry) => entry.edge.confidence === 'INFERRED')
          .length,
        ambiguous: [...closure.directReferences, ...callees].filter(
          (entry) => entry.edge.candidateGroup !== null,
        ).length,
        unknownCount: unknown.entries.length,
        repositoryWideUnresolved: unknown.repositoryWide,
        fileScopedUnknown: unknown.entries.filter((entry) => entry.scope === 'file').length,
        declarationScopedUnknown: unknown.entries.filter((entry) => entry.scope === 'declaration')
          .length,
        fileNodes: closure.affected.filter((entry) => entry.node.kind === 'File').length,
        externalCount: externalDependencies.length,
        uncomposedRoutes: routesAffected.filter((entry) => !entry.route.composition.composed).length,
      }),
      statistics: {
        nodesVisited: closure.members.size,
        maxDepth: closure.maxDepth,
        referenceQueries: closure.referenceQueries,
        // findDeclaration, findCallees, findRoutes, findEnvironmentVariables,
        // findDependencies, findUnresolved.
        wholeCollectionQueries: 6,
      },
    };
  }

  /**
   * Hydrates the routes the traversal found reaching the closure.
   *
   * The traversal already knows *which* routes and which node each reaches, from the
   * `HANDLED_BY` edges it walked past — so this needs one `findRoutes` to attach the method,
   * path, composition and chain, rather than scanning every route for a match.
   *
   * A route reaching the target itself is still `INDIRECT`: a route is not a declaration, and
   * the category vocabulary places every route reaching the declaration there.
   */
  #routes(reaches: readonly RouteReach[]): readonly RouteImpact[] {
    if (reaches.length === 0) {
      return [];
    }

    const routes = new Map(this.#queries.findRoutes().map((route) => [route.node.id, route]));

    return reaches.flatMap((reach) => {
      const route = routes.get(reach.routeId);

      return route === undefined ? [] : [{ route, reaches: reach.reaches, via: reach.via }];
    });
  }

  /** Environment variables read from inside the closure, with only those reads. */
  #environmentVariables(members: ReadonlySet<NodeId>): readonly EnvironmentVariableImpact[] {
    return this.#queries.findEnvironmentVariables().flatMap((variable) => {
      const reads = variable.reads.filter((read) => members.has(read.edge.sourceId));

      return reads.length === 0 ? [] : [{ node: variable.node, reads }];
    });
  }

  /**
   * Externals imported by a file holding something in the closure.
   *
   * File-scoped, because `IMPORTS` is recorded at a file. The file set is the files of every
   * affected node plus the target's own, together with any file that is itself in the closure.
   */
  #externalDependencies(fileIds: ReadonlySet<NodeId>): readonly ExternalDependencyImpact[] {
    return this.#queries.findDependencies().flatMap((dependency) => {
      const importedBy = dependency.importedBy.filter((entry) => fileIds.has(entry.edge.sourceId));

      return importedBy.length === 0 ? [] : [{ node: dependency.node, importedBy }];
    });
  }

  /**
   * The `UNKNOWN` category: relationships inside the closure that could not be resolved.
   *
   * Scoped to nodes that are themselves in the closure. A file-level unresolved import appears
   * only when that file is affected in its own right — including every file's unresolved
   * references would report thousands that have no bearing on this target.
   */
  #unknown(members: ReadonlySet<NodeId>, fileIds: ReadonlySet<NodeId>): UnknownScoping {
    const entries: UnknownImpact[] = [];
    let repositoryWide = 0;

    for (const result of this.#queries.findUnresolved()) {
      repositoryWide += 1;

      const at = result.reference.sourceId;

      if (!members.has(at)) {
        continue;
      }

      entries.push({ result, at, scope: fileIds.has(at) ? 'file' : 'declaration' });
    }

    return { entries, repositoryWide };
  }
}

/**
 * Every file the closure touches: the file each affected node was written in, plus any file
 * that is itself affected.
 *
 * A file in the closure always arrives through `affected` — the target is a declaration, so it
 * can never itself be a file.
 */
function filesOf(targetNode: GraphNode, affected: readonly AffectedNode[]): ReadonlySet<NodeId> {
  const files = new Set<NodeId>();

  for (const node of [targetNode, ...affected.map((entry) => entry.node)]) {
    if (node.kind === 'File') {
      files.add(node.id);
    }

    if (node.fileId !== null) {
      files.add(node.fileId);
    }
  }

  return files;
}

interface UnknownScoping {
  readonly entries: readonly UnknownImpact[];
  /** Unresolved references in the whole repository, for the hidden-dependents limitation. */
  readonly repositoryWide: number;
}

interface LimitationFacts {
  readonly inferredCalls: number;
  readonly ambiguous: number;
  readonly unknownCount: number;
  readonly repositoryWideUnresolved: number;
  readonly fileScopedUnknown: number;
  readonly declarationScopedUnknown: number;
  readonly fileNodes: number;
  readonly externalCount: number;
  readonly uncomposedRoutes: number;
}

/**
 * Selects the limitations this result carries.
 *
 * `null` marks one that always applies; a number is how many parts of the result it bears on,
 * and zero means it does not apply. Iterating `LIMITATION_CODES` gives a fixed emission order,
 * and the exhaustive record means a new code cannot be added without deciding when it fires.
 */
function limitationsFor(facts: LimitationFacts): readonly Limitation[] {
  const affected: Readonly<Record<LimitationCode, number | null>> = {
    'call-coverage-partial': null,
    'calls-are-inferred': facts.inferredCalls,
    'no-interface-or-dynamic-dispatch': null,
    'unresolved-relationships-in-closure': facts.unknownCount,
    'closure-may-miss-hidden-dependents': facts.repositoryWideUnresolved,
    // Reported only when file-sourced entries actually outnumber the ones recorded at an
    // affected declaration, which is what makes the field hard to read.
    'file-level-unresolved-dominates':
      facts.fileScopedUnknown > facts.declarationScopedUnknown ? facts.fileScopedUnknown : 0,
    'ambiguous-relationships': facts.ambiguous,
    'file-level-attribution': facts.fileNodes,
    'containment-not-followed': null,
    'external-dependencies-are-file-scoped': facts.externalCount,
    'route-prefixes-not-composed': facts.uncomposedRoutes,
  };

  return LIMITATION_CODES.flatMap((code) => {
    const count = affected[code];

    return count === 0 ? [] : [{ code, detail: LIMITATION_DETAIL[code], affected: count }];
  });
}
