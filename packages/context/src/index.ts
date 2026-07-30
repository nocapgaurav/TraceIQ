export {
  EXPLAIN_LIMIT,
  RELATED_LIMIT,
  fileHealth,
  findingsNaming,
  mergeLimitations,
  relatedNodes,
  routesOf,
} from './builders.js';
export {
  CountingCapabilities,
  type ContextCapabilities,
  type ExplainCapability,
  type ExplorerCapability,
  type HealthCapability,
  type ImpactCapability,
  type QueryCapability,
} from './capabilities.js';
export { LIMITATION_DETAIL } from './limitations.js';
export { ContextNotFoundError, RepositoryContextBuilder } from './repository-context-builder.js';
export {
  CONTEXT_KINDS,
  LIMITATION_CODES,
  RELATIONS,
  type CalleeLike,
  type ContextDependencies,
  type ContextHealth,
  type ContextImpact,
  type ContextKind,
  type ContextPart,
  type ContextPrimary,
  type ContextProvenance,
  type ContextReferences,
  type ContextRequest,
  type ContextStatistics,
  type ImpactSummary,
  type Limitation,
  type LimitationCode,
  type ReferenceLike,
  type RelatedNode,
  type Relation,
  type RepositoryContext,
  type RepositorySubject,
  type SubjectHealth,
} from './types.js';

// The final composition layer. It decides WHAT context belongs together; every capability below already
// knows HOW to analyse. There is no RepositoryGraphApi, no store, no compiler, no filesystem and no HTTP
// anywhere in this package's surface — the boundary is enforced by the type, not by convention. Nothing
// here is generated: no prose, no markdown, no prompt, no summary in words, no ranking, no score.
