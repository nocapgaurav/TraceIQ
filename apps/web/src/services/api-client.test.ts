import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, API_BASE, NetworkError, apiClient, encodeSegment } from './api-client';

/**
 * The HTTP boundary.
 *
 * These are the cases the rest of the app relies on and cannot check for itself: that an envelope is
 * unwrapped, that a failure becomes a typed error carrying the server's own code, and that a `#` in an
 * identifier survives being put in a URL.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function respond(body: unknown, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

describe('encodeSegment', () => {
  it('percent-encodes a hash, because it would otherwise start a URL fragment', () => {
    expect(encodeSegment('sym:src/a.ts#Service.run')).toBe('sym:src/a.ts%23Service.run');
  });

  it('leaves slashes alone, because the API matches a path with wildcards', () => {
    expect(encodeSegment('packages/core/src/a.ts')).toBe('packages/core/src/a.ts');
  });

  it('encodes every hash in a nested chain', () => {
    expect(encodeSegment('sym:a.ts#A#B')).toBe('sym:a.ts%23A%23B');
  });
});

describe('requests', () => {
  it('sends same-origin requests through the proxy base', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true }, meta: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await apiClient.get('/overview');

    expect(spy.mock.calls[0]?.[0]).toBe(`${API_BASE}/overview`);
  });

  it('returns data from the envelope, not the envelope', async () => {
    respond({ success: true, data: { files: 3 }, meta: {} });

    await expect(apiClient.get('/overview')).resolves.toEqual({ files: 3 });
  });

  it('turns a described failure into an ApiError carrying the code, detail and hint', async () => {
    respond(
      {
        success: false,
        error: { code: 'unknown-identifier', detail: 'nothing named that', hint: 'use GET /search' },
        meta: {},
      },
      404,
    );

    const error = await apiClient.get('/symbol/x').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'unknown-identifier', detail: 'nothing named that', status: 404 });
    expect((error as ApiError).isNotFound).toBe(true);
  });

  it('recognises the not-scanned state, which is a 409 rather than a 404', async () => {
    respond(
      {
        success: false,
        error: { code: 'repository-not-scanned', detail: 'no graph', hint: 'run traceiq scan' },
        meta: {},
      },
      409,
    );

    const error = (await apiClient.get('/overview').catch((thrown: unknown) => thrown)) as ApiError;

    expect(error.isNotScanned).toBe(true);
    expect(error.isNotFound).toBe(false);
  });

  it('reports a non-JSON body as bad-response rather than throwing a parse error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    const error = (await apiClient.get('/overview').catch((thrown: unknown) => thrown)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('bad-response');
    expect(error.status).toBe(502);
  });

  it('reports an unreachable API as a NetworkError, distinct from a described failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const error = await apiClient.get('/overview').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('posts a JSON body with a content-type', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: {}, meta: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await apiClient.post('/scan', { repository: '.' });

    const init = spy.mock.calls[0]?.[1];

    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"repository":"."}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });
});
