import type { DetectedLanguage } from './types.js';

/**
 * Whether the TypeScript compiler has anything to read.
 *
 * **Not the repository's language** — `languages` and `regions` answer that, across every language
 * the scan recognises. This reports only whether the compiler-backed analyser has work, and it
 * counts JavaScript too, because the compiler reads `.js` natively under `allowJs`.
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
