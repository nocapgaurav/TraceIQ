import { listing } from '@traceiq/explorer';
import type { ReachedNode, SymbolView } from '@traceiq/explorer';
import type { GraphNode } from '@traceiq/graph-api';
import type { RouteHandlerResult } from '@traceiq/query';
import type { NodeId, Role } from '@traceiq/types';

import { limitationsOf, roleGroupsOf, treeRef, type NavigationContext } from './navigation-context.js';
import type {
  ChainPosition,
  HandlerStep,
  ReachedRef,
  RouteExplanationView,
  RouteSelector,
  RouteSummary,
  TreeRef,
} from './types.js';

const ROUTE_PREFIX = 'route:';

/**
 * Resolves a route named by method and path, or by identifier.
 *
 * `route:<METHOD>:<path>` is the frozen identity, so a method and path compose into one directly.
 * The composed identifier is then **looked up** rather than trusted: a route the graph does not hold
 * yields `null`, so nothing is reported for a path that was never registered.
 */
export function routeIdOf(selector: RouteSelector): NodeId {
  if (typeof selector === 'string') {
    return selector;
  }

  return `${ROUTE_PREFIX}${selector.method}:${selector.path}` as NodeId;
}

export function explainRouteOf(
  context: NavigationContext,
  selector: RouteSelector,
): RouteExplanationView | null {
  const routeId = routeIdOf(selector);
  const node = context.node(routeId);

  if (node === null || node.kind !== 'Route') {
    return null;
  }

  // The Query Engine owns the middleware/handler split and the unlinked handlers. Nothing here
  // re-derives either.
  const explanation = context.query((queries) => queries.explainRoute(routeId));

  if (explanation === null) {
    return null;
  }

  const middleware = explanation.middleware.map((entry) => stepOf(context, entry, 'middleware'));
  const handler =
    explanation.handler === null ? null : stepOf(context, explanation.handler, 'handler');
  const chain = handler === null ? middleware : [...middleware, handler];

  const linked = chain.filter((step) => step.declaration !== null);
  const reach = reachFrom(context, linked);

  const roles = rolesReached(context, reach);
  const externals = externalsOf(context, linked);
  const environmentVariables = environmentVariablesOf(context, linked, reach);

  const summary: RouteSummary = {
    route: treeRef(node),
    method: explanation.route.method,
    path: explanation.route.path,
    effectivePath: explanation.route.composition.effectivePath,
    composed: explanation.route.composition.composed,
    handlers: explanation.route.handlers.length,
  };

  return {
    route: summary,
    method: explanation.route.method,
    pathComposition: explanation.route.composition,
    chain,
    middleware,
    handler,
    controllers: roles.Controller,
    services: roles.Service,
    repositories: roles.Repository,
    middlewareRoles: roles.Middleware,
    dependencies: listing(reach),
    externalPackages: listing(externals),
    environmentVariables: listing(environmentVariables),
    impact: {
      directlyAffected: sum(linked, (step) => step.impact?.directlyAffected ?? 0),
      indirectlyAffected: sum(linked, (step) => step.impact?.indirectlyAffected ?? 0),
      unknown: sum(linked, (step) => step.impact?.unknown ?? 0),
      maxDepth: linked.reduce((deepest, step) => Math.max(deepest, step.impact?.maxDepth ?? 0), 0),
    },
    callGraph: {
      callers: sum(linked, (step) => step.explain?.incomingCalls.length ?? 0),
      callees: sum(linked, (step) => step.explain?.outgoingCalls.length ?? 0),
      reached: reach.length,
      maxDepth: reach.reduce((deepest, entry) => Math.max(deepest, entry.depth), 0),
      inCycle: linked.filter((step) => step.health?.inCycle === true).length,
    },
    health: {
      handlersLinked: linked.length,
      handlersUnlinked: explanation.unresolvedHandlers.length,
      isolatedHandlers: linked.filter((step) => step.health?.isolated === true).length,
      recursiveHandlers: linked.filter((step) => step.health?.recursive === true).length,
      findings: [...new Set(linked.flatMap((step) => step.health?.findings ?? []))].sort(),
    },
    unresolvedHandlers: explanation.unresolvedHandlers,
    limitations: limitationsOf(
      [
        'route-prefix-composition-unsupported',
        'route-handler-not-linked',
        'role-reach-follows-coupling',
        'roles-are-judgements',
        'call-coverage-partial',
        'capped-lists',
      ],
      {
        'route-prefix-composition-unsupported': explanation.route.composition.composed ? 0 : null,
        'route-handler-not-linked': explanation.unresolvedHandlers.length,
      },
    ),
  };
}

/** Every route the graph holds, as a summary. */
export function routeSummariesOf(context: NavigationContext): readonly RouteSummary[] {
  return context
    .query((queries) => queries.findRoutes())
    .flatMap((route) => {
      const node = context.node(route.node.id);

      return node === null
        ? []
        : [
            {
              route: treeRef(node),
              method: route.method,
              path: route.path,
              effectivePath: route.composition.effectivePath,
              composed: route.composition.composed,
              handlers: route.handlers.length,
            },
          ];
    });
}

/**
 * One link in the chain, with everything the repository records about its declaration.
 *
 * `browseSymbol` supplies the whole `ExplainSymbolResult` plus the impact and health summaries, so
 * this arranges rather than assembles.
 */
