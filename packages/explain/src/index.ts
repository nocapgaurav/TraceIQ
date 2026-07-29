export { LIMITATION_DETAIL } from './limitations.js';
export { sourceFileOf } from './source-file.js';
export { SymbolExplainer } from './symbol-explainer.js';
export {
  LIMITATION_CODES,
  ROUTE_POSITIONS,
  UNRESOLVED_SCOPES,
  type EnvironmentVariableUse,
  type ExplainSymbolQueries,
  type ExplainSymbolResult,
  type ExternalDependencyUse,
  type Limitation,
  type LimitationCode,
  type ReachingRoute,
  type RoutePosition,
  type ScopedUnresolved,
  type SourceFileReference,
  type UnresolvedScope,
} from './types.js';

// The only runtime dependency is the Query Engine. No SQLite, no Graph Builder, no Graph
// Store, no Project Host — and no AI: nothing here summarises, ranks, scores or generates
// language. `ts-morph` sits in the installed closure only because @traceiq/graph-api takes
// SourceRange from @traceiq/ir; no file here imports it.
