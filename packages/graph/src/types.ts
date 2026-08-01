import type { FrameworkAnnotations } from '@traceiq/framework';
import type { NodeId } from '@traceiq/types';

import type {
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  RepositoryCapabilities,
} from '@traceiq/graph-api';

/**
 * The write payload.
 *
 * The read model — nodes, edges, roles, unresolved references — lives in
 * `@traceiq/graph-api`, so writer and reader share one definition. Only the shape the
 * Graph Builder hands to the Graph Store is defined here.
 */

export type {
  ExternalIdKind,
  GraphEdge,
  GraphNode,
  GraphProvenance,
  GraphRole,
  GraphUnresolvedReference,
  NodeKind,
  AnalysisDepth,
  RegionCapability,
  RepositoryCapabilities,
} from '@traceiq/graph-api';
export {
  ANALYSIS_DEPTHS,
  DECLARATION_NODE_KINDS,
  EXTERNAL_ID_KINDS,
  NODE_KINDS,
  meetsDepth,
} from '@traceiq/graph-api';
export type { FrameworkAnnotations } from '@traceiq/framework';

/** Annotations from a repository where no Framework Extractor has run. */
export const NO_FRAMEWORK_ANNOTATIONS: FrameworkAnnotations = {
  framework: null,
  roles: [],
  routes: [],
  environmentVariables: [], clientCalls: [],
};

export interface RepositoryGraph {
  readonly repository: { readonly name: string; readonly rootPath: string };
  /** Fixed placeholder in version 1. Spec §8.3. */
  readonly revisionId: number;
  /** Repository-relative paths, one per file, for `file_revisions`. */
  readonly fileIds: readonly NodeId[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly GraphUnresolvedReference[];
  readonly roles: readonly GraphRole[];
  /**
   * What this graph can answer, by technology region.
   *
   * Part of the graph rather than derived from it, because depth is decided by which
   * analysers *ran* — a fact only the pipeline holds. Nothing in the stored nodes and
   * edges could distinguish a region analysed and found to have no calls from one whose
   * calls were never looked at.
   */
  readonly capabilities: RepositoryCapabilities;
}
