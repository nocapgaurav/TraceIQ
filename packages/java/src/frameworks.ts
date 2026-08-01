import type { FrameworkAnnotations, HttpMethod, RoleAnnotation, RouteAnnotation } from '@traceiq/framework';
import type { DeclarationIR, RepositoryIR } from '@traceiq/ir';
import { fileId } from '@traceiq/shared';
import type { NodeId } from '@traceiq/types';

import type { AnnotationFact } from './extract.js';

/**
 * Spring's request-mapping annotations, each carrying the method it fixes.
 *
 * `RequestMapping` fixes none: it takes a `method = RequestMethod.GET` argument, and defaults to
 * accepting every method. It is handled separately for that reason.
 */
const METHOD_ANNOTATIONS: Readonly<Record<string, HttpMethod>> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
};

/** Jakarta REST's method annotations, which name the method and nothing else. */
const JAKARTA_METHODS: Readonly<Record<string, HttpMethod>> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
};

/** Stereotype annotations, mapped onto the graph's own role vocabulary. */
const ROLE_ANNOTATIONS: Readonly<Record<string, RoleAnnotation['role']>> = {
  RestController: 'Controller',
  Controller: 'Controller',
  Service: 'Service',
  Repository: 'Repository',
  Component: 'Service',
  Entity: 'Model',
  Configuration: 'Service',
};

/** Test annotations, which mark a declaration as a test wherever they appear. */
const TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory']);

/** Imports that make a routing annotation credible. */
const WEB_PACKAGES = ['org.springframework.web', 'jakarta.ws.rs', 'javax.ws.rs', 'org.springframework.stereotype'];

/**
 * Reads Spring and Jakarta endpoints, stereotype roles and tests out of annotations.
 *
 * **Annotations are how every Java framework marks its own, which makes them the only signal worth
 * reading — and a weak one on its own.** A class annotated `@Service` is a Spring bean *if* Spring is
 * on the classpath; the same name in an unrelated library means nothing. So a route is recorded only
 * when the file also imports a web framework, exactly as the Python reader requires a Flask or FastAPI
 * import. That is evidence for *which* framework rather than proof, and it is why every route here is
 * `INFERRED`.
 *
 * **Class and method paths are composed**, because Spring composes them and a reader looking for
 * `/api/users/{id}` would not find it otherwise. Composition is textual and stated: the class's
 * `@RequestMapping("/api/users")` joined to the method's `@GetMapping("/{id}")`. A path built from a
 * property placeholder — `@GetMapping("${api.base}/x")` — is recorded as written, because substituting
 * a value this analyser cannot read would be fabrication.
 */
export function extractJavaFrameworks(input: {
  readonly ir: RepositoryIR;
  readonly annotations: readonly AnnotationFact[];
  readonly importsByFile: ReadonlyMap<NodeId, readonly string[]>;
}): FrameworkAnnotations {
  const declarationById = new Map(input.ir.declarations.map((entry) => [entry.id, entry]));
  const pathByFileId = new Map(input.ir.files.map((file) => [file.id, file.path]));
  const byDeclaration = new Map<NodeId, AnnotationFact[]>();

  for (const annotation of input.annotations) {
    const bucket = byDeclaration.get(annotation.declarationId) ?? [];

    bucket.push(annotation);
    byDeclaration.set(annotation.declarationId, bucket);
  }

  /** Class-level base paths, so a method's path can be composed onto its controller's. */
  const basePathOf = new Map<NodeId, string>();
  const roles: RoleAnnotation[] = [];

  for (const [declarationId, applied] of byDeclaration) {
    const declaration = declarationById.get(declarationId);

    if (declaration === undefined) {
      continue;
    }

    for (const annotation of applied) {
      const role = ROLE_ANNOTATIONS[annotation.name];

      if (role !== undefined && isTypeKind(declaration.kind)) {
        roles.push({
          declarationId,
          role,
          confidence: 'INFERRED',
          provenance: {
            annotator: 'roles',
            fileId: declaration.fileId,
            evidence: `annotated '@${annotation.name}', which Spring uses to mark a ${role.toLowerCase()}`,
          },
          location: annotation.location,
        });
      }

      if (TEST_ANNOTATIONS.has(annotation.name)) {
        roles.push({
          declarationId,
          role: 'Test',
          confidence: 'INFERRED',
          provenance: {
            annotator: 'roles',
            fileId: declaration.fileId,
            evidence: `annotated '@${annotation.name}', a JUnit test annotation`,
          },
          location: annotation.location,
        });
      }

      if (isTypeKind(declaration.kind) && (annotation.name === 'RequestMapping' || annotation.name === 'Path')) {
        const base = firstStringArgument(annotation.text);

        if (base !== null) {
          basePathOf.set(declarationId, base);
        }
      }
    }
  }

  const routes: RouteAnnotation[] = [];

  for (const [declarationId, applied] of byDeclaration) {
    const declaration = declarationById.get(declarationId);

    if (declaration === undefined || declaration.kind !== 'method') {
      continue;
    }

    const file = declaration.fileId;
    const imports = input.importsByFile.get(file) ?? [];

    // Without a web framework import an annotation called `@GET` proves nothing.
    if (!imports.some((specifier) => WEB_PACKAGES.some((prefix) => specifier.startsWith(prefix)))) {
      continue;
    }

    const owner = ownerOf(declaration, declarationById, pathByFileId);
    const base = owner === null ? '' : (basePathOf.get(owner) ?? '');
    const methods = methodsOf(applied);

    if (methods.length === 0) {
      continue;
    }

    const own = pathOf(applied);
    const composed = joinPaths(base, own);

    for (const method of methods) {
      routes.push({
        method,
        path: composed,
        handlers: [{ text: declaration.name, ordinal: 0, declarationId }],
        registeredInDeclarationId: owner,
        confidence: 'INFERRED',
        provenance: {
          annotator: 'routes',
          fileId: file,
          evidence:
            base === ''
              ? `'@${applied.map((entry) => entry.name).join(', @')}' on a method in a file importing a Java web framework`
              : `'@${applied.map((entry) => entry.name).join(', @')}' composed onto the class path '${base}'`,
        },
        location: applied[0]?.location ?? { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      });
    }
  }

  void fileId;

  return {
    framework: routes.length > 0 ? 'spring' : null,
    roles,
    routes,
    environmentVariables: [],
    clientCalls: [],
  };
}

function isTypeKind(kind: DeclarationIR['kind']): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'enum';
}

