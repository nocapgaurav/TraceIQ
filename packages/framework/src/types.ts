import type { SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId, Role } from '@traceiq/types';

/**
 * The Framework Extractor's output.
 *
 * Everything here is an **annotation**: a claim about existing facts, carrying the
 * syntax it was read from. Nothing is a graph node, nothing is persisted, and the IR
 * and `ResolvedRepository` are never modified.
 *
 * Version 1 supports Express only. No framework abstraction is introduced — there is
 * no `Framework` interface and no plugin registry, because one framework cannot show
 * what the second would need.
 */

export const ANNOTATORS = ['roles', 'routes', 'environment'] as const;

export type AnnotatorName = (typeof ANNOTATORS)[number];

/** Why an annotation exists, in terms a developer can check against the source. */
export interface AnnotationProvenance {
  readonly annotator: AnnotatorName;
  /** The file the evidence was read from. */
  readonly fileId: NodeId;
  readonly evidence: string;
}

/**
 * An architectural role attributed to a declaration.
 *
 * Roles are annotations on declarations, never node types — that a class is a class is
 * proven syntax, that it is a Service is a judgement, and the two must not be merged.
 */
export interface RoleAnnotation {
  readonly declarationId: NodeId;
  readonly role: Role;
  readonly confidence: ConfidenceLevel;
  readonly provenance: AnnotationProvenance;
  readonly location: SourceRange;
}

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'ALL',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * One handler in a route's chain, as written.
 *
 * The expression text is kept rather than a resolved declaration: binding
 * `controller.login` to a method is resolution, and the Framework Extractor performs
 * none. `declarationId` is set only where the IR already established the link — a
 * bare identifier naming a declaration in the same file.
 */
export interface RouteHandlerAnnotation {
  /** The handler expression exactly as written: `controller.login`, `requireAuth`. */
  readonly text: string;
  /** Position in the chain, so middleware order survives. Zero-based. */
  readonly ordinal: number;
  /** Set only when the text is a bare identifier matching a declaration in the file. */
  readonly declarationId: NodeId | null;
}

export interface RouteAnnotation {
  readonly method: HttpMethod;
  /** The path exactly as written in the registration call. */
  readonly path: string;
  /** Every handler in the chain, in source order. Never empty. */
  readonly handlers: readonly RouteHandlerAnnotation[];
  /** The declaration containing the registration, or `null` at module level. */
  readonly registeredInDeclarationId: NodeId | null;
  readonly confidence: ConfidenceLevel;
  readonly provenance: AnnotationProvenance;
  readonly location: SourceRange;
}

/**
 * A read of `process.env`.
 *
 * One entry per read, not per variable: two reads of `PORT` are two entries with
 * different locations. The graph collapses them onto a single `env:PORT` node.
 */
export interface EnvironmentVariableAnnotation {
  /** The variable name: `PORT`. */
  readonly name: string;
  /** The declaration whose body or initializer reads it, or `null` at module level. */
  readonly usedInDeclarationId: NodeId | null;
  readonly confidence: ConfidenceLevel;
  readonly provenance: AnnotationProvenance;
  readonly location: SourceRange;
}

export interface FrameworkAnnotations {
  /**
   * The framework an analyser recognised, in that framework's own name, or `null`.
   *
   * **A free name rather than a closed set, and deliberately so.** This read `'express' | null` while
   * Express was the only extractor, which meant Spring, Flask, FastAPI, Gin and every framework after
   * them would each have had to widen a shared type — the cost this milestone exists to remove.
   * Frameworks proliferate faster than ecosystems do, so the vocabulary belongs to whichever analyser
   * recognised one.
   *
   * It is a label for a reader, never a key anything branches on: a consumer that changed behaviour
   * per framework would be putting framework knowledge outside the extractor that has the evidence.
   */
  readonly framework: string | null;
  readonly roles: readonly RoleAnnotation[];
  readonly routes: readonly RouteAnnotation[];
  readonly environmentVariables: readonly EnvironmentVariableAnnotation[];
  /**
   * HTTP requests this code *makes*, as opposed to the routes it serves.
   *
   * **This is the connective tissue of a polyglot repository.** A React application calling
   * `fetch('/api/users')` and a Flask service registering `@app.route('/api/users')` are one system
   * with a seam in the middle, and until both halves were recorded a repository read as a set of
   * language islands that happened to share a checkout. Routes were already extracted for every
   * language; this is the other end of the arrow.
   */
  readonly clientCalls: readonly ClientCallAnnotation[];
}

/**
 * One outbound HTTP request whose path the source states literally.
 *
 * Only a literal path is recorded. `fetch(url)` and `fetch(`${base}/users`)` name no endpoint a
 * reader could follow, and guessing at a template's shape would fabricate the very connection this
 * exists to establish honestly.
 */
export interface ClientCallAnnotation {
  /** The HTTP method when the call states one, else `null` — `fetch` defaults to GET but does not say so. */
  readonly method: HttpMethod | null;
  /** The path exactly as written, origin and query still attached. Normalisation happens at matching. */
  readonly path: string;
  /** The declaration the call sits in, or `null` at module level. */
  readonly calledFromDeclarationId: NodeId | null;
  readonly confidence: ConfidenceLevel;
  readonly provenance: AnnotationProvenance;
  readonly location: SourceRange;
}

export const NO_ANNOTATIONS: FrameworkAnnotations = {
  framework: null,
  roles: [],
  routes: [],
  environmentVariables: [],
  clientCalls: [],
};
