export { GO_ANALYZER, GoAnalyzer, preloadGoParser } from './go-analyzer.js';
export { extractSourceFile, isExportedName, type EmbeddingFact, type ReceiverFact, type SourceFileFacts, type TypeReferenceFact } from './extract.js';
export { extractGoFrameworks } from './frameworks.js';
export { buildPackageIndex, directoryOf, modulePathOf, type GoPackageIndex, type ModuleRoot, type PackageMember } from './package-index.js';
export { resolveGo, type FileInput } from './resolve.js';
export { isGoStandardLibrary } from './stdlib.js';
