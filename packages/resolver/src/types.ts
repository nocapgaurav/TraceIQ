import type { RepositoryIRMetadata, SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId, RelationshipType } from '@traceiq/types';

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

/** Why a target lies outside the analysed source set. */
export const EXTERNAL_ORIGINS = [
  'package',
  'node-builtin',
  'typescript-lib',
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
       * The package name. `null` for a TypeScript built-in, which is declared
       * across several lib files and so is identified by `origin` alone.
       */
      readonly name: string | null;
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
