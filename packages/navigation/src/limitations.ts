import type { LimitationCode } from './types.js';

/**
 * Fixed text for each limitation code.
 *
 * A table, not composed strings: the same repository always produces the same words and a consumer
 * matches on `code` rather than parsing prose. Counts live in `affected`.
 *
 * These are navigation's **own** limitations. A reused capability's limitations travel with its
 * result — a handler's on `HandlerStep.explain.limitations`, the explorer's on the views it
 * returns — so nothing is restated in two vocabularies.
 */
export const LIMITATION_DETAIL: Readonly<Record<LimitationCode, string>> = {
  'route-prefix-composition-unsupported':
    'no mount information reaches the graph, so a route path is local to its router and may sit under a prefix; the effective path is reported equal to the written path rather than guessed at',
  'route-handler-not-linked':
    'a handler written as a member expression or produced by a call could not be linked to a declaration, so the chain is shorter than the code registers',
  'role-reach-follows-coupling':
    'a role reached from a route is found by following coupling, which includes calls, imports and type references, so a service imported but never called is still reported as reached',
  'roles-are-judgements':
    'an architectural role is an annotation carrying its own confidence, not proven syntax, so every role grouping inherits that judgement',
  'call-coverage-partial':
    'the call graph binds names rather than symbols and records no interface or dynamic dispatch, so a chain, a closure and a cycle are all lower bounds',
  'package-boundary-is-derived-from-paths':
    'the graph records no package boundary, so a package is the first two segments of a file path and nothing more',
  'cross-package-imports-resolve-outside-analysis':
    'an import of a sibling workspace package resolves through built output the scanner does not read, so it targets an external and no package-to-package dependency can be recovered from it',
  'capped-lists':
    'every list carries at most a fixed number of entries; each reports its true total and sets truncated, so a cap is never silent',
};
