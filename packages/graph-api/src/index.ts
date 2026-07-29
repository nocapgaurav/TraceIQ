export type { RepositoryGraphApi } from './graph-api.js';
export {
  DECLARATION_NODE_KINDS,
  EXTERNAL_ID_KINDS,
  NODE_KINDS,
  type ExternalIdKind,
  type GraphEdge,
  type GraphNode,
  type GraphProvenance,
  type GraphRole,
  type GraphUnresolvedReference,
  type NodeKind,
} from './types.js';

// No SQL, no driver type and no storage concept appears here. That is the point: a
// reader can depend on this package without SQLite entering its dependency tree.
