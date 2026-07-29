import type { NodeId } from '@traceiq/types';

import { LIMITATION_DETAIL } from './limitations.js';
import { sourceFileOf } from './source-file.js';
import {
  LIMITATION_CODES,
  type EnvironmentVariableUse,
  type ExplainSymbolQueries,
  type ExplainSymbolResult,
  type ExternalDependencyUse,
  type Limitation,
  type LimitationCode,
  type ReachingRoute,
  type ScopedUnresolved,
} from './types.js';

/**
 * Everything the repository records about one declaration, in one result.
 *
 * The first end-to-end capability, and a pure assembly step: it asks the Query Engine nine
 * questions and arranges the answers. It computes no fact of its own.
 *
 * **No AI, and nothing generated.** Nothing here summarises, ranks, scores, searches or
 * writes prose. The only text in the output is a fixed limitation string selected from a
 * closed table, and the only ordering is the Query Engine's own — no field is sorted here,
 * so identical inputs give an identical result.
 *
 * **No storage.** The constructor takes `ExplainSymbolQueries`, which names nine questions
 * and no connection, statement or path. SQLite, the Graph Builder, the Graph Store and the
 * Project Host are absent from this package's runtime dependencies; `ts-morph` is reachable
 * only because `@traceiq/graph-api` takes one type from `@traceiq/ir`, and nothing here
 * imports it — see the README.
 */
export class SymbolExplainer {
  readonly #queries: ExplainSymbolQueries;

  constructor(queries: ExplainSymbolQueries) {
    this.#queries = queries;
  }

  /**
   * Explains a declaration, or returns `null` when the identifier names none.
   *
   * `null` rather than an empty result: a file, a route, an external or an unknown
   * identifier is not a declaration, and returning a hollow explanation for one would say
   * "nothing is recorded about this" when the truth is "this is not a symbol".
   *
   * Nine queries, one per question, plus one `explainRoute` per route that actually reaches
   * this declaration — which is none for almost every declaration.
   */
  explain(id: NodeId): ExplainSymbolResult | null {
    const declaration = this.#queries.findDeclaration(id);

    if (declaration === null) {
      return null;
    }

    const { node } = declaration;

    // Every incoming edge except DECLARES, fetched once. Calls and type references are
    // projections of it rather than separate queries: `findCallers` and `findTypeReferences`
    // would re-read the same edges, and a projection also guarantees what a consumer would
    // otherwise have to trust — that both are subsets of `references`, in the same order.
    const references = this.#queries.findReferences(id);
    const incomingCalls = references.filter((entry) => entry.edge.type === 'CALLS');
    const typeReferences = references.filter((entry) => entry.edge.type === 'REFERENCES_TYPE');

    const outgoingCalls = this.#queries.findCallees(id);
    const routes = this.#reachingRoutes(id);
    const environmentVariables = this.#environmentVariables(id);
    const externalDependencies = this.#externalDependencies(node.fileId);
    const unresolved = this.#unresolved(id, node.fileId);

    return {
      declaration,
      kind: node.kind,
      sourceFile: sourceFileOf(node.fileId),
      locations: node.locations,
      enclosingDeclaration: this.#queries.findEnclosingDeclaration(id),
      incomingCalls,
      outgoingCalls,
      references,
      typeReferences,
      routes,
      environmentVariables,
      externalDependencies,
      confidence: node.confidence,
      provenance: node.provenance,
      unresolved,
      limitations: limitationsFor({
        roleCount: declaration.roles.length,
        inferredCalls: [...incomingCalls, ...outgoingCalls].filter(
          (entry) => entry.edge.confidence === 'INFERRED',
        ).length,
        ambiguous: [...references, ...outgoingCalls].filter(
          (entry) => entry.edge.candidateGroup !== null,
        ).length,
        unboundCalls: unresolved.filter(
          (entry) => entry.scope === 'declaration' && entry.result.reference.type === 'CALLS',
        ).length,
        uncomposedRoutes: routes.filter(
          (entry) => !entry.explanation.route.composition.composed,
        ).length,
        externalCount: externalDependencies.length,
      }),
    };
  }

