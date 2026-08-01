import type { SourceRange } from '@traceiq/ir';
import type { ExternalOrigin } from '@traceiq/resolver';
import type { ConfidenceLevel, Ecosystem, NodeId } from '@traceiq/types';

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
  /**
   * The type checker resolved the call's signature to this declaration.
   *
   * Not a shape of callee but a source of evidence, and the only kind carrying
   * `RESOLVED`. It supersedes every rule below when a `ProjectContext` is available,
   * because it reports the declaration the compiler would invoke rather than one that
   * matches by name.
   */
  'checked',
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
  /**
   * The checker resolved the callee to a TypeScript library declaration: `JSON.stringify`,
   * `Map`, `Object.keys`.
   *
   * Not a failure. The repository did not choose the language it is written in, so this is
   * deliberately not recorded as a dependency — an edge per `map` call would bury the
   * packages the repository *did* choose.
   */
  'callee-is-language-builtin',
  /**
   * The checker resolved the callee to a file outside the analysed set from which no
   * package name could be recovered, so there is nothing nameable to point at.
   */
  'callee-outside-analysis',
] as const;

export type UnresolvedCallReason = (typeof UNRESOLVED_CALL_REASONS)[number];

export interface CallProvenance {
  /**
   * The analyser that bound the call.
   *
   * `'call-graph'` for the compiler-backed TypeScript and JavaScript path; a language analyser's own
   * name — `'python'` — for the rest. Widened from a single literal when TraceIQ gained more than
   * one analyser: a reader tracing a surprising edge needs to know which analyser produced it, and
   * every one of them reasons differently.
   */
  readonly producer: string;
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
   * `RESOLVED` for a `checked` binding, `INFERRED` for every other kind.
   *
   * The distinction is the whole point of having two tiers. A `checked` binding is the
   * declaration the type checker itself resolved the call's signature to. Every other
   * binding matched a name using the IR's syntax and the Resolver's import and export
   * targets, which is one plausible reading rather than a proven one — a local of the
   * same name could shadow the declaration matched.
   *
   * Which rule fired is recorded in the provenance, where the strength of the evidence
   * belongs.
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

/**
 * A call whose callee is declared outside the analysed set.
 *
 * Modelled apart from `CallRelationship` because it is a different fact. A `CallRelationship`
 * names a declaration in this repository and can be traversed to; this names a boundary —
 * a package, a standard-library module, a language built-in — and traversal stops there.
 * Collapsing the two would mean a consumer walking the call graph had to check, at every
 * step, whether the thing it reached was really part of the repository.
 *
 * The target's identity is deliberately *not* minted here. Naming an external node is the
 * Graph Builder's job and it already does it for imports; a second implementation would be
 * a second chance for `ext:npm:express` and `ext:npm:Express` to both exist.
 */
export interface ExternalCall {
  /** The declaration containing the call, or the file when it sits at module level. */
  readonly sourceId: NodeId;
  /** Where the callee is declared, classified the same way the Resolver classifies imports. */
  readonly origin: ExternalOrigin;
  /** The package or module name, or `null` when none is recoverable. */
  readonly name: string | null;
  /** Which ecosystem a `package` origin came from, so the identity can name it. */
  readonly ecosystem: Ecosystem | null;
  readonly calleeText: string;
  /**
   * `RESOLVED` when the checker resolved the call's signature to a declaration that happened
   * to sit outside the analysed set; `INFERRED` when a name rule recognised the callee's root
   * as a name the file imports from that dependency.
   *
   * Both are real facts and the second is not the weaker sibling of the first by accident:
   * an import statement proves where the name came from and nothing more, so a local
   * rebinding of that name would defeat the rule. It is still the strongest evidence
   * available in a repository whose dependencies are not installed, and in a language whose
   * analyser has no type checker at all — which is four of the five TraceIQ supports.
   */
  readonly confidence: ConfidenceLevel;
  readonly provenance: CallProvenance;
  readonly location: SourceRange;
}

export interface CallGraph {
  readonly calls: readonly CallRelationship[];
  /**
   * Calls leaving the repository, bound to the package or builtin that declares the callee.
   *
   * Two rules produce these. The checker tier types the receiver, so it can say that
   * `db.prepare()` lands in `better-sqlite3` without the source naming it. The name rules
   * cannot do that, but they can read the import statement: a call rooted at a name the file
   * imported from a package is a call into that package, whether or not the package is
   * installed. Every language analyser applies the second rule; only TypeScript and
   * JavaScript have the first.
   */
  readonly externalCalls: readonly ExternalCall[];
  /** Call sites that could not be bound, kept visible rather than dropped. */
  readonly unresolved: readonly UnresolvedCall[];
}

export const EMPTY_CALL_GRAPH: CallGraph = { calls: [], externalCalls: [], unresolved: [] };
