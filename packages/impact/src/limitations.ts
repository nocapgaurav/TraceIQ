import type { LimitationCode } from './types.js';

/**
 * The fixed text for each limitation code.
 *
 * A table, not composed strings. Impact analysis generates no language: it selects from this
 * table, so the same repository always produces the same words and a consumer can match on
 * `code` instead of parsing prose. Counts live in `affected`, never in the sentence.
 *
 * Deliberately its own vocabulary rather than shared with `@traceiq/explain`: the two
 * capabilities report different things, and one table serving both would grow codes that only
 * ever apply to one of them.
 */
export const LIMITATION_DETAIL: Readonly<Record<LimitationCode, string>> = {
  'call-coverage-partial':
    'the call graph binds names rather than symbols, so a callee containing another call — new Service().run() — produces no edge; the closure may be narrower than the code',
  'calls-are-inferred':
    'every CALLS edge is INFERRED, the call graph having no type checker, so a local of the same name could shadow the declaration matched',
  'no-interface-or-dynamic-dispatch':
    'an interface method call, a call through a variable and a call on a runtime-chosen receiver produce no edge at all, so nothing reached only that way can appear in this result even as UNKNOWN',
  'unresolved-relationships-in-closure':
    'relationships inside the closure could not be resolved, so the affected set may be wider than the edges show',
  'closure-may-miss-hidden-dependents':
    'unresolved references elsewhere in the repository could each have been an edge into this closure had they bound, so dependents may exist that no edge records; the count is repository-wide and cannot be attributed to this target without guessing',
  'file-level-unresolved-dominates':
    'most unresolved relationships reported here are recorded at a file rather than at an affected declaration, because a file joins the closure by importing the target and contributes its own unbound top-level calls',
  'ambiguous-relationships':
    'some relationships carry a candidate group, meaning more than one target was possible and none was chosen',
  'file-level-attribution':
    'a module-level call is attributed to its file rather than to a declaration, so a file appears among the affected nodes and the closure continues through it',
  'containment-not-followed':
    'DECLARES is not traversed, so changing a member does not report its class as affected; containment is not a dependency on the member',
  'external-dependencies-are-file-scoped':
    'IMPORTS is recorded at a file, never at a declaration, so these externals belong to files inside the closure and are not necessarily used by the affected declarations',
  'route-prefixes-not-composed':
    'no mount information is recorded in the graph, so a route path is local to its router and may sit under a prefix',
};
