export { deriveFrom, metricOf, type Derived } from './derived.js';
export {
  connectedComponents,
  maxDepthFromRoots,
  stronglyConnectedComponents,
  type ClusterSummary,
} from './graph-algorithms.js';
export { REFERENCE_TYPES, buildGraphIndex, type Adjacency, type GraphIndex } from './graph-index.js';
export { LIMITATION_DETAIL } from './limitations.js';
export { RepositoryHealthAnalyzer } from './repository-health-analyzer.js';
export { MOST_CONNECTED_LIMIT, SAMPLE_LIMIT } from './sections.js';
export { distributionOf, ratio, round } from './statistics.js';
export {
  FINDING_CATEGORIES,
  FINDING_CODES,
  LIMITATION_CODES,
  type AnalysisStatistics,
  type ArchitectureReport,
  type CallGraphHealthReport,
  type CountedNodes,
  type Cycle,
  type DependencyHealthReport,
  type Distribution,
  type DuplicateRegistration,
  type EnvironmentReport,
  type ExternalUsage,
  type FindingCategory,
  type FindingCode,
  type FindingEvidence,
  type HandlerReuse,
  type HealthFinding,
  type HealthGraph,
  type Limitation,
  type LimitationCode,
  type NodeMetric,
  type RepositoryHealthReport,
  type RepositoryMetrics,
  type RepositorySummary,
  type RoutingReport,
  type VariableUsage,
} from './types.js';

// The only runtime dependencies are the Graph API read model and the shared vocabulary. No
// SQLite, no Graph Builder, no Graph Store, no Project Host, no parser — and no AI: nothing here
// predicts, scores, grades, ranks by judgement or generates language.
