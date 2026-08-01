import type { RepositoryCapabilities } from '@traceiq/graph-api';
import type { GraphNode, NodeKind, RepositoryGraphApi } from '@traceiq/graph-api';
import type { NodeId, Role } from '@traceiq/types';

import { byOrdinal, toHandler, toReference } from './hydrate.js';
import { parseRouteId } from './route-identity.js';
import type {
  CalleeResult,
  DeclarationResult,
  DependencyResult,
  EnclosingResult,
  EnvironmentVariableResult,
  PathComposition,
  ReferenceResult,
  RoleQueryResult,
  RouteExplanation,
  RouteResult,
  UnresolvedResult,
  TechnologyResult,
} from './types.js';

/**
 * Node kinds that come from a declaration, in the order they are scanned.
 *
 * `Route`, `EnvironmentVariable`, `External` and `File` are excluded: none is a
 * declaration, and `findDeclaration` should not return one.
 */
const DECLARATION_KINDS: readonly NodeKind[] = [
  'Class',
  'Interface',
  'TypeAlias',
  'Enum',
  'EnumMember',
  'Function',
  'Method',
  'Property',
  'Accessor',
  'Constructor',
  'Variable',
  'Namespace',
];

/**
 * Kinds that can carry an architectural role.
 *
 * The Framework Extractor attributes roles only to top-level classes, functions and
 * variables, so scanning those three is complete and much cheaper than scanning every
 * declaration.
 */
const ROLE_BEARING_KINDS: readonly NodeKind[] = ['Class', 'Function', 'Variable'];

/**
 * Repository-level queries over the graph.
 *
 * Depends on **only** `RepositoryGraphApi`. No SQL, no SQLite, no driver, no compiler,
 * no graph internals: the constructor takes the interface, and everything else follows
 * from it. That is what makes the engine testable against an in-memory implementation
 * with no database present at all.
 *
 * Deterministic throughout. The Graph API returns ordered lists and nothing here
 * reorders except by ordinal, which is a defined order too. No query ranks, scores,
 * guesses or searches loosely.
 *
 * **Traversal is bounded.** No query walks further than two steps from its starting
 * point: a node, then its edges, then the nodes at their far end. Nothing is recursive,
 * so no query can loop or fan out unpredictably.
 *
 * Every result carries the graph node or edge it came from, so confidence, provenance
 * and source locations are never discarded.
 */
export class QueryEngine {
  readonly #api: RepositoryGraphApi;

  constructor(api: RepositoryGraphApi) {
    this.#api = api;
  }

