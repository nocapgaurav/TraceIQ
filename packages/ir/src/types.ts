import type { NodeId } from '@traceiq/types';

/**
 * The TraceIQ Intermediate Representation.
 *
 * This file is the stable contract every later module consumes. It mentions no
 * TypeScript and no ts-morph type, so a second language means a second builder
 * rather than a change here.
 *
 * The IR is purely syntactic. It records what a repository *declares*, the import and
 * export statements connecting its files, and the call and member-access expressions
 * those declarations contain.
 *
 * It records nothing about what any of it *means*: no resolved targets, no types, no
 * relationships. A callee is text, not a binding. Resolution is the Resolver's work,
 * and keeping it out is what makes this layer cheap to produce and safe to cache.
 */

/**
 * Kinds of declaration the IR recognises.
 *
 * `accessor` covers both getters and setters. A `get x` / `set x` pair is one
 * accessor on the same symbol path, so splitting them into two kinds would put
 * two different kinds at one identifier.
 */
export const DECLARATION_KINDS = [
  'class',
  'interface',
  'type-alias',
  'enum',
  'enum-member',
  'function',
  'method',
  'property',
  'accessor',
  'constructor',
  'variable',
  'namespace',
] as const;

export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

export const VISIBILITIES = ['public', 'protected', 'private'] as const;

export type Visibility = (typeof VISIBILITIES)[number];

/** A 1-based, inclusive-start position range within a single file. */
export interface SourceRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * Syntactic modifiers. Every flag is always present, and `false` means either
 * "not modified" or "not applicable to this kind" — the IR does not distinguish
 * those, because no consumer has needed to.
 */
export interface DeclarationModifiers {
  readonly isExported: boolean;
  readonly isStatic: boolean;
  readonly isAbstract: boolean;
  readonly isReadonly: boolean;
  readonly isOptional: boolean;
  readonly isAsync: boolean;
}

export interface DeclarationIR {
  /** Stable identifier, `sym:<path>#<chain>`. Unique within a `RepositoryIR`. */
  readonly id: NodeId;

  /** The file declaring it. */
  readonly fileId: NodeId;

  readonly kind: DeclarationKind;

  /** The declared name. `'default'` for an anonymous default export. */
  readonly name: string;

  /** Containers outermost first, ending in `name`. Mirrors the identifier. */
  readonly containerChain: readonly string[];

  /** Set for class members; `null` where the language has no such concept. */
  readonly visibility: Visibility | null;

  readonly modifiers: DeclarationModifiers;

  /**
   * Every syntactic site in this file declaring this symbol path, in source
   * order. Never empty.
   *
   * Usually one. More than one when sites legitimately share a path: overload
   * signatures, a getter and setter pair, or a merged interface.
   */
  readonly locations: readonly SourceRange[];
}

export type ImportBindingKind = 'default' | 'named' | 'namespace';

export interface ImportBindingIR {
  readonly kind: ImportBindingKind;
  /** The name in the exporting module. `null` for a namespace import. */
  readonly importedName: string | null;
  /** The name bound in the importing file. */
  readonly localName: string;
  readonly isTypeOnly: boolean;
}

export interface ImportIR {
  readonly fileId: NodeId;
  /** Exactly as written. Unresolved — resolving it is the Resolver's work. */
  readonly moduleSpecifier: string;
  /** True for `import type { … }`, which applies to every binding. */
  readonly isTypeOnly: boolean;
  /** Empty for a side-effect-only import. */
  readonly bindings: readonly ImportBindingIR[];
  readonly location: SourceRange;
}

/**
 * `declaration`  an `export` modifier on a declaration in this file
 * `default`      `export default …`
 * `named`        `export { a }` or `export { a } from '…'`
 * `star`         `export * from '…'`
 * `star-as`      `export * as ns from '…'`
 * `equals`       `export = …`
 */
export type ExportKind = 'declaration' | 'default' | 'named' | 'star' | 'star-as' | 'equals';

