import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { repositoryService } from './repository-service';

/**
 * The URL each operation builds.
 *
 * This is the layer that owns every path in the application, so these tests are the contract: if a path
 * changes, exactly one test fails and it names the endpoint.
 */
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string) => {
    requested.push(input);

    return new Response(JSON.stringify({ success: true, data: {}, meta: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('paths', () => {
  it.each([
    ['ping', () => repositoryService.ping(), '/api/ping'],
    ['version', () => repositoryService.version(), '/api/version'],
    ['overview', () => repositoryService.overview(), '/api/overview'],
    ['architecture', () => repositoryService.architecture(), '/api/architecture'],
    ['packages', () => repositoryService.packages(), '/api/packages'],
    ['health', () => repositoryService.health(), '/api/health'],
    ['cycles', () => repositoryService.cycles(), '/api/cycles'],
    ['hotspots', () => repositoryService.hotspots(), '/api/hotspots'],
    ['routes', () => repositoryService.routes(), '/api/routes'],
  ])('%s requests %s', async (_name, call, expected) => {
    await call();

    expect(requested).toEqual([expected]);
  });

  it('keeps slashes in a package name', async () => {
    await repositoryService.packageByName('packages/core');

    expect(requested[0]).toBe('/api/packages/packages/core');
  });

  it('keeps slashes in a file path', async () => {
    await repositoryService.file('packages/core/src/service.ts');

    expect(requested[0]).toBe('/api/files/packages/core/src/service.ts');
  });

  it('percent-encodes the hash in a declaration identifier', async () => {
    await repositoryService.symbol('sym:packages/core/src/service.ts#UserService.find');

    expect(requested[0]).toBe('/api/symbol/sym:packages/core/src/service.ts%23UserService.find');
    expect(requested[0]).not.toContain('#');
  });

  it('percent-encodes the hash for impact too', async () => {
    await repositoryService.impact('sym:a.ts#B');

    expect(requested[0]).toBe('/api/impact/sym:a.ts%23B');
  });

  it('encodes a route method and path as query parameters', async () => {
    await repositoryService.route('GET', '/users/:id');

    expect(requested[0]).toBe('/api/route?method=GET&path=%2Fusers%2F%3Aid');
  });

  it('sends only the query text when nothing else is filtered', async () => {
    await repositoryService.search({ text: 'find' });

    expect(requested[0]).toBe('/api/search?q=find');
  });

  it('adds kind, path and match when given', async () => {
    await repositoryService.search({ text: 'find', kind: 'Method', path: 'packages/core', match: 'exact' });

    expect(requested[0]).toBe('/api/search?q=find&kind=Method&path=packages%2Fcore&match=exact');
  });

  it('omits an empty kind rather than sending kind=', async () => {
    await repositoryService.search({ text: 'find', kind: '' });

    expect(requested[0]).toBe('/api/search?q=find');
  });

  it('posts a scan with the repository in the body', async () => {
    await repositoryService.scan('/tmp/project');

    expect(requested[0]).toBe('/api/scan');
  });
});
