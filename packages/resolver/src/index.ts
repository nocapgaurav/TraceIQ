export { Resolver } from './resolver.js';
export {
  EXTERNAL_ORIGINS,
  RESOLVED_RELATIONSHIP_TYPES,
  RESOLVERS,
  UNRESOLVED_REASONS,
  type ExternalOrigin,
  type Provenance,
  type ResolutionTarget,
  type ResolvedDeclaration,
  type ResolvedRelationship,
  type ResolvedRelationshipType,
  type ResolvedRepository,
  type ResolverName,
  type UnresolvedReason,
  type UnresolvedReference,
} from './types.js';

// No ts-morph value or type is re-exported. A consumer of a ResolvedRepository
// works with plain objects and cannot reach the compiler through this package.
