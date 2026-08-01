export { regionOf } from './technology-regions.js';
export { readDeclaredDependencies } from './declared-dependencies.js';
export { CONVENTIONAL_ENTRY_POINTS } from './entry-points.js';
export {
  FILE_ROLES,
  LANGUAGES,
  MANIFEST_ECOSYSTEMS,
  languageOf,
  manifestEcosystemOf,
  roleOf,
  type Ecosystem,
  type FileRole,
  type LanguageName,
} from './languages.js';
export { IGNORED_DIRECTORY_NAMES } from './ignore.js';
export { MalformedManifestError } from './manifest.js';
export { RepositoryScanError, RepositoryScanner } from './repository-scanner.js';
export type {
  DetectedFramework,
  DetectedLanguage,
  DetectedPackageManager,
  EntryPoint,
  EntryPointOrigin,
  Lockfile,
  PackageManagerName,
  LanguageCount,
  ManifestFile,
  RepositoryFile,
  RepositoryInventory,
  TechnologyRegion,
  WorkspacePackage,
} from './types.js';
export { PACKAGE_MANAGERS } from './types.js';
