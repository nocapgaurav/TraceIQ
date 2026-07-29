import { ts } from 'ts-morph';

export type CompilerOptions = ts.CompilerOptions;

/**
 * Compiler options used when a repository has no tsconfig.json.
 *
 * A repository can be scanned without one, and the Project Host still has to
 * produce a working type checker. These values are a deliberate, conservative
 * guess at a modern Node TypeScript project rather than an attempt to infer
 * configuration from the sources.
 *
 * Analysis quality on such a repository is necessarily lower: module resolution
 * in particular depends on settings only the repository can state. A tsconfig is
 * always preferred, and its options are used verbatim when present.
 */
export const DEFAULT_COMPILER_OPTIONS: Readonly<CompilerOptions> = Object.freeze({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  allowJs: false,
  skipLibCheck: true,
});

/**
 * Copies compiler options into a frozen object.
 *
 * The compiler's own options object is mutable and shared with the Program.
 * Handing it to a consumer would let one reach in and change how the checker
 * behaves, so what leaves this package is always a frozen copy.
 */
export function freezeCompilerOptions(options: CompilerOptions): Readonly<CompilerOptions> {
  return Object.freeze({ ...options });
}
