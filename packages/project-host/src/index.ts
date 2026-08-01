export {
  DEFAULT_FILE_BUDGET,
  DEFAULT_WHOLE_PROGRAM_LIMIT,
  planAnalysisUnits,
  type AnalysisUnit,
} from './analysis-units.js';
export { DEFAULT_COMPILER_OPTIONS, type CompilerOptions } from './compiler-options.js';
export { ProjectContext, ProjectContextDisposedError } from './project-context.js';
export { ProjectHost, ProjectHostError } from './project-host.js';

/**
 * Re-exported so a consumer of a `ProjectContext` can type what it receives
 * without declaring a direct ts-morph dependency of its own.
 */
export type { SourceFile, TypeChecker } from 'ts-morph';
