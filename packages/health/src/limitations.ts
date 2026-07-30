import type { LimitationCode } from './types.js';

/**
 * Fixed text for each limitation code.
 *
 * A table, not composed strings: the same repository always produces the same words, a consumer
 * matches on `code` rather than parsing prose, and counts live in `affected`.
 */
export const LIMITATION_DETAIL: Readonly<Record<LimitationCode, string>> = {
  'call-coverage-partial':
    'the call graph binds names rather than symbols, so a callee containing another call produces no edge; every call-graph figure is a lower bound',
  'calls-are-inferred':
    'every CALLS edge is INFERRED, the call graph having no type checker, so a local of the same name could shadow the declaration matched',
  'no-interface-or-dynamic-dispatch':
    'an interface method call, a call through a variable and a call on a runtime-chosen receiver produce no edge, so call clusters and depth understate how the code actually connects',
  'unresolved-relationships-limit-analysis':
    'relationships the pipeline could not resolve are absent from the graph, so any count of references is a lower bound and any absence of references is weaker than it looks',
  'file-level-attribution':
    'a module-level call is attributed to its file rather than to a declaration, so files appear among callers and a declaration holding only top-level code shows no outgoing calls',
  'reference-absence-is-not-proof':
    'a declaration with no incoming reference is unreferenced in the graph, which is not the same as unused: dynamic access, a framework entry point and an unresolved reference all leave no edge',
  'property-references-not-recorded':
    'no relationship records a property or member access, so a class or interface property can never appear referenced however heavily it is used; property nodes dominate any count of unreferenced declarations',
  'duplicate-route-identities-collapse':
    'a route identity is METHOD and path, so two registrations of the same route become one node; a duplicate is visible only through two handler edges at one position',
  'route-prefixes-not-composed':
    'no mount information is recorded in the graph, so a route path is local to its router and may sit under a prefix',
  'roles-are-judgements':
    'an architectural role is an annotation carrying its own confidence, not proven syntax, so the architecture counts inherit that judgement',
  'no-history':
    'the graph holds one revision, so nothing here compares against a previous state and no trend can be reported',
  'capped-lists':
    'some lists carry at most a fixed number of entries; each reports its true count and sets truncated, so a cap is never silent',
};
