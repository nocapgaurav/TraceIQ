export { QueryEngine } from './query-engine.js';
export { parseRouteId, type RouteIdentity } from './route-identity.js';
export type {
  CalleeResult,
  DeclarationResult,
  DependencyResult,
  EnclosingResult,
  EnvironmentVariableResult,
  PathComposition,
  ReferenceResult,
  RoleQueryResult,
  RouteExplanation,
  RouteHandlerResult,
  RouteResult,
  UnresolvedResult,
} from './types.js';

// The only dependency is RepositoryGraphApi. No SQL, no SQLite, no driver, no compiler
// and no graph internals appear here or in anything this package returns.
