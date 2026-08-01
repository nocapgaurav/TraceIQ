import type { RepositoryIRMetadata, SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, Ecosystem, NodeId, RelationshipType } from '@traceiq/types';

/**
 * The Resolver's output contract.
 *
 * The Resolver enriches facts; it does not organise them. Everything here is a
 * flat statement about one reference, carrying enough provenance to explain
 * itself. Grouping these into a graph is the Graph Builder's work.
 *
 * No ts-morph type appears in this file. A consumer works with plain objects.
 */

/**
 * The subset of the frozen relationship vocabulary this milestone produces.
 *
 * Written as an `Extract` of `RelationshipType` so a name that is not in the
 * contract fails to compile rather than quietly inventing vocabulary.
 */
export type ResolvedRelationshipType = Extract<
  RelationshipType,
  'IMPORTS' | 'EXPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'REFERENCES_TYPE'
>;

export const RESOLVED_RELATIONSHIP_TYPES: readonly ResolvedRelationshipType[] = [
  'IMPORTS',
  'EXPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'REFERENCES_TYPE',
];

/**
 * Why a target lies outside the analysed source set.
 *
 * **Named for what is true of every language, not for what was true of the first one.** These read
 * `node-builtin` and `typescript-lib` until a second and third analyser needed them: Python's `os`,
 * Java's `java.util` and Go's `net/http` are all the same kind of thing as Node's `fs`, and none of
 * them is a Node builtin. A vocabulary that spells one language's name cannot describe another's, so
 * every future analyser would have had to add a value here — which is the cost this milestone exists
 * to remove.
 */
export const EXTERNAL_ORIGINS = [
  /** A package from a dependency ecosystem. `ecosystem` on the target says which. */
  'package',
  /** A module the language's own standard library provides: `fs`, `os`, `java.util`, `net/http`. */
  'standard-library',
  /** A symbol the language itself provides: `Promise`, `String`, `error`. */
  'language-builtin',
  'outside-analysis',
] as const;

export type ExternalOrigin = (typeof EXTERNAL_ORIGINS)[number];

/**
 * What a reference points at.
 *
 * `external` is a successful resolution, not a failure: knowing that `express`
 * comes from a package is exactly what a consumer needs. Genuine failures are not
 * targets at all — they are recorded as `UnresolvedReference`.
 */
export type ResolutionTarget =
  | { readonly kind: 'declaration'; readonly declarationId: NodeId }
  | { readonly kind: 'file'; readonly fileId: NodeId }
  | {
      readonly kind: 'external';
      readonly origin: ExternalOrigin;
      /**
       * The package or module name. `null` for a language built-in, which may be declared across
       * several files and so is identified by `origin` alone.
       */
      readonly name: string | null;
      /**
       * Which ecosystem a `package` came from. `null` for every other origin.
       *
       * **This is what lets a non-JavaScript import become an external node at all.** Without it the
       * graph had one word for "a package" — `npm` — so `import fastapi` and
       * `import org.apache.commons.lang3` had nowhere to go and were dropped. A reader could see the
       * dependency a manifest *declared* and never the one a file actually *used*.
       */
      readonly ecosystem: Ecosystem | null;
    };

export const RESOLVERS = [
  'declarations',
  'imports',
  'exports',
  'heritage',
  'type-references',
] as const;

export type ResolverName = (typeof RESOLVERS)[number];

/**
 * Why a fact exists. Every inference must be explainable, and `evidence` is the
 * explanation in words a developer can read.
 */
export interface Provenance {
  readonly resolver: ResolverName;
  /** The file the reference appears in. */
  readonly fileId: NodeId;
  readonly evidence: string;
}

