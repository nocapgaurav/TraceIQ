import type { SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

/**
 * The call graph.
 *
 * `CALLS` relationships bound from the IR's call sites and the Resolver's already-resolved
 * imports and exports. Only **static** calls: nothing here infers runtime dispatch,
 * follows inheritance, or reasons about dynamic invocation.
 */

/**
 * How a callee was bound. Each corresponds to one rule, and the rule that matched is
 * named in the provenance so a reader can check it.
 */
export const CALL_KINDS = [
  /** `helper()` — a top-level declaration in the same file. */
  'local',
  /** `helper()` — a name the file imports, already resolved by the Resolver. */
  'imported',
  /** `this.helper()` — a member of the class enclosing the call. */
  'this-member',
  /** `Service.make()` — a member of a class the root name resolves to. */
  'static-member',
  /** `ns.helper()` — an export of a module bound by a namespace import. */
  'namespace-member',
  /** `new Service()` — the constructor of the class the root names, or the class itself. */
  'construction',
  /** `svc.run()` — a member of the class a variable was constructed from. */
  'instance-member',
] as const;

export type CallKind = (typeof CALL_KINDS)[number];

export const UNRESOLVED_CALL_REASONS = [
  /** The callee is not rooted at an identifier: `getSvc().run()`, `(a ?? b)()`. */
  'callee-not-addressable',
  /** The root name matches no declaration, import or namespace binding in scope. */
  'root-not-bound',
  /**
   * The root resolves outside the analysed set — a package, a Node builtin, a TypeScript
   * built-in. There is correctly no repository declaration to call, so this is an
   * explanation rather than a failure.
   */
  'root-is-external',
  /** The root bound to a container, but it has no member of that name. */
  'member-not-found',
  /**
   * The root names a value — a variable, a parameter, a function result — so binding the
   * member would need its type. `svc.run()` where `const svc = new Service()`.
   */
  'root-type-unknown',
  /** `this.x()` outside any class, so there is no owner to look in. */
  'no-enclosing-container',
] as const;

export type UnresolvedCallReason = (typeof UNRESOLVED_CALL_REASONS)[number];

export interface CallProvenance {
  readonly producer: 'call-graph';
  /** The file the call is written in. */
  readonly fileId: NodeId;
  readonly evidence: string;
}

export interface CallRelationship {
  /** The declaration containing the call, or the file when it sits at module level. */
  readonly sourceId: NodeId;
  /** The declaration called. */
  readonly targetId: NodeId;
  readonly kind: CallKind;
  /** The callee exactly as written: `this.helper`, `Service.make`. */
  readonly calleeText: string;
  /**
   * Always `INFERRED`.
   *
   * This stage has no type checker: it binds names using the IR's syntax and the
   * Resolver's import and export targets. Every binding is therefore one plausible
   * reading rather than a proven one — a local of the same name could shadow the
   * declaration matched. Which rule fired is recorded in the provenance, where the
   * strength of the evidence belongs.
   */
  readonly confidence: ConfidenceLevel;
  readonly provenance: CallProvenance;
  readonly location: SourceRange;
  /** Set when one call site bound to several candidates; `null` otherwise. */
  readonly candidateGroup: string | null;
}

export interface UnresolvedCall {
  readonly sourceId: NodeId;
  readonly calleeText: string;
  readonly reason: UnresolvedCallReason;
  readonly provenance: CallProvenance;
  readonly location: SourceRange;
}

export interface CallGraph {
  readonly calls: readonly CallRelationship[];
  /** Call sites that could not be bound, kept visible rather than dropped. */
  readonly unresolved: readonly UnresolvedCall[];
}

export const EMPTY_CALL_GRAPH: CallGraph = { calls: [], unresolved: [] };
