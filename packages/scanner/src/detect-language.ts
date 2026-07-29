import type { DetectedLanguage } from './types.js';

/**
 * Version 1 recognises TypeScript only, so this reports whether the repository
 * is analysable rather than choosing between languages.
 *
 * A tsconfig.json alone is enough: a repository can legitimately be configured
 * for TypeScript before it has any sources, and reporting `'unknown'` there
 * would be wrong.
 */
export function detectLanguage(input: {
  readonly hasTsconfig: boolean;
  readonly sourceFileCount: number;
}): DetectedLanguage {
  return input.hasTsconfig || input.sourceFileCount > 0 ? 'typescript' : 'unknown';
}