/** The type a method belongs to, from its container chain. */
function ownerOf(
  declaration: DeclarationIR,
  declarationById: ReadonlyMap<NodeId, DeclarationIR>,
  pathByFileId: ReadonlyMap<NodeId, string>,
): NodeId | null {
  const path = pathByFileId.get(declaration.fileId);

  if (path === undefined || declaration.containerChain.length < 2) {
    return null;
  }

  const candidate = `sym:${path}#${declaration.containerChain.slice(0, -1).join('.')}` as NodeId;

  return declarationById.has(candidate) ? candidate : null;
}

/**
 * The HTTP methods a set of annotations fixes.
 *
 * A `@RequestMapping` with an explicit `method = RequestMethod.POST` is read; one without is *not*
 * turned into GET. Spring accepts every method there, and picking one would state something the source
 * does not.
 */
function methodsOf(applied: readonly AnnotationFact[]): readonly HttpMethod[] {
  const found = new Set<HttpMethod>();

  for (const annotation of applied) {
    const fixed = METHOD_ANNOTATIONS[annotation.name] ?? JAKARTA_METHODS[annotation.name];

    if (fixed !== undefined) {
      found.add(fixed);
      continue;
    }

    if (annotation.name !== 'RequestMapping') {
      continue;
    }

    for (const match of annotation.text.matchAll(/RequestMethod\s*\.\s*([A-Z]+)/g)) {
      const named = JAKARTA_METHODS[match[1] ?? ''];

      if (named !== undefined) {
        found.add(named);
      }
    }
  }

  return [...found].sort();
}

/** The path a method's annotations state, from `value =`, `path =`, or the first positional string. */
function pathOf(applied: readonly AnnotationFact[]): string {
  for (const annotation of applied) {
    const isRouting =
      METHOD_ANNOTATIONS[annotation.name] !== undefined ||
      JAKARTA_METHODS[annotation.name] !== undefined ||
      annotation.name === 'RequestMapping' ||
      annotation.name === 'Path';

    if (!isRouting) {
      continue;
    }

    const explicit = /(?:value|path)\s*=\s*"([^"]*)"/.exec(annotation.text)?.[1];

    if (explicit !== undefined) {
      return explicit;
    }

    const positional = firstStringArgument(annotation.text);

    if (positional !== null) {
      return positional;
    }
  }

  // A mapping with no path maps the class's own path, which is what Spring does.
  return '';
}

/**
 * The first string literal argument of an annotation, or `null`.
 *
 * Anchored to the annotation's own parenthesis, for the reason the Python reader is: scanning for the
 * first quoted string anywhere found one inside a keyword argument and read it as a path.
 */
function firstStringArgument(text: string): string | null {
  const open = text.indexOf('(');

  if (open === -1) {
    return null;
  }

  const rest = text.slice(open + 1);
  const positional = /^\s*"([^"]*)"/.exec(rest)?.[1];

  if (positional !== undefined) {
    return positional;
  }

  return /(?:value|path)\s*=\s*"([^"]*)"/.exec(rest)?.[1] ?? null;
}

/**
 * Joins a class base path to a method path.
 *
 * Both may be empty, may or may not have a leading slash, and may end in one. The result always begins
 * with `/` because `routeId` requires it — and a Spring path is absolute whatever the source wrote.
 */
function joinPaths(base: string, own: string): string {
  const segments = [...base.split('/'), ...own.split('/')].filter((segment) => segment.length > 0);

  return `/${segments.join('/')}`;
}
