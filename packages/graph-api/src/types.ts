import type { SourceRange } from '@traceiq/ir';
import { ECOSYSTEMS } from '@traceiq/types';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';

/**
 * The graph's read model.
 *
 * Defined here rather than in `@traceiq/graph` so that a reader — the Query Engine —
 * can depend on the model and the API without SQLite entering its dependency tree at
 * all. `@traceiq/graph` imports these same types for the write side, so there is one
 * definition, not two that can drift.
 */

/**
 * How deeply a technology region was actually analysed.
 *
 * The product's central honesty mechanism for a polyglot repository. Every region reaches
 * `universal`; only a language with an analyser reaches beyond it. A consumer reads this
 * to decide what it may claim — the alternative is showing an empty impact analysis for a
 * Python service and letting a reader conclude nothing depends on it.
 *
 * Ordered from least to most capable, and comparable by index.
 */
export const ANALYSIS_DEPTHS = ['universal', 'structural', 'semantic', 'framework'] as const;

export type AnalysisDepth = (typeof ANALYSIS_DEPTHS)[number];

/** True when `depth` is at least `required`. */
export function meetsDepth(depth: AnalysisDepth, required: AnalysisDepth): boolean {
  return ANALYSIS_DEPTHS.indexOf(depth) >= ANALYSIS_DEPTHS.indexOf(required);
}

/** How many files one language accounts for, within a region or a repository. */
export interface LanguageFileCount {
  readonly language: string;
  readonly files: number;
}

/**
 * One technology the repository is built from, and how far analysis got with it.
 *
 * A region is a directory anchored on a dependency manifest — `frontend/`, `backend/`,
 * `ml/` — or the repository root. It is deliberately *not* a graph node: a region
 * describes the analysis rather than the code, and making it a node would put it into
 * search results and traversals where a reader would not expect it.
 */
export interface RegionCapability {
  /** Repository-relative directory; `''` for the repository root. */
  readonly path: string;
  /** Dominant source language, or `null` for a documentation or configuration region. */
  readonly primaryLanguage: string | null;
  readonly languages: readonly LanguageFileCount[];
  readonly ecosystems: readonly string[];
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly depth: AnalysisDepth;
  /** Why analysis stopped where it did, in fixed words a consumer can show verbatim. */
  readonly reason: string;
}

/**
 * What this repository's graph can and cannot answer.
 *
 * Read before presenting anything that depends on semantic facts. The absence of an edge
 * means one of two very different things — analysed and none found, or never analysed —
 * and only this can tell them apart.
 */
export interface RepositoryCapabilities {
  /** The deepest analysis reached anywhere. `universal` when no analyser ran. */
  readonly depth: AnalysisDepth;
  /** Every region, sorted by path. Never empty for a repository containing files. */
  readonly regions: readonly RegionCapability[];
  /** Language totals across the repository, by file count descending. */
  readonly languages: readonly LanguageFileCount[];
  /** True when regions carry more than one distinct primary language. */
  readonly isPolyglot: boolean;
}

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
  /** A dependency or project manifest: package.json, pyproject.toml, go.mod. */
  'Manifest',
  /**
   * A dependency a manifest declares, by name.
   *
   * Distinct from `External`, and the distinction matters: an `External` is a target the
   * type checker *resolved* a reference to, while a `Dependency` is only a name a
   * manifest states. One is evidence of use, the other of intent, and merging them would
   * let a declared-but-unused package look like a used one.
   */
  'Dependency',
  /**
   * A technology the repository is built with, scoped to the region it was found in.
   *
   * A node rather than a capability row because it is a fact about the *software* rather than
   * about the analysis: that `apps/web` is a Next.js application is of the same kind as "this file
   * declares that class", and a reader searching `next` should find it. Regions stay out of the
   * graph for the opposite reason — they describe how deeply TraceIQ read a directory, which
   * belongs beside the code rather than in it.
   *
   * `externalKind` carries the category (`frontend`, `backend`, `infrastructure`, …) and
   * `externalName` the stable identifier, reusing the two columns that already exist for a node
   * whose identity is a name rather than a source position.
   */
  'Technology',
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

/**
 * The `kind` segment of an external identity.
 *
 * **Built from `ECOSYSTEMS` rather than listing packaging systems again.** Spec §5.2 wrote this as
 * `npm | node | builtin | outside-analysis`, which is the whole reason a Python, Java or Go import
 * could not become an external node: there was no identity for it to take. Composing the list means a
 * language arriving with a new packaging system extends one vocabulary, in `@traceiq/types`, and every
 * layer gains it at once.
 *
 * `node` and `stdlib` are both present and are not duplicates. `node` names Node's own library and is
 * the more specific claim; `stdlib` covers every other language's, whose module names — `java.util`,
 * `net/http`, `os` — are unambiguous by their own conventions.
 */
export const EXTERNAL_ID_KINDS = [
  ...ECOSYSTEMS,
  'node',
  'stdlib',
  'builtin',
  'outside-analysis',
] as const;

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
  /**
   * The language a `File` is written in, or `null` where none is recognised or the node
   * is not a file. Identified by extension, so it is evidence rather than proof.
   */
  readonly language: string | null;
  /**
   * What a `File` is for — source, test, documentation, configuration, manifest, build,
   * infrastructure — or `null` for a node that is not a file.
   */
  readonly fileRole: string | null;
  /**
   * What a `Technology` is for — `frontend`, `backend`, `infrastructure`, `build`, `testing`,
   * `data` — or `null` for every other kind.
   *
   * Its own column rather than a reuse of `externalKind`, which is a closed vocabulary of
   * packaging systems. Sharing them would mean a consumer filtering for npm packages had to know
   * that `'frontend'` can appear there too.
   */
  readonly category: string | null;
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
