import type { CallSiteIR, RepositoryIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';

import type { ExpressFacts, ExpressFileFacts } from './express-detection.js';
import type { HttpMethod, RouteAnnotation } from './types.js';

/**
 * Express method names that register a route, mapped to the HTTP method.
 *
 * `use` is deliberately absent: it mounts middleware or a sub-router and carries no
 * HTTP method, so it is not a route. It is read in the same pass, but only for the
 * middleware it names.
 */
const ROUTE_METHODS: Readonly<Record<string, HttpMethod>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
  all: 'ALL',
};

const MOUNT_METHOD = 'use';

export interface RouteExtraction {
  readonly routes: readonly RouteAnnotation[];
  /**
   * Declarations evidenced as middleware, by running ahead of a route's final handler
   * or by being mounted with `use`.
   *
   * Returned rather than annotated here: role extraction owns roles, and one annotator
   * deciding another's output would blur that.
   */
  readonly middlewareDeclarationIds: readonly NodeId[];
}

/**
 * Extracts Express route registrations and the middleware they name.
 *
 * A registration is a call whose member name is an HTTP method, whose root is a traced
 * router variable, and whose first argument is a string literal. All three come from the
 * IR; nothing is resolved.
 *
 * Requiring a traced root is what keeps this from matching every `foo.get(...)` in the
 * repository. It is also the main source of missed routes — see the package README.
 *
 * Routes and mounted middleware are found in one pass over each file's call sites,
 * because both need the same router-name check.
 */
export function extractRoutes(input: {
  readonly ir: RepositoryIR;
  readonly express: ExpressFacts;
}): RouteExtraction {
  const routes: RouteAnnotation[] = [];
  const middlewareDeclarationIds: NodeId[] = [];
  const topLevelIds = topLevelDeclarationIndex(input.ir);

  for (const [fileId, facts] of input.express.byFile) {
    for (const call of input.express.callSitesByFile.get(fileId) ?? []) {
      if (call.calleeRootName === null || call.calleeMemberName === null) {
        continue;
      }

      if (!facts.routerNames.has(call.calleeRootName)) {
        continue;
      }

      if (call.calleeMemberName === MOUNT_METHOD) {
        middlewareDeclarationIds.push(...mountedMiddleware(call, topLevelIds));
        continue;
      }

      const method = ROUTE_METHODS[call.calleeMemberName];

      if (method === undefined) {
        continue;
      }

      const route = routeOf({ call, method, facts, topLevelIds });

      if (route === null) {
        continue;
      }

      routes.push(route);

      // Every handler before the last runs ahead of the final one, which is what
      // middleware is. The last is the route's own handler.
      for (const handler of route.handlers.slice(0, -1)) {
        if (handler.declarationId !== null) {
          middlewareDeclarationIds.push(handler.declarationId);
        }
      }
    }
  }

  return { routes, middlewareDeclarationIds };
}

function routeOf(input: {
  readonly call: CallSiteIR;
  readonly method: HttpMethod;
  readonly facts: ExpressFileFacts;
  readonly topLevelIds: ReadonlyMap<string, NodeId>;
}): RouteAnnotation | null {
  const { call, method } = input;
  const [pathArgument, ...handlerArguments] = call.arguments;

  // Without a literal path there is no route to record. A computed path is a real
  // pattern, and it is reported as a limitation rather than guessed at.
  if (pathArgument === undefined || pathArgument.stringValue === null) {
    return null;
  }

  if (handlerArguments.length === 0) {
    return null;
  }

  const anchor = input.facts.resolverConfirmed
    ? `'${String(call.calleeRootName)}' is traced to a call on a binding from the express package`
    : `'${String(call.calleeRootName)}' is traced to a call on a binding from a module specified as 'express'`;

  return {
    method,
    path: pathArgument.stringValue,
    handlers: handlerArguments.map((argument, ordinal) => ({
      text: argument.text,
      ordinal,
      // Linked only where the IR already establishes it: a bare identifier naming a
      // top-level declaration in the same file. Anything else — `controller.login`, an
      // inline arrow — needs resolution, which this package does not perform.
      declarationId: input.topLevelIds.get(`${call.fileId}#${argument.text}`) ?? null,
    })),
    registeredInDeclarationId: call.enclosingDeclarationId,
    confidence: 'INFERRED',
    provenance: {
      annotator: 'routes',
      fileId: call.fileId,
      evidence: `'${call.calleeText}' registers a ${method} route: ${anchor}, and '${String(call.calleeMemberName)}' is an HTTP method`,
    },
    location: call.location,
  };
}

/**
 * The declarations a `use` call mounts.
 *
 * No route is produced: `use` has no HTTP method, and the path it may carry composes a
 * prefix onto routes registered elsewhere, which this milestone does not resolve.
 */
function mountedMiddleware(
  call: CallSiteIR,
  topLevelIds: ReadonlyMap<string, NodeId>,
): readonly NodeId[] {
  const found: NodeId[] = [];

  for (const argument of call.arguments) {
    // A string argument is the mount path, not a handler.
    if (argument.stringValue !== null) {
      continue;
    }

    const id = topLevelIds.get(`${call.fileId}#${argument.text}`);

    if (id !== undefined) {
      found.push(id);
    }
  }

  return found;
}

/** Top-level declarations keyed by `<fileId>#<name>`, for bare-identifier lookup. */
function topLevelDeclarationIndex(ir: RepositoryIR): ReadonlyMap<string, NodeId> {
  const index = new Map<string, NodeId>();

  for (const declaration of ir.declarations) {
    if (declaration.containerChain.length === 1) {
      index.set(`${declaration.fileId}#${declaration.name}`, declaration.id);
    }
  }

  return index;
}

export { ROUTE_METHODS };
