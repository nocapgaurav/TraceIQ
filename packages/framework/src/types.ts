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
  /** `express` when Express was detected, and `null` otherwise. */
  readonly framework: 'express' | null;
  readonly roles: readonly RoleAnnotation[];
  readonly routes: readonly RouteAnnotation[];
  readonly environmentVariables: readonly EnvironmentVariableAnnotation[];
}

export const NO_ANNOTATIONS: FrameworkAnnotations = {
  framework: null,
  roles: [],
  routes: [],
  environmentVariables: [],
};
