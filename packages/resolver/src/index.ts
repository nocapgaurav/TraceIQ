export { Resolver } from './resolver.js';
export { DeclarationIndex } from './declaration-index.js';
export {
  classifyExternalFile,
  classifyUnresolvedSpecifier,
  packageNameFromSpecifier,
  type ExternalClassification,
  type SpecifierClassification,
} from './external-classification.js';
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
//
// `DeclarationIndex` and `classifyExternalFile` are exported despite being built for this
// package's own use, because correlating a compiler declaration back to an IR node — by
// absolute path, then by exact position — is not resolver-specific and a second copy would
// be a second chance to drift. Neither has a ts-morph type in its signature, so the rule
// above still holds: both speak in paths, positions and identifiers.
