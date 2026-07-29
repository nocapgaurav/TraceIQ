export { CallGraphResolver } from './call-graph-resolver.js';
export {
  CALL_KINDS,
  EMPTY_CALL_GRAPH,
  UNRESOLVED_CALL_REASONS,
  type CallGraph,
  type CallKind,
  type CallProvenance,
  type CallRelationship,
  type UnresolvedCall,
  type UnresolvedCallReason,
} from './types.js';

// No compiler, no database, no graph. This stage reads two plain structures and returns
// a third.
