// `COMPILER_ANALYZERS` used to be exported here. It held the TypeScript analyser alone, which made
// the registration list look shorter than it is — the grammar-backed analysers are added per scan by
// `defaultAnalyzersFor`, because each needs asynchronous preparation. No caller ever read it, and an
// export that misrepresents the analyser set is worse than no export.
export { EmptyRepositoryError, RepositoryPipeline } from './repository-pipeline.js';
export { assessCapabilities } from './capability-assessment.js';
export { buildTolerantly, GraphBuildError } from './tolerant-build.js';
export { TypeScriptAnalyzer, TYPESCRIPT_ANALYZER } from './typescript-analyzer.js';
export type { RepositorySession, ScanInput, ScanSummary } from './types.js';

// The write path and the only door onto a stored graph. It contains no analysis: every line
// delegates to a package that already exists. Consumers receive an abstract RepositoryGraphApi and
// never learn what implements it.
