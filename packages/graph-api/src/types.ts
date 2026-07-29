import type { SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

/**
 * The graph's read model.
 *
 * Defined here rather than in `@traceiq/graph` so that a reader — the Query Engine —
 * can depend on the model and the API without SQLite entering its dependency tree at
 * all. `@traceiq/graph` imports these same types for the write side, so there is one
 * definition, not two that can drift.
 */

export const NODE_KINDS = [
  'File',
  'Class',
  'Interface',
  'TypeAlias',
  'Enum',
  'EnumMember',
  'Function',
  'Method',
  'Property',
  'Accessor',
  'Constructor',
  'Variable',
  'Namespace',
  'Route',
  'EnvironmentVariable',
  'External',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/** Node kinds that come from an IR declaration, as opposed to a file or an external. */
export const DECLARATION_NODE_KINDS: readonly NodeKind[] = [
  'Class',
  'Interface',
  'TypeAlias',
  'Enum',
  'EnumMember',
  'Function',
  'Method',
  'Property',
  'Accessor',
  'Constructor',
  'Variable',
  'Namespace',
];

/** Spec §5.2. The `kind` segment of an external identity. */
export const EXTERNAL_ID_KINDS = ['npm', 'node', 'builtin', 'outside-analysis'] as const;

export type ExternalIdKind = (typeof EXTERNAL_ID_KINDS)[number];

export interface GraphProvenance {
  /** The module that produced the fact. */
  readonly producer: string;
  /** The file whose syntax produced it. `null` only where no file applies. */
  readonly fileId: NodeId | null;
  readonly evidence: string;
}

export interface GraphNode {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  readonly fileId: NodeId | null;
  readonly containerChain: string | null;
  readonly visibility: 'public' | 'protected' | 'private' | null;
  readonly isExported: boolean;
  readonly isStatic: boolean;
  readonly isAbstract: boolean;
  readonly isReadonly: boolean;
  readonly isOptional: boolean;
  readonly isAsync: boolean;
  readonly isDeclarationFile: boolean | null;
  /** `null` means not established, never false. Spec §3.1. */
  readonly hasSymbol: boolean | null;
  readonly isExportedFromModule: boolean | null;
  readonly externalKind: ExternalIdKind | null;
  readonly externalName: string | null;
  readonly confidence: ConfidenceLevel;
  readonly provenance: GraphProvenance;
  /** Empty for `File` and `External`. Spec §3. */
  readonly locations: readonly SourceRange[];
}

export interface GraphEdge {
  readonly id: string;
  readonly type: RelationshipType;
  readonly sourceId: NodeId;
  readonly targetId: NodeId;
  readonly name: string | null;
  readonly confidence: ConfidenceLevel;
  readonly candidateGroup: string | null;
  /** Reserved; always `null` in version 1. Spec §4. */
  readonly ordinal: number | null;
  readonly provenance: GraphProvenance;
  readonly location: SourceRange;
}

export interface GraphUnresolvedReference {
  readonly id: string;
  readonly type: RelationshipType;
  readonly sourceId: NodeId;
  readonly name: string | null;
  readonly reason: string;
  readonly text: string;
  readonly provenance: GraphProvenance;
  readonly location: SourceRange;
}

export interface GraphRole {
  readonly nodeId: NodeId;
  readonly role: Role;
  readonly confidence: ConfidenceLevel;
  readonly evidence: string;
}

/**
 * Annotations decided by the Framework Extractor and translated here.
 *
 * Empty in version 1: no Framework Extractor exists. It is an input rather than a
 * second writer, so the Graph Builder stays the only module that writes the graph
 * (spec §8.8).
 *
 * `Route` nodes are reserved by spec §1.3 and are deliberately absent — adding them
 * means extending this input, not changing the schema.
 */
