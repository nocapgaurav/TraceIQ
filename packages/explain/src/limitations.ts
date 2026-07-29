import type { LimitationCode } from './types.js';

/**
 * The fixed text for each limitation code.
 *
 * A table rather than composed strings. Explain Symbol generates no language: it selects
 * from this table, so the same repository always produces the same words, and a consumer can
 * match on `code` instead of parsing prose.
 */
export const LIMITATION_DETAIL: Readonly<Record<LimitationCode, string>> = {
  'call-coverage-partial':
    'the call graph binds names rather than symbols, so a callee containing another call — new Service().run() — produces no edge; incoming and outgoing calls may be incomplete',
  'calls-are-inferred':
    'every CALLS edge is INFERRED, the call graph having no type checker, so a local of the same name could shadow the declaration matched',
  'no-transitive-reach':
    'incoming and outgoing calls are one step only; what eventually reaches this declaration needs recursive traversal, which no query performs',
  'unbound-calls-at-this-declaration':
    'this declaration makes calls the call graph could not bind, so its outgoing calls are narrower than the code',
  'ambiguous-relationships':
    'some relationships carry a candidate group, meaning more than one target was possible and none was chosen',
  'external-dependencies-are-file-scoped':
    'IMPORTS is recorded at a file, never at a declaration, so these externals are imported by the containing file and not necessarily used here',
  'route-prefixes-not-composed':
    'no mount information is recorded in the graph, so a route path is local to its router and may sit under a prefix',
  'roles-are-judgements':
    'an architectural role is an annotation with its own confidence, not proven syntax',
  'source-file-node-not-reachable':
    'the source file is reported as an identifier and path; no Query Engine operation returns a File node, a file not being a declaration',
};
