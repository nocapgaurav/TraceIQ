import type { ConfidenceLevel, Ecosystem } from '@traceiq/types';

import type { ExternalOrigin, ResolutionTarget } from './types.js';

export interface ExternalClassification {
  readonly origin: ExternalOrigin;
  readonly name: string | null;
  /** `npm` for everything this classifier can see: it reads installed JavaScript paths. */
  readonly ecosystem: Ecosystem | null;
}

const NODE_MODULES = '/node_modules/';
const TYPESCRIPT_LIB = '/node_modules/typescript/lib/';
const LIB_DECLARATION_FILE = /(?:^|\/)(lib\.[a-z0-9.]*d\.ts)$/;

/**
 * Classifies a file that lies outside the analysed source set.
 *
 * TypeScript's own library files are separated from packages because they are not
 * dependencies of the repository, and treating `Promise` or `Array` as an
 * unresolved reference would bury genuine failures under thousands of them.
 */
export function classifyExternalFile(absolutePath: string): ExternalClassification {
  const normalized = absolutePath.replaceAll('\\', '/');

  if (normalized.includes(TYPESCRIPT_LIB) || LIB_DECLARATION_FILE.test(normalized)) {
    // The specific lib file is deliberately not recorded. A built-in such as
    // `Promise` is declared across several of them, so naming the file would make
    // one type look like five ambiguous candidates. `origin` carries the meaning.
    return { origin: 'language-builtin', name: null, ecosystem: null };
  }

  const packageName = packageNameFromPath(normalized);

  if (packageName !== null) {
    return { origin: 'package', name: packageName, ecosystem: 'npm' };
  }

  return { origin: 'outside-analysis', name: null, ecosystem: null };
}

/**
 * Reads the package name out of an installed path, taking the last
 * `node_modules` segment so a nested dependency is attributed to itself rather
 * than to whichever package happens to contain it.
 */
export function packageNameFromPath(normalizedPath: string): string | null {
  const lastIndex = normalizedPath.lastIndexOf(NODE_MODULES);

  if (lastIndex === -1) {
    return null;
  }

  const remainder = normalizedPath.slice(lastIndex + NODE_MODULES.length);

  return packageNameFromSpecifier(remainder);
}

/**
 * Reads the package name out of a module specifier, dropping any subpath.
 *
 * Returns `null` for a relative or absolute specifier, which names a file rather
 * than a package.
 */
export function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.length === 0 || specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }

  const segments = specifier.split('/').filter((segment) => segment.length > 0);
  const [first, second] = segments;

  if (first === undefined) {
    return null;
  }

  if (first.startsWith('@')) {
    return second === undefined ? null : `${first}/${second}`;
  }

  return first;
}

export interface SpecifierClassification {
  readonly target: ResolutionTarget;
  readonly confidence: ConfidenceLevel;
  readonly evidence: string;
}

const NODE_BUILTIN_PREFIX = 'node:';

/**
 * Classifies a module specifier that did not resolve to a file, or `null` when it
 * names a file and so is a genuine failure.
 *
 * Two very different certainties live here, and the confidence level separates
 * them. A `node:` specifier is CERTAIN: the prefix is reserved by Node, so the text
 * alone identifies a builtin, and TypeScript never resolves one to a file because
 * its types come from ambient declarations. A bare specifier that did not resolve is
 * only INFERRED — it is what an uninstalled dependency looks like, and the checker
 * confirmed nothing.
 */
export function classifyUnresolvedSpecifier(specifier: string): SpecifierClassification | null {
  if (specifier.startsWith(NODE_BUILTIN_PREFIX)) {
    return {
      target: { kind: 'external', origin: 'standard-library', name: specifier, ecosystem: 'npm' },
      confidence: 'CERTAIN',
      evidence: `'${specifier}' uses the reserved 'node:' prefix, which names a Node builtin`,
    };
  }

  const packageName = packageNameFromSpecifier(specifier);

  if (packageName === null) {
    return null;
  }

  return {
    target: { kind: 'external', origin: 'package', name: packageName, ecosystem: 'npm' },
    confidence: 'INFERRED',
    evidence: `'${specifier}' is a bare specifier naming package '${packageName}', which is not installed or did not resolve`,
  };
}
