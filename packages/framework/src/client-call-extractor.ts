import type { CallSiteIR, RepositoryIR } from '@traceiq/ir';

import type { ClientCallAnnotation, HttpMethod } from './types.js';

/**
 * HTTP client libraries whose call shape is `client.method(path, …)`.
 *
 * Matched on the *member* name rather than on the receiver, because the receiver is a value whose
 * name the author chose — `api.get(…)`, `http.get(…)`, `client.get(…)` are the same call. The verb
 * plus a path-shaped first argument is what makes it a request; a receiver named `api` proves
 * nothing on its own and `cache.get('user')` must not be read as an endpoint.
 */
const VERB_MEMBERS: Readonly<Record<string, HttpMethod>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
};

/** Bare functions that take the path as their first argument and state no method. */
const BARE_CLIENTS = new Set(['fetch', 'axios', 'request', 'ky', 'got', 'superagent']);

/**
 * Reads the HTTP requests a repository's code *makes*.
 *
 * **The other end of the route arrow.** Route extraction has covered every supported language for
 * two milestones; nothing recorded who *calls* those routes, so a repository whose React frontend
 * talks to its Flask backend was two disconnected graphs. This closes it with the same discipline
 * routes are extracted with: a literal path or nothing.
 *
 * Three shapes, and each needs a path-shaped literal in argument position:
 *
 * ```ts
 * fetch('/api/users')                    // no method stated; recorded as null, not guessed as GET
 * api.get('/api/users')                  // a verb member on any receiver
 * axios.post('/api/users', body)         // the same, with a body the reader does not need
 * ```
 *
 * **A template literal is deliberately skipped.** `fetch(`${base}/users/${id}`)` names an endpoint
 * that depends on values this reader cannot know, and inventing `/users/` from it would fabricate
 * the very connection the feature exists to establish honestly. The call is simply not recorded.
 */
export function extractClientCalls(ir: RepositoryIR): readonly ClientCallAnnotation[] {
  const found: ClientCallAnnotation[] = [];

  for (const site of ir.callSites) {
    const path = pathArgumentOf(site);

    if (path === null) {
      continue;
    }

    const method = methodOf(site);

    if (method === undefined) {
      continue;
    }

    found.push({
      method,
      path,
      calledFromDeclarationId: site.enclosingDeclarationId,
      // Never proven. The path is a literal and the callee looks like a client, but nothing
      // resolved the receiver to an HTTP library — and a `cache.get('/tmp/x')` would look the same.
      confidence: 'INFERRED',
      provenance: {
        annotator: 'routes',
        fileId: site.fileId,
        evidence: `'${site.calleeText}' is called with the literal path '${path}', which reads as an outbound HTTP request`,
      },
      location: site.location,
    });
  }

  return found;
}

/**
 * The HTTP method this call states, `null` when it is a method-less client, or `undefined` when the
 * callee is not a client call at all.
 *
 * Three outcomes rather than two because "states no method" and "is not a request" are different
 * facts, and `fetch('/api/users')` is the first: it defaults to GET at runtime and says nothing in
 * the source, so recording GET would be reading a specification rather than the code.
 */
function methodOf(site: CallSiteIR): HttpMethod | null | undefined {
  if (site.calleeMemberName === null) {
    if (site.calleeRootName === null || !BARE_CLIENTS.has(site.calleeRootName)) {
      return undefined;
    }

    // `fetch('/users/42', { method: 'DELETE' })` *does* state its method — in the options object,
    // where the callee shape cannot show it. Reading it matters for correctness rather than
    // completeness: a method-less call matches any route on the path, so missing the `DELETE` here
    // linked a deletion to a GET endpoint and asserted traffic that never happens.
    return optionsMethodOf(site) ?? null;
  }

  // `axios.get(…)` and `api.get(…)` alike. The receiver is not checked — see `VERB_MEMBERS`.
  return VERB_MEMBERS[site.calleeMemberName.toLowerCase()];
}

/**
 * The method a request options object states, or `undefined`.
 *
 * Read from the argument's *text* because that is what the IR records for a non-literal argument,
 * and an options object is not a literal. Only a quoted method is taken: `{ method: verb }` names a
 * value this reader cannot know, and treating it as any particular verb would guess.
 */
function optionsMethodOf(site: CallSiteIR): HttpMethod | undefined {
  const options = site.arguments[1]?.text;

  if (options === undefined) {
    return undefined;
  }

  const stated = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(options)?.[1];

  return stated === undefined ? undefined : VERB_MEMBERS[stated.toLowerCase()];
}

/**
 * The first argument's literal path, or `null`.
 *
 * Path-shaped means it starts with `/` or names an absolute URL. A bare `'users'` is a key far more
 * often than an endpoint, and `cache.get('user')` would otherwise become a request to nowhere.
 */
function pathArgumentOf(site: CallSiteIR): string | null {
  const first = site.arguments[0]?.stringValue ?? null;

  if (first === null || first.length === 0) {
    return null;
  }

  return first.startsWith('/') || /^https?:\/\//i.test(first) ? first : null;
}
