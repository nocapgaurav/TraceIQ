import { describe, expect, it } from 'vitest';

import { linkForNode, routes } from './routes';

/**
 * Link construction.
 *
 * The one thing that must not break: an identifier containing `#` and `/` has to survive a round trip
 * through a URL. A raw `#` would be read as a fragment and silently truncate the identifier, which is
 * exactly the trap the REST API documents.
 */
describe('routes', () => {
  it('encodes a declaration identifier so the hash cannot start a fragment', () => {
    const href = routes.symbol('sym:packages/core/src/service.ts#UserService.find');

    expect(href).toBe('/symbol?id=sym%3Apackages%2Fcore%2Fsrc%2Fservice.ts%23UserService.find');
    expect(href).not.toContain('#');
  });

  it('round-trips an identifier through URLSearchParams unchanged', () => {
    const id = 'sym:packages/core/src/service.ts#UserService.find';
    const query = new URL(routes.symbol(id), 'http://x').searchParams;

    expect(query.get('id')).toBe(id);
  });

  it('round-trips an identifier with a nested chain', () => {
    const id = 'sym:a.ts#Outer.inner.deepest';

    expect(new URL(routes.impact(id), 'http://x').searchParams.get('id')).toBe(id);
  });

  it('returns the bare search page for an empty query', () => {
    expect(routes.search()).toBe('/search');
    expect(routes.search('')).toBe('/search');
  });

  it('encodes a search query', () => {
    expect(routes.search('a b/c')).toBe('/search?q=a%20b%2Fc');
  });
});

describe('linkForNode', () => {
  it('sends a file to the explorer with its prefix stripped', () => {
    expect(linkForNode('file:packages/core/src/a.ts')).toBe('/explorer?file=packages%2Fcore%2Fsrc%2Fa.ts');
  });

  it('sends a declaration to the symbol page', () => {
    expect(linkForNode('sym:a.ts#B')).toBe('/symbol?id=sym%3Aa.ts%23B');
  });

  it('sends a node with no page of its own to search rather than to a 404', () => {
    expect(linkForNode('env:JWT_SECRET')).toBe('/search?q=env%3AJWT_SECRET');
    expect(linkForNode('ext:npm:express')).toBe('/search?q=ext%3Anpm%3Aexpress');
    expect(linkForNode('route:GET:/users')).toBe('/search?q=route%3AGET%3A%2Fusers');
  });
});