  /** The declaration with this identifier, or `null` when it is not one. */
  findDeclaration(id: NodeId): DeclarationResult | null {
    const node = this.#api.getNode(id);

    if (node === null || !DECLARATION_KINDS.includes(node.kind)) {
      return null;
    }

    return { node, roles: this.#api.getRoles(node.id) };
  }

  /**
   * The declaration containing this one, or `null` when nothing does.
   *
   * One incoming `DECLARES` edge, which the graph guarantees is unique: the Graph Builder
   * emits exactly one per declaration. A container that is a `File` yields `null`, since a
   * file is not a declaration and `findDeclaration` would not return one either.
   *
   * This exists rather than being folded into `findReferences` because containment is not a
   * reference — see that method. Since the IR Expansion a container may itself be a
   * function, method, constructor, accessor or variable, so a nested declaration reports
   * the body it sits in.
   */
  findEnclosingDeclaration(id: NodeId): EnclosingResult | null {
    for (const edge of this.#api.getIncoming(id, 'DECLARES')) {
      const declaration = this.#api.getNode(edge.sourceId);

      if (declaration !== null && DECLARATION_KINDS.includes(declaration.kind)) {
        return { edge, declaration };
      }
    }

    return null;
  }

  /**
   * Everything that refers to this node.
   *
   * `DECLARES` is excluded: a class declaring a method is containment, not a reference to
   * it, and including it would make every member look referenced by its own container.
   */
  findReferences(id: NodeId): readonly ReferenceResult[] {
    return this.#api
      .getIncoming(id)
      .filter((edge) => edge.type !== 'DECLARES')
      .map((edge) => toReference(this.#api, edge));
  }

  /** References arising from a type position specifically. */
  findTypeReferences(id: NodeId): readonly ReferenceResult[] {
    return this.#api
      .getIncoming(id, 'REFERENCES_TYPE')
      .map((edge) => toReference(this.#api, edge));
  }

  /**
   * What calls this declaration.
   *
   * One step backwards along `CALLS`. Transitive callers need recursion, which no query
   * here performs — see the README.
   */
  findCallers(id: NodeId): readonly ReferenceResult[] {
    return this.#api.getIncoming(id, 'CALLS').map((edge) => toReference(this.#api, edge));
  }

  /**
   * What this declaration calls.
   *
   * One step forwards along `CALLS`. The target is attached, so a caller sees the
   * declaration rather than only its identifier.
   */
  findCallees(id: NodeId): readonly CalleeResult[] {
    return this.#api
      .getOutgoing(id, 'CALLS')
      .map((edge) => ({ edge, target: this.#api.getNode(edge.targetId) }));
  }

  findRoutes(): readonly RouteResult[] {
    return this.#api.getNodes('Route').flatMap((node) => {
      const route = this.#routeOf(node);

      return route === null ? [] : [route];
    });
  }

  /**
   * A route with its chain split into middleware and final handler.
   *
   * Handlers the pipeline could not link are returned alongside, so a chain with a
   * member-expression handler reads as incomplete rather than as shorter than it is.
   */
  explainRoute(routeId: NodeId): RouteExplanation | null {
    const node = this.#api.getNode(routeId);

    if (node === null || node.kind !== 'Route') {
      return null;
    }

    const route = this.#routeOf(node);

    if (route === null) {
      return null;
    }

    const handlers = route.handlers;
    const last = handlers.at(-1) ?? null;

    return {
      route,
      middleware: last === null ? [] : handlers.slice(0, -1),
      handler: last,
      unresolvedHandlers: this.#api
        .getUnresolved()
        .filter((entry) => entry.type === 'HANDLED_BY' && entry.sourceId === routeId),
    };
  }

  findEnvironmentVariables(): readonly EnvironmentVariableResult[] {
    return this.#api.getNodes('EnvironmentVariable').map((node) => ({
      node,
      reads: this.#api.getIncoming(node.id, 'READS').map((edge) => toReference(this.#api, edge)),
    }));
  }

  /**
   * Every external thing the repository reaches: a package in any ecosystem, a standard-library
   * module, or a language builtin. `node.externalKind` distinguishes them, and it is built from
   * `ECOSYSTEMS` rather than enumerated, so a new language's packaging system needs no entry here.
   */
  findDependencies(): readonly DependencyResult[] {
    return this.#api.getNodes('External').map((node) => ({
      node,
      importedBy: this.#api
        .getIncoming(node.id, 'IMPORTS')
        .map((edge) => toReference(this.#api, edge)),
    }));
  }

  /**
   * What the graph can answer, by technology region.
   *
   * A pass-through, like every other query here: the capability record is written with the
   * graph and this engine interprets nothing about it.
   */
  capabilities(): RepositoryCapabilities {
    return this.#api.getCapabilities();
  }

  /**
   * The frameworks, runtimes and infrastructure the repository is built from.
   *
   * A pass-through like the rest: technologies are `Technology` nodes written at scan time, and
   * this reads them back. Deriving them again here would be a second answer to a question the
   * graph already records — and search reads the same nodes, so the two cannot disagree.
   */
  technologies(): readonly TechnologyResult[] {
    return this.#api
      .getNodes('Technology')
      .map((node) => ({
        id: node.externalName ?? node.name,
        name: node.name,
        category: node.category ?? 'unknown',
        regionPath: node.containerChain ?? '',
        confidence: node.confidence,
        evidence: node.provenance.evidence,
      }))
      .sort((a, b) => a.regionPath.localeCompare(b.regionPath) || a.name.localeCompare(b.name));
  }

  findUnresolved(): readonly UnresolvedResult[] {
    return this.#api.getUnresolved().map((reference) => ({
      reference,
      source: this.#api.getNode(reference.sourceId),
    }));
  }

  /**
   * Declarations carrying a role.
   *
   * Costs one `getRoles` per candidate node, because the Graph API has no role index. It
   * is bounded by the number of classes, functions and top-level variables rather than by
   * the whole graph, and it is the most expensive query here — see the README.
   */
  findByRole(role: Role): readonly RoleQueryResult[] {
    const results: RoleQueryResult[] = [];

    for (const kind of ROLE_BEARING_KINDS) {
      for (const node of this.#api.getNodes(kind)) {
        const roles = this.#api.getRoles(node.id);

        if (roles.some((entry) => entry.role === role)) {
          results.push({ node, roles, matched: role });
        }
      }
    }

    return results;
  }

  findControllers(): readonly RoleQueryResult[] {
    return this.findByRole('Controller');
  }

  findServices(): readonly RoleQueryResult[] {
    return this.findByRole('Service');
  }

  findRepositories(): readonly RoleQueryResult[] {
    return this.findByRole('Repository');
  }

  #routeOf(node: GraphNode): RouteResult | null {
    const identity = parseRouteId(node.id);

    if (identity === null) {
      return null;
    }

    return {
      node,
      method: identity.method,
      path: identity.path,
      composition: composePath(identity.path),
      handlers: this.#api
        .getOutgoing(node.id, 'HANDLED_BY')
        .map((edge) => toHandler(this.#api, edge))
        .sort(byOrdinal),
    };
  }
}

/**
 * Composes a route's effective path from the mount prefixes applied to it.
 *
 * Performed here, per query, and never materialised — a composed path is derived, and
 * storing it would freeze an answer that its inputs can change.
 *
 * **No prefix is currently recoverable.** A mount is written `app.use('/api', router)`,
 * and while the IR records that call, the Framework Extractor keeps only the middleware
 * it names and discards the path. Nothing in the graph says which router was mounted
 * where, so composition has no input and every path is reported as local.
 *
 * This is reported rather than hidden: a caller must be able to tell a complete path
 * from one that may sit under a prefix. Making it work needs the Framework Extractor to
 * emit mount annotations.
 */
function composePath(path: string): PathComposition {
  return {
    composed: false,
    prefixes: [],
    effectivePath: path,
    note: 'no mount information is recorded in the graph, so this path is local to its router and may be mounted under a prefix',
  };
}
