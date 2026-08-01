export { JAVA_ANALYZER, JavaAnalyzer, preloadJavaParser } from './java-analyzer.js';
export { extractCompilationUnit, type AnnotationFact, type CompilationUnitFacts, type HeritageFact, type TypeReferenceFact } from './extract.js';
export { extractJavaFrameworks } from './frameworks.js';
export { resolveJava, type UnitInput } from './resolve.js';
export { buildFileScope, buildTypeIndex, lookupType, type FileScope, type JavaTypeIndex, type TypeEntry } from './type-index.js';
export { isJavaLangType, isJavaStandardLibrary, javaPackageOf } from './stdlib.js';
