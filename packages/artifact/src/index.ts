export { analyseArtifacts, type ArtifactInput } from './analyse.js';
export { basename, classify, envFile, type Classification } from './classify.js';
export {
  ARTIFACT_REFERENCE_KINDS,
  type Artifact,
  type ArtifactElement,
  type ArtifactReference,
  type ArtifactReferenceKind,
  type RepositoryArtifacts,
} from './types.js';
export { ELEMENT_LIMIT, READERS, type ReadInput, type ReadResult } from './readers.js';
export { REFERENCE_LIMIT, candidatesFor, environmentNames, invokedPaths } from './references.js';
export { documentCount, scanYaml, topLevelKeys, truncate, type YamlEntry } from './yaml-scan.js';

// The whole package is a pure function of a file inventory and a `readFile` callback. Nothing here opens a
// file, holds state between calls, or knows what a graph is — which is what lets the readers be exercised
// against a synthetic repository in memory, and what keeps a new format to one function and one table row.