function stepOf(
  context: NavigationContext,
  entry: RouteHandlerResult,
  position: ChainPosition,
): HandlerStep {
  const declaration = entry.declaration;
  const view: SymbolView | null =
    declaration === null ? null : context.explore((explorer) => explorer.browseSymbol(declaration.id));

  return {
    position,
    ordinal: entry.edge.ordinal,
    declaration,
    explain: view?.explain ?? null,
    impact: view?.impact ?? null,
    health: view?.health ?? null,
  };
}

/**
 * Everything the chain reaches, by shortest distance.
 *
 * Reach comes from Repository Explorer's forward closure, which follows **coupling** — calls, imports
 * and type references together. A service imported but never called is therefore reported as reached,
 * which the `role-reach-follows-coupling` limitation states. Using calls alone would miss a
 * dependency wired by construction rather than by an immediate call, and the graph's call coverage is
 * itself partial.
 */
function reachFrom(context: NavigationContext, chain: readonly HandlerStep[]): readonly ReachedRef[] {
  const shortest = new Map<NodeId, ReachedRef>();

  for (const step of chain) {
    if (step.declaration === null) {
      continue;
    }

    const view = context.explore((explorer) => explorer.dependencies(step.declaration!.id));

    for (const reached of view?.indirect.forward.entries ?? []) {
      record(shortest, reached);
    }
  }

  return [...shortest.values()].sort(
    (left, right) => left.depth - right.depth || left.ref.id.localeCompare(right.ref.id),
  );
}

function record(into: Map<NodeId, ReachedRef>, reached: ReachedNode): void {
  const existing = into.get(reached.node.id);

  if (existing === undefined || reached.depth < existing.depth) {
    into.set(reached.node.id, { ref: treeRef(reached.node), depth: reached.depth });
  }
}

/** Declarations carrying each role, among everything the chain reaches. */
function rolesReached(
  context: NavigationContext,
  reach: readonly ReachedRef[],
): Readonly<Record<Role, readonly ReachedRef[]>> {
  const byRole = roleGroupsOf(context);
  const depthOf = new Map(reach.map((entry) => [entry.ref.id, entry.depth]));

  /**
   * The distance at which a role-bearing declaration is reached, or `null` when it is not.
   *
   * A role is annotated on a **container** — `UserRepository` is the Repository, not its `load`
   * method — while reach lands on whichever member the chain actually calls. So a container counts
   * as reached when any of its own members is, at that member's depth. Membership is read from the
   * frozen `sym:<path>#<chain>` identity: a member of `X` is exactly `X.` followed by more chain.
   */
  const depthOfRole = (id: NodeId): number | null => {
    const direct = depthOf.get(id);

    if (direct !== undefined) {
      return direct;
    }

    const prefix = `${id}.`;
    let shallowest: number | null = null;

    for (const entry of reach) {
      if (entry.ref.id.startsWith(prefix) && (shallowest === null || entry.depth < shallowest)) {
        shallowest = entry.depth;
      }
    }

    return shallowest;
  };

  const reached = (role: Role): readonly ReachedRef[] =>
    byRole[role]
      .map(treeRef)
      .flatMap((ref) => {
        const depth = depthOfRole(ref.id);

        return depth === null ? [] : [{ ref, depth }];
      })
      .sort((left, right) => left.depth - right.depth || left.ref.id.localeCompare(right.ref.id));

  // Written out rather than built with fromEntries, so the record is exhaustive by type: a new role
  // in the vocabulary becomes a compile error here instead of a silently missing group.
  return {
    Controller: reached('Controller'),
    Service: reached('Service'),
    Repository: reached('Repository'),
    Middleware: reached('Middleware'),
    Model: reached('Model'),
    Test: reached('Test'),
  };
}

/** External packages the files holding the chain import, from the file view. */
function externalsOf(context: NavigationContext, chain: readonly HandlerStep[]): readonly TreeRef[] {
  const seen = new Map<NodeId, TreeRef>();

  for (const step of chain) {
    const fileId = step.declaration?.fileId ?? null;

    if (fileId === null) {
      continue;
    }

    const file = context.explore((explorer) => explorer.browseFile(fileId));

    for (const external of file?.externalPackages.entries ?? []) {
      seen.set(external.id, treeRef(external));
    }
  }

  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Environment variables the route reads, directly or through anything it reaches.
 *
 * Reach-based, for the same reason `services` and `repositories` are: a route's configuration surface
 * is what its code ends up reading, and a handler that delegates to a service reading `JWT_SECRET`
 * does depend on that variable. The handlers' own reads come from Explain Symbol; the reached
 * declarations' come from their `READS` edges, which the shared cache has already fetched.
 */
function environmentVariablesOf(
  context: NavigationContext,
  chain: readonly HandlerStep[],
  reach: readonly ReachedRef[],
): readonly GraphNode[] {
  const seen = new Map<NodeId, GraphNode>();

  for (const step of chain) {
    for (const entry of step.explain?.environmentVariables ?? []) {
      seen.set(entry.node.id, entry.node);
    }
  }

  for (const reached of reach) {
    for (const read of context.graph.getOutgoing(reached.ref.id, 'READS')) {
      const variable = context.node(read.targetId);

      if (variable !== null) {
        seen.set(variable.id, variable);
      }
    }
  }

  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sum<T>(entries: readonly T[], measure: (entry: T) => number): number {
  return entries.reduce((total, entry) => total + measure(entry), 0);
}
