export { GraphBuilder, PLACEHOLDER_REVISION_ID } from './graph-builder.js';
export { GraphConstraintError, ENDPOINT_RULES } from './constraints.js';
export { GraphStore, GraphStoreError } from './graph-store.js';
export { GraphApiError, SqliteGraphApi } from './sqlite-graph-api.js';
export { SCHEMA_VERSION } from './schema.js';
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
