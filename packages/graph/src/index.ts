export { GraphBuilder, PLACEHOLDER_REVISION_ID } from './graph-builder.js';
export { GraphConstraintError, ENDPOINT_RULES } from './constraints.js';
export { GraphStore, GraphStoreError } from './graph-store.js';
export { GraphApiError, SqliteGraphApi } from './sqlite-graph-api.js';
export { SCHEMA_VERSION } from './schema.js';
export type { RepositoryAnalysis } from './graph-builder.js';
// The build's own input type. Exported so a composition root can name the value it assembles rather
// than rely on the shape being inferred at the call site.
export type { UniversalFacts, UniversalFile, UniversalManifest } from './universal-facts.js';
export {
  DEPTH_REASON,
  NO_ANALYSER_REASON,
  NO_CAPABILITIES,
  NO_SOURCE_REASON,
  TYPESCRIPT_FRAMEWORK_REASON,
  TYPESCRIPT_REASON,
  summariseCapabilities,
} from './capabilities.js';
export {
  DECLARATION_NODE_KINDS,
  EXTERNAL_ID_KINDS,
  NODE_KINDS,
  NO_FRAMEWORK_ANNOTATIONS,
  type ExternalIdKind,
  type FrameworkAnnotations,
  type GraphEdge,
  type GraphNode,
  type GraphProvenance,
  type GraphRole,
  type GraphUnresolvedReference,
  type NodeKind,
  type RepositoryGraph,
} from './types.js';

// No SQL and no better-sqlite3 type is exported. A consumer receives plain data and
// cannot reach the database through this package.
