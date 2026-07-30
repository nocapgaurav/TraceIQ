export { dependentsClosure, type DependentsClosure, type RouteReach } from './dependents-closure.js';
export { ImpactAnalyzer } from './impact-analyzer.js';
export { LIMITATION_DETAIL } from './limitations.js';
export {
  IMPACT_CATEGORIES,
  LIMITATION_CODES,
  UNKNOWN_SCOPES,
  type AffectedNode,
  type EnvironmentVariableImpact,
  type ExternalDependencyImpact,
  type ImpactAnalysisResult,
  type ImpactCategory,
  type ImpactQueries,
  type ImpactStatistics,
  type Limitation,
  type LimitationCode,
  type RouteImpact,
  type UnknownImpact,
  type UnknownScope,
} from './types.js';

// The only runtime dependency is the Query Engine. No SQLite, no Graph Builder, no Graph
// Store, no Project Host, no parser — and no AI: nothing here predicts, simulates, ranks,
// scores or generates language. `ts-morph` sits in the installed closure only because
// @traceiq/graph-api takes SourceRange from @traceiq/ir; no file here imports it.