export interface ResolvedRelationship {
  readonly type: ResolvedRelationshipType;
  /** The declaration or file the reference is written in. */
  readonly sourceId: NodeId;
  readonly target: ResolutionTarget;
  /** The name being resolved: a binding, an exported name, a type name. */
  readonly name: string | null;
  /**
   * CERTAIN    established syntactically, with no resolution required
   * RESOLVED   the checker bound the reference to exactly one target
   * INFERRED   one plausible target from a heuristic, unconfirmed by the checker
   * AMBIGUOUS  several targets are plausible; every one is recorded
   */
  readonly confidence: ConfidenceLevel;
  readonly provenance: Provenance;
  readonly location: SourceRange;
  /**
   * Shared by every candidate of one ambiguous reference, and `null` otherwise.
   *
   * Ambiguity is never discarded: N candidates become N relationships that a
   * consumer can recognise as alternatives rather than as N independent facts.
   */
  readonly candidateGroup: string | null;
}

export const UNRESOLVED_REASONS = [
  'no-symbol',
  'no-declaration',
  'module-not-resolved',
  'declaration-not-in-ir',
  /**
   * The reference resolves to a type parameter. Resolution succeeded; there is
   * simply no addressable declaration, because the IR does not record type
   * parameters. Kept distinct so it is not mistaken for a resolution failure.
   */
  'type-parameter',
  /**
   * The type checker threw while being asked about this reference.
   *
   * Not the same as `no-symbol`, and the distinction is the point: `no-symbol` is
   * the checker answering "nothing here", while this is the checker failing to
   * answer at all. Conflating them would report a compiler fault as a property of
   * the source.
   *
   * Measured, not anticipated: resolving axios's re-exports crashes TypeScript's
   * own `getImmediateAliasedSymbol` on an alias it cannot follow, and that single
   * site used to cost the repository all 1,756 of its declarations.
   */
  'checker-failed',
  /**
   * The reference names a value that is not, and cannot be, a declaration.
   *
   * A sibling of `type-parameter`, and there for the same reason: resolution did not fail, there is
   * simply nothing addressable at the other end. `module.exports = { printWidth: 80 }` publishes a
   * name whose value is the number 80 — a real export, with no declaration behind it by
   * construction.
   *
   * Measured, not anticipated. Recording these as `no-symbol` put **410** of React's config-file
   * literals into the same bucket as genuine checker failures, which is precisely the confusion
   * `checker-failed` was added to prevent in the other direction.
   */
  'value-is-not-a-declaration',
] as const;

export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/**
 * A reference that exists in the source but could not be resolved.
 *
 * Kept separate from `ResolvedRelationship` rather than modelled as a null
 * target, because it has no target and therefore no honest confidence: the four
 * levels describe how much a resolution is trusted, and stretching one to mean
 * "failed" would make the vocabulary useless. Nothing is dropped — every failure
 * appears here with the reason and the text that could not be resolved.
 */
export interface UnresolvedReference {
  readonly type: ResolvedRelationshipType;
  readonly sourceId: NodeId;
  readonly name: string | null;
  readonly reason: UnresolvedReason;
  /** The unresolved text exactly as written. */
  readonly text: string;
  readonly provenance: Provenance;
  readonly location: SourceRange;
}

/**
 * Checker-confirmed facts about one IR declaration.
 *
 * Carries no confidence: these are observations, not resolutions of a reference.
 * `isExportedFromModule` is the enrichment the IR could not perform — it accounts
 * for `export { … }` statements, not only an inline `export` modifier.
 */
export interface ResolvedDeclaration {
  readonly declarationId: NodeId;
  /** False when the checker sees no symbol at the declaration, which is visible rather than dropped. */
  readonly hasSymbol: boolean;
  readonly isExportedFromModule: boolean;
  readonly provenance: Provenance;
}

export interface ResolvedRepository {
  /** Echoed from the IR, which is never modified. */
  readonly repository: RepositoryIRMetadata;
  readonly declarations: readonly ResolvedDeclaration[];
  readonly relationships: readonly ResolvedRelationship[];
  readonly unresolved: readonly UnresolvedReference[];
}
