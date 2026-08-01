import type { FrameworkAnnotations, HttpMethod, RouteAnnotation } from '@traceiq/framework';
import type { RepositoryIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';

import type { GoPackageIndex } from './package-index.js';

/** A Go identifier and nothing else — no dot, no call, no parenthesis. */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Router method names, in the four Go web frameworks that share the shape.
 *
 * Gin, Echo, Fiber and `net/http`'s `ServeMux` all register a route by calling a method named after the
 * HTTP verb, or by calling `Handle`/`HandleFunc` with the method in the path. That shared shape is why
 * one reader covers all four rather than four readers covering one each.
 */
const VERB_METHODS: Readonly<Record<string, HttpMethod>> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

/** Import paths that make a router-shaped call credible. */
const WEB_MODULES = [
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gofiber/fiber',
  'net/http',
  'github.com/go-chi/chi',
  'github.com/gorilla/mux',
];

/**
 * Reads Go HTTP routes out of router registration calls.
 *
 * **The call is the evidence, and it is weaker than an annotation.** Java and Python mark a handler
 * declaratively, so the decorator or annotation *is* the registration. Go registers imperatively —
 * `r.GET("/users", listUsers)` — which means the reader must recognise a method name and a string
 * argument, and a method called `GET` on something unrelated looks identical. So a route is recorded
 * only when the file imports a web framework, and every route is `INFERRED`.
 *
 * **The handler is linked when Go's own rule proves it.** `r.GET("/users", listUsers)` names its
 * handler in an argument position, and `listUsers` is a package-level identifier — which in Go means
 * a declaration in this directory, exactly and with no search path. So a bare identifier argument is
 * looked up in the package index and bound where it is found. Anything else — a method value
 * `h.List`, a closure, a wrapped handler `mw(listUsers)` — is recorded by its text with no
 * declaration, because binding it would need the receiver's type or the wrapper's return, and a
 * wrong `HANDLED_BY` edge is worse than an unbound handler name.
 *
 * This was a stated limitation of the previous milestone. What changed is not the rule but the
 * input: `CallSiteIR.arguments` is populated for Go now, so the handler is visible at all.
 */
export function extractGoFrameworks(input: {
  readonly ir: RepositoryIR;
  readonly importsByFile: ReadonlyMap<NodeId, readonly string[]>;
  /** Every call site's text and location, which is where a registration shows up. */
  readonly callTexts: readonly {
    readonly fileId: NodeId;
    /** The registering file's directory, which in Go is its package. */
    readonly directory: string;
    readonly enclosingDeclarationId: NodeId | null;
    readonly memberName: string | null;
    readonly firstStringArgument: string | null;
    /** Argument expressions that are not string literals, in source order. */
    readonly handlerNames: readonly string[];
    readonly location: RouteAnnotation['location'];
  }[];
  /** Resolves a package-level name to the declaration its own package holds. */
  readonly index: Pick<GoPackageIndex, 'exported'>;
}): FrameworkAnnotations {
  const routes: RouteAnnotation[] = [];

  for (const call of input.callTexts) {
    if (call.memberName === null || call.firstStringArgument === null) {
      continue;
    }

    const method = VERB_METHODS[call.memberName];

    if (method === undefined) {
      continue;
    }

    const imports = input.importsByFile.get(call.fileId) ?? [];

    if (!imports.some((path) => WEB_MODULES.some((prefix) => path.startsWith(prefix)))) {
      continue;
    }

    const path = call.firstStringArgument;

    // A path that does not begin with `/` is not one Go's routers accept, and `routeId` would refuse
    // it. Skipping is honest: the call matched a verb name but registered no addressable endpoint.
    if (!path.startsWith('/')) {
      continue;
    }

    routes.push({
      method,
      path,
      handlers: call.handlerNames.map((text, ordinal) => ({
        text,
        ordinal,
        // A bare identifier is a package-level name, which in Go is this directory and nothing else.
        // A dotted or parenthesised expression is left unbound — see the note above.
        declarationId: BARE_IDENTIFIER.test(text)
          ? (input.index.exported(call.directory, text)[0] ?? null)
          : null,
      })),
      registeredInDeclarationId: call.enclosingDeclarationId,
      confidence: 'INFERRED',
      provenance: {
        annotator: 'routes',
        fileId: call.fileId,
        evidence: `a '.${call.memberName}("${path}", …)' call in a file importing a Go web framework`,
      },
      location: call.location,
    });
  }

  return {
    framework: routes.length > 0 ? 'go-http' : null,
    roles: [],
    routes,
    environmentVariables: [],
    // Not extracted here: these analysers record no call arguments, so an outbound request has no
    // literal path to read. See `extractClientCalls`.
    clientCalls: [],
  };
}
