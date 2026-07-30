import type { LimitationCode } from './types.js';

/**
 * Fixed text for each limitation code.
 *
 * A table, not composed strings: the same repository always produces the same words, a consumer
 * matches on `code` rather than parsing prose, and counts live in `affected`. The explorer generates
 * no language.
 *
 * These are the explorer's **own** limitations. Those belonging to a reused capability travel with
 * its result — `SymbolView.explain.limitations` carries Explain Symbol's, and the health report
 * carries Repository Health's — so nothing is restated in two vocabularies.
 */
export const LIMITATION_DETAIL: Readonly<Record<LimitationCode, string>> = {
  'package-boundary-is-derived-from-paths':
    'the graph records no package boundary, so a package here is the first two segments of a file path and nothing more; a repository laid out differently will group differently',
  'cross-package-imports-resolve-outside-analysis':
    'an import of a sibling workspace package resolves through built output that the scanner does not read, so it targets an external rather than a file and no package-to-package dependency can be recovered from it',
  'call-cycles-may-include-false-self-recursion':
    'the call graph binds a multi-link this chain to the last member name on the enclosing container, so a method delegating to a field of the same name is recorded as calling itself and appears as a one-node cycle',
  'connected-component-spans-the-repository':
    'coupling is undirected here, so a repository whose modules all share a core reports one component covering most of it; the component says what is reachable, not what is cohesive',
  'capped-lists':
    'every list carries at most a fixed number of entries; each reports its true total and sets truncated, so a cap is never silent',
};
