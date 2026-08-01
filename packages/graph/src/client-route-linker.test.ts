import type { GraphNode } from '@traceiq/graph-api';
import type { ClientCallAnnotation } from '@traceiq/framework';
import { describe, expect, it } from 'vitest';

import { linkClientCallsToRoutes } from './client-route-linker.js';

/**
 * The one relationship that crosses a language boundary.
 *
 * The negative cases carry the weight here. A link between a request and a route is an assertion
 * that traffic flows between two parts of a repository, and a wrong one invents an architecture.
 */
const route = (name: string): GraphNode =>
  ({ id: `route:${name}`, kind: 'Route', name }) as unknown as GraphNode;

const call = (
  path: string,
  method: ClientCallAnnotation['method'] = null,
  from: string | null = 'sym:web/App.tsx#App',
): ClientCallAnnotation => ({
  method,
  path,
  calledFromDeclarationId: from as ClientCallAnnotation['calledFromDeclarationId'],
  confidence: 'INFERRED',
  provenance: {
    annotator: 'routes',
    fileId: 'file:web/App.tsx' as ClientCallAnnotation['provenance']['fileId'],
    evidence: 'a request',
  },
  location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
});

const link = (clientCalls: readonly ClientCallAnnotation[], routes: readonly GraphNode[]) =>
  linkClientCallsToRoutes({ clientCalls, routes });

describe('matching', () => {
  it('links a request to the route that serves it', () => {
    const edges = link([call('/api/users')], [route('GET /api/users')]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      type: 'CONTINUES_TO',
      sourceId: 'sym:web/App.tsx#App',
      targetId: 'route:GET /api/users',
      confidence: 'INFERRED',
    });
  });

  it('crosses a language boundary, which is the whole point', () => {
    // The route came from the Python analyser and the call from the TypeScript one. Neither
    // analyser knows the other exists; the graph is where they meet.
    expect(link([call('/api/users')], [route('GET /api/users')])).toHaveLength(1);
  });

  it('matches a literal argument against a declared parameter', () => {
    // Express writes `:id`, Flask writes `<int:id>`, Spring writes `{id}` and a caller writes 42.
    for (const declared of ['GET /users/:id', 'GET /users/{id}', 'GET /users/<int:id>']) {
      expect(link([call('/users/42')], [route(declared)])).toHaveLength(1);
    }
  });

  it('ignores a query string and a trailing slash, which name no endpoint', () => {
    expect(link([call('/api/users?page=2')], [route('GET /api/users')])).toHaveLength(1);
    expect(link([call('/api/users/')], [route('GET /api/users')])).toHaveLength(1);
  });

  it('links a module-level request to its file', () => {
    const edges = link([call('/api/users', null, null)], [route('GET /api/users')]);

    expect(edges[0]?.sourceId).toBe('file:web/App.tsx');
  });
});

describe('what must not be linked', () => {
  it('does not link a request whose method the route does not serve', () => {
    expect(link([call('/api/users', 'DELETE')], [route('GET /api/users')])).toEqual([]);
  });

  it('links a method-less request to any method on the path', () => {
    // `fetch('/api/users')` defaults to GET at runtime and says so nowhere in the source. Narrowing
    // it to GET would be reading the specification rather than the code.
    expect(link([call('/api/users')], [route('POST /api/users')])).toHaveLength(1);
  });

  it('does not link a request to another host', () => {
    // `https://api.stripe.com/v1/charges` sharing a path shape with a local route would produce an
    // edge asserting the repository calls itself.
    expect(link([call('https://api.stripe.com/api/users')], [route('GET /api/users')])).toEqual([]);
  });

  it('does not link paths of different depth', () => {
    expect(link([call('/api/users/42/posts')], [route('GET /api/users/:id')])).toEqual([]);
    expect(link([call('/api')], [route('GET /api/users')])).toEqual([]);
  });

  it('does not read a literal word as a parameter', () => {
    // `/users/me` and `/users/:id` are frequently different endpoints, and merging them would
    // claim a call that was never made.
    expect(link([call('/users/me')], [route('GET /users/:id')])).toEqual([]);
  });

  it('produces nothing when the repository serves no routes', () => {
    expect(link([call('/api/users')], [])).toEqual([]);
  });
});

describe('determinism', () => {
  it('emits one edge per call site and route, never a duplicate', () => {
    const edges = link(
      [call('/api/users'), call('/api/users')],
      [route('GET /api/users'), route('POST /api/users')],
    );

    // Two calls at the same position are one site; two routes on the path are two facts.
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(edges).toHaveLength(2);
  });
});