export interface ExportIR {
  readonly fileId: NodeId;
  readonly kind: ExportKind;
  /** The name seen by importers. `null` for `star` and `equals`. */
  readonly exportedName: string | null;
  /** The local name being exported, when it is a plain identifier. */
  readonly localName: string | null;
  /** Set only for a re-export, exactly as written and unresolved. */
  readonly moduleSpecifier: string | null;
  /**
   * Set only when the exported thing is a declaration in this same file, which
   * is known syntactically. An `export { a }` referring to a local declaration
   * leaves this `null`: matching the two requires scope analysis, which is
   * resolution.
   */
  readonly declarationId: NodeId | null;
  readonly isTypeOnly: boolean;
  readonly location: SourceRange;
}

export interface CallArgumentIR {
  /** The argument expression exactly as written. */
  readonly text: string;
  /**
   * The value when the argument is a string literal, and `null` otherwise.
   *
   * This is what lets a consumer read a route path without parsing expression text.
   */
  readonly stringValue: string | null;
}

/**
 * An invocation.
 *
 * Recorded because a great deal of a repository's meaning lives in invocations rather than
 * declarations — route registration, dependency wiring, environment reads, object
 * construction. Nothing is resolved here: the callee is text, and binding it to a
 * declaration is a later concern.
 *
 * Unlike declarations, expressions *are* collected from inside function bodies, since
 * that is where invocations overwhelmingly appear.
 */
export interface CallSiteIR {
  readonly fileId: NodeId;
  /**
   * True when the invocation constructs an instance — `new Service()`.
   *
   * Modelled as a flag on an invocation rather than as a separate collection because
   * construction *is* a call: it has a callee, arguments and a position, and it invokes a
   * constructor. A consumer that ignores the flag still sees the invocation.
   */
  readonly isConstruction: boolean;
  /**
   * The recorded declaration whose body contains this call, or `null` when the call
   * sits at module level.
   */
  readonly enclosingDeclarationId: NodeId | null;
  /** The callee exactly as written: `router.post`, `expect`, `Object.keys`. */
  readonly calleeText: string;
  /** The root identifier of the callee, or `null` when it is not identifier-rooted. */
  readonly calleeRootName: string | null;
  /** The final property of a member callee, or `null` for a bare identifier call. */
  readonly calleeMemberName: string | null;
  readonly arguments: readonly CallArgumentIR[];
  readonly location: SourceRange;
}

/**
 * A property or element access chain rooted at an identifier, such as
 * `process.env.PORT`.
 *
 * Only outermost chains are recorded, and never one that is the callee of a call —
 * that is already a `CallSiteIR`. Chains rooted at `this`, at a call result or at any
 * other expression are not recorded, because they describe local structure rather than
 * a cross-cutting reference.
 */
export interface MemberAccessIR {
  readonly fileId: NodeId;
  readonly enclosingDeclarationId: NodeId | null;
  /** The chain exactly as written: `process.env.PORT`. */
  readonly text: string;
  /** The root identifier: `process`. */
  readonly rootName: string;
  /** The names after the root, outermost last: `['env', 'PORT']`. */
  readonly path: readonly string[];
  readonly location: SourceRange;
}

export interface FileIR {
  /** Stable identifier, `file:<path>`. */
  readonly id: NodeId;
  /** Repository-relative, POSIX-separated. */
  readonly path: string;
  readonly isDeclarationFile: boolean;
}

export interface RepositoryIRMetadata {
  /**
   * Derived from the root directory name.
   *
   * A `ProjectContext` does not carry the inventory's repository name, so this is
   * not necessarily the name in package.json.
   */
  readonly name: string;
  /** Absolute path to the repository root. */
  readonly rootPath: string;
}

/**
 * Declarations, imports and exports are flat collections rather than nested
 * inside files. Every entry carries its `fileId`, so grouping by file stays
 * possible while the common case — iterating every declaration in a repository —
 * needs no traversal.
 *
 * Ordering is deterministic: files in the order the `ProjectContext` listed them,
 * and within a file, source order.
 */
export interface RepositoryIR {
  readonly repository: RepositoryIRMetadata;
  readonly files: readonly FileIR[];
  readonly declarations: readonly DeclarationIR[];
  readonly imports: readonly ImportIR[];
  readonly exports: readonly ExportIR[];
  readonly callSites: readonly CallSiteIR[];
  readonly memberAccesses: readonly MemberAccessIR[];
}
