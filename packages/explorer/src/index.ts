export { CachingGraph } from './caching-graph.js';
export { ExplorerContext, packageOf, packageOfNode, type PackageIndex } from './explorer-context.js';
export { LIMITATION_DETAIL } from './limitations.js';
export { byId, listing, reachableFrom, reachedNodes } from './listing.js';
export { RepositoryExplorer } from './repository-explorer.js';
export { searchOf } from './search.js';
export {
  CYCLE_KINDS,
  LIMITATION_CODES,
  MATCH_MODES,
  RESULT_LIMIT,
  type ArchitectureSummary,
  type ArchitectureView,
  type Cycle,
  type CycleKind,
  type CycleReport,
  type DependencyView,
  type DirectDependencies,
  type FileStatistics,
  type FileView,
  type GraphSummary,
  type HealthSummary,
  type HotspotReport,
  type IndirectDependencies,
  type Limitation,
  type LimitationCode,
  type Listing,
  type MatchMode,
  type OperationProfile,
  type PackageEdge,
  type PackageSummary,
  type PackageView,
  type Profiled,
  type ReachedNode,
  type RepositoryOverview,
  type SearchQuery,
  type SearchResults,
  type SymbolHealthSummary,
  type SymbolImpactSummary,
  type SymbolView,
} from './types.js';

// Depends only on the Query Engine, Explain Symbol, Impact Analysis, Repository Health, the Graph
// API read model and the shared vocabulary. No SQLite, no Project Host, no Resolver, no Graph
// Builder, no ts-morph — and no AI: nothing here predicts, ranks, scores or generates language.
