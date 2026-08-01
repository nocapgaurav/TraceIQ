import type { FrameworkAnnotations, HttpMethod, RouteAnnotation } from '@traceiq/framework';
import type { ImportIR, RepositoryIR } from '@traceiq/ir';

import type { DecoratorFact } from './extract.js';

const METHODS: Readonly<Record<string, HttpMethod>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
};

/** Modules whose presence makes a routing decorator credible. */
const ROUTING_PACKAGES = new Set(['fastapi', 'flask', 'starlette']);

/**
 * Reads FastAPI and Flask endpoints out of decorators.
 *
 * Both frameworks register a route the same way — a decorator on the handler naming the method and
 * the path — so one reader covers both:
 *
 * ```python
 * @app.get("/users/{id}")          # FastAPI
 * @router.post("/items")           # FastAPI, on an APIRouter
 * @app.route("/health", methods=["GET"])   # Flask
 * ```
 *
 * **The import is required.** A decorator called `.get(...)` proves nothing on its own — plenty of
 * libraries have one — so a route is only recorded when the module also imports FastAPI, Flask or
 * Starlette. That is weak evidence for *which* framework, and it is why every route here is
 * `INFERRED`: the decorator is certainly present, but that it registers an HTTP endpoint is a
 * reading of a convention rather than a proof.
 *
 * **Prefixes are not composed.** `APIRouter(prefix="/api")` and `app.include_router(...)` mean a
 * path recorded here can sit under a prefix, exactly as the Express extractor's paths can. The graph
 * records what the decorator says; inventing the composed path would need call-order reasoning this
 * analyser does not do.
 */
export function extractPythonRoutes(input: {
  readonly ir: RepositoryIR;
  readonly decorators: readonly DecoratorFact[];
  readonly imports: readonly ImportIR[];
}): FrameworkAnnotations {
  const routingFiles = new Set(
    input.imports
      .filter((statement) => ROUTING_PACKAGES.has(statement.moduleSpecifier.split('.')[0] ?? ''))
      .map((statement) => statement.fileId),
  );

  if (routingFiles.size === 0) {
    return { framework: null, roles: [], routes: [], environmentVariables: [], clientCalls: [] };
  }

  const fileByDeclaration = new Map(
    input.ir.declarations.map((declaration) => [declaration.id, declaration.fileId]),
  );

  const routes: RouteAnnotation[] = [];

  for (const decorator of input.decorators) {
    const file = fileByDeclaration.get(decorator.declarationId);

    if (file === undefined || !routingFiles.has(file)) {
      continue;
    }

    const parsed = readDecorator(decorator);

    if (parsed === null) {
      continue;
    }

    for (const method of parsed.methods) {
      routes.push({
        method,
        path: parsed.path,
        // Exactly one handler: the decorated function. Python's frameworks attach middleware
        // separately — FastAPI dependencies, Flask before_request — so a decorator chain is not a
        // handler chain and recording one would misdescribe it.
        handlers: [
          {
            text: decoratedName(input.ir, decorator.declarationId),
            ordinal: 0,
            declarationId: decorator.declarationId,
          },
        ],
        registeredInDeclarationId: null,
        confidence: 'INFERRED',
        provenance: {
          annotator: 'routes',
          fileId: file,
          evidence: `'@${decorator.text}' on a declaration in a module importing a Python web framework`,
        },
        location: decorator.location,
      });
    }
  }

  return {
    framework: null,
    roles: [],
    routes,
    environmentVariables: [],
    // Not extracted here: these analysers record no call arguments, so an outbound request has no
    // literal path to read. See `extractClientCalls`.
    clientCalls: [],
  };
}

/** `app.get("/users")` → GET /users; `app.route("/x", methods=["GET","POST"])` → both. */
function readDecorator(
  decorator: DecoratorFact,
): { readonly methods: readonly HttpMethod[]; readonly path: string } | null {
  const member = decorator.calleeText.split('.').at(-1)?.toLowerCase();

  if (member === undefined) {
    return null;
  }

  const path = firstStringArgument(decorator.text);

  if (path === null) {
    return null;
  }

  const direct = METHODS[member];

  if (direct !== undefined) {
    return { methods: [direct], path };
  }

  // Flask's `@app.route(...)`, whose methods are a keyword argument and default to GET.
  if (member === 'route') {
    const declared = /methods\s*=\s*\[([^\]]*)\]/.exec(decorator.text)?.[1];

    if (declared === undefined) {
      return { methods: ['GET'], path };
    }

    const methods = [...declared.matchAll(/["']([A-Za-z]+)["']/g)]
      .map((match) => METHODS[(match[1] ?? '').toLowerCase()])
      .filter((method): method is HttpMethod => method !== undefined);

    return methods.length === 0 ? null : { methods, path };
  }

  return null;
}

/** The decorated declaration's own name, which is the handler as a reader would name it. */
function decoratedName(ir: RepositoryIR, declarationId: string): string {
  return ir.declarations.find((declaration) => declaration.id === declarationId)?.name ?? '<handler>';
}

/**
 * The decorator's first **positional** argument, when that argument is a string literal.
 *
 * Anchored to the call's own opening parenthesis. Scanning for the first quoted string anywhere in
 * the text found one inside a keyword argument instead: `@hooks.route(methods=("POST",))` yielded
 * the path `"POST"`, which is not a path at all — and since `POST` does not begin with `/`, it then
 * failed the whole scan of any repository containing that line.
 *
 * A route whose path arrives by keyword — `@app.route(rule="/x")` — now yields nothing rather than
 * something wrong. Missing a rare registration is the better error of the two.
 */
function firstStringArgument(text: string): string | null {
  const open = text.indexOf('(');

  if (open === -1) {
    return null;
  }

  return /^\s*["']([^"']*)["']/.exec(text.slice(open + 1))?.[1] ?? null;
}
