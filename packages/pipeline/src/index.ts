export { RepositoryPipeline } from './repository-pipeline.js';
export type { RepositorySession, ScanInput, ScanSummary } from './types.js';

// The write path and the only door onto a stored graph. It contains no analysis: every line
// delegates to a package that already exists. Consumers receive an abstract RepositoryGraphApi and
// never learn what implements it.