  /**
   * Routes whose chain reaches this declaration.
   *
   * Every route is scanned, the Query Engine having no reverse lookup from a handler. That
   * is bounded by the number of routes rather than the graph, and it is the one scan this
   * capability cannot avoid.
   *
   * `explainRoute` is asked only about a route that matched, so the middleware/handler split
   * stays the Query Engine's rule rather than being re-derived here where the two could
   * disagree.
   */
  #reachingRoutes(id: NodeId): readonly ReachingRoute[] {
    const reaching: ReachingRoute[] = [];

    for (const route of this.#queries.findRoutes()) {
      const matches = route.handlers.filter((handler) => handler.edge.targetId === id);

      if (matches.length === 0) {
        continue;
      }

      const explanation = this.#queries.explainRoute(route.node.id);

      if (explanation === null) {
        continue;
      }

      for (const match of matches) {
        reaching.push({
          explanation,
          position: explanation.handler?.edge.id === match.edge.id ? 'handler' : 'middleware',
          ordinal: match.edge.ordinal,
        });
      }
    }

    return reaching;
  }

  /** Environment variables this declaration reads, each carrying only its own reads. */
  #environmentVariables(id: NodeId): readonly EnvironmentVariableUse[] {
    return this.#queries.findEnvironmentVariables().flatMap((variable) => {
      const reads = variable.reads.filter((read) => read.edge.sourceId === id);

      return reads.length === 0 ? [] : [{ node: variable.node, reads }];
    });
  }

  /**
   * Externals the containing file imports.
   *
   * File-scoped because `IMPORTS` is sourced at a file. Narrowing it to this declaration
   * would need import-usage analysis that no stage performs, so the scope is reported
   * instead of guessed at — see the `external-dependencies-are-file-scoped` limitation.
   */
  #externalDependencies(fileId: NodeId | null): readonly ExternalDependencyUse[] {
    if (fileId === null) {
      return [];
    }

    return this.#queries.findDependencies().flatMap((dependency) => {
      const importedByFile = dependency.importedBy.filter((entry) => entry.edge.sourceId === fileId);

      return importedByFile.length === 0 ? [] : [{ node: dependency.node, importedByFile }];
    });
  }

  /**
   * Unresolved references bearing on this result, each labelled by how closely.
   *
   * A file-scoped entry is included because an unresolved import in the containing file may
   * well be why something here did not bind — but it is labelled `file` rather than claimed
   * as this declaration's, so a consumer can tell the difference.
   */
  #unresolved(id: NodeId, fileId: NodeId | null): readonly ScopedUnresolved[] {
    return this.#queries.findUnresolved().flatMap((result): readonly ScopedUnresolved[] => {
      if (result.reference.sourceId === id) {
        return [{ result, scope: 'declaration' }];
      }

      return fileId !== null && result.reference.sourceId === fileId
        ? [{ result, scope: 'file' }]
        : [];
    });
  }
}

interface LimitationFacts {
  readonly roleCount: number;
  readonly inferredCalls: number;
  readonly ambiguous: number;
  readonly unboundCalls: number;
  readonly uncomposedRoutes: number;
  readonly externalCount: number;
}

/**
 * Selects the limitations this result carries.
 *
 * `null` marks one that always applies; a number is how many parts of the result it bears
 * on, and zero means it does not apply at all. Iterating `LIMITATION_CODES` rather than
 * pushing as we go gives a fixed emission order, and the exhaustive record means a new code
 * cannot be added without deciding when it fires.
 */
function limitationsFor(facts: LimitationFacts): readonly Limitation[] {
  const affected: Readonly<Record<LimitationCode, number | null>> = {
    'call-coverage-partial': null,
    'calls-are-inferred': facts.inferredCalls,
    'no-transitive-reach': null,
    'unbound-calls-at-this-declaration': facts.unboundCalls,
    'ambiguous-relationships': facts.ambiguous,
    'external-dependencies-are-file-scoped': facts.externalCount,
    'route-prefixes-not-composed': facts.uncomposedRoutes,
    'roles-are-judgements': facts.roleCount,
    'source-file-node-not-reachable': null,
  };

  return LIMITATION_CODES.flatMap((code) => {
    const count = affected[code];

    return count === 0 ? [] : [{ code, detail: LIMITATION_DETAIL[code], affected: count }];
  });
}
