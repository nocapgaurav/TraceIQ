export { CallGraphResolver } from './call-graph-resolver.js';
export {
  CALL_KINDS,
  EMPTY_CALL_GRAPH,
  UNRESOLVED_CALL_REASONS,
  type CallGraph,
  type CallKind,
  type CallProvenance,
  type CallRelationship,
  type ExternalCall,
  type UnresolvedCall,
  type UnresolvedCallReason,
} from './types.js';

// No database and no graph. The stage reads two plain structures and returns a third; it
// additionally borrows a `ProjectContext` when one is offered, so that a call can be bound
// to the declaration the type checker resolves rather than to one matching by name. The
// context is never retained, and no ts-morph type appears in what this package returns.
