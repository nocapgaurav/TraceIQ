import type { ClientCallAnnotation } from '@traceiq/framework';
import type { GraphEdge, GraphNode } from '@traceiq/graph-api';

import { edgeIdentity } from './identity.js';

const PRODUCER = 'graph-builder';

/**
 * Links a request a repository *makes* to a route the same repository *serves*.
 *
 * **This is what makes a polyglot repository one system rather than several.** A React application
 * calling `fetch('/api/users')` and a Flask service registering `@app.route('/api/users')` are two
 * halves of one interaction, in two languages, analysed by two analysers that never meet. Routes
 * have been extracted for every supported language for two milestones and nothing recorded who
 * called them, so the graph held two disconnected components and an architecture view showed
 * language islands sharing a checkout.
 *
 * `CONTINUES_TO` is the relationship, and it needed no vocabulary change: it has been reserved and
 * unproduced since the contract was written, and "execution continues to" is precisely what an
 * outbound request to a locally-served endpoint does. `DEPENDS_ON` was in the same position before
 * the milestone that gave it manifest-to-dependency.
 *
 * **Matching is by normalised path, and deliberately conservative.** A route path and a client path
 * are written by different people in different languages with different parameter syntaxes, so both
 * sides are reduced to a shape that ignores what cannot be compared — the origin, the query string,
 * a trailing slash, and the *name* of a path parameter — and nothing else. Two paths that differ in
 * segment count never match, and a client path with a literal `123` where the route has `:id` does
 * match, because that is the same endpoint.
 *
 * Every edge is `INFERRED`. The two sides agree on a string; nothing proves the request reaches
 * *this* server rather than a different one that happens to serve the same path, and an absolute
 * URL to another host is excluded for exactly that reason.
 */
export function linkClientCallsToRoutes(input: {
  readonly clientCalls: readonly ClientCallAnnotation[];
  readonly routes: readonly GraphNode[];
}): readonly GraphEdge[] {
  if (input.clientCalls.length === 0 || input.routes.length === 0) {
    return [];
  }

  // Route nodes are named `GET /users`. Indexed by normalised path so a client call is one lookup
  // rather than a scan per call — a repository with 1,300 routes and 400 client calls would
  // otherwise be half a million comparisons.
  const byPath = new Map<string, GraphNode[]>();

  for (const route of input.routes) {
    const parsed = parseRouteName(route.name);

    if (parsed === null) {
      continue;
    }

    const key = normalise(parsed.path);
    const bucket = byPath.get(key);

    if (bucket === undefined) {
      byPath.set(key, [route]);
    } else {
      bucket.push(route);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const call of input.clientCalls) {
    const path = localPathOf(call.path);

    if (path === null) {
      continue;
    }

    for (const route of byPath.get(normalise(path)) ?? []) {
      const method = parseRouteName(route.name)?.method;

      // A call that states its method must agree with the route's. A call that states none —
      // `fetch('/api/users')` — matches any method on that path, because the source genuinely does
      // not say and narrowing it to GET would be reading the specification rather than the code.
      if (call.method !== null && method !== call.method && method !== 'ALL') {
        continue;
      }

      // A module-level call belongs to its file, exactly as a module-level call does everywhere
      // else in the graph.
      const sourceId = call.calledFromDeclarationId ?? call.provenance.fileId;

      if (sourceId === null) {
        continue;
      }

      const id = edgeIdentity(
        'CONTINUES_TO',
        sourceId,
        route.id,
        call.path,
        call.provenance.fileId,
        call.location,
      );

      // One call site reaching one route is one fact. Two routes on the same path with different
      // methods are two, and both are kept.
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);

      edges.push({
        id,
        type: 'CONTINUES_TO',
        sourceId,
        targetId: route.id,
        name: call.path,
        confidence: 'INFERRED',
        candidateGroup: null,
        ordinal: null,
        provenance: {
          producer: PRODUCER,
          fileId: call.provenance.fileId,
          evidence: `'${call.path}' is requested here and '${route.name}' is served by this repository; the paths match once origin, query and parameter names are set aside`,
        },
        location: call.location,
      });
    }
  }

  return edges;
}

/**
 * The repository-relative path a client call targets, or `null` when it targets somewhere else.
 *
 * An absolute URL to another host is excluded rather than stripped to its path: `https://api.stripe.com/v1/charges`
 * happening to share a path shape with a local route would produce an edge asserting the repository
 * calls itself, which is exactly the fabrication this must not commit. Only a same-origin path — one
 * written as a path — can match.
 */
function localPathOf(raw: string): string | null {
  return raw.startsWith('/') ? raw : null;
}

/** `GET /users/:id` → its two halves. `null` when the name is not a route name. */
function parseRouteName(name: string): { readonly method: string; readonly path: string } | null {
  const space = name.indexOf(' ');

  return space === -1
    ? null
    : { method: name.slice(0, space), path: name.slice(space + 1) };
}

/**
 * Reduces a path to what two sides written in different languages can be compared on.
 *
 * Dropped: the query string and fragment, which are arguments rather than the endpoint; a trailing
 * slash, which no router distinguishes; and the *name* of every path parameter, since Express
 * writes `:id`, Flask writes `<int:id>`, Spring writes `{id}` and a caller writes `123` — four
 * spellings of one thing.
 *
 * A literal segment is kept as written and compared case-sensitively. Nothing else is normalised:
 * two paths of different lengths are different endpoints, and collapsing them would invent traffic.
 */
function normalise(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? path;
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;

  return trimmed
    .split('/')
    .map((segment) => (isParameter(segment) ? '*' : segment))
    .join('/');
}

/**
 * Whether a segment is a parameter rather than a literal.
 *
 * The three declaration syntaxes, plus the shape a *caller* writes where a parameter goes: a run of
 * digits, or a UUID. A caller writing a literal word — `/users/me` — is not treated as a parameter,
 * because `/users/me` and `/users/:id` are frequently different endpoints and merging them would
 * claim a call that was never made.
 */
function isParameter(segment: string): boolean {
  return (
    segment.startsWith(':') ||
    (segment.startsWith('{') && segment.endsWith('}')) ||
    (segment.startsWith('<') && segment.endsWith('>')) ||
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
  );
}
