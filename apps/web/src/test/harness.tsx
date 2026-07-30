import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * The test harness.
 *
 * **`fetch` is the only thing stubbed.** Everything above it — the client, the services, the hooks, the
 * components — is the production code path, so a test exercises the real envelope parsing, the real
 * error mapping and the real query wiring. Mocking a hook instead would test the mock.
 */

export interface StubbedRoute {
  /** Matched as a substring of the request path, e.g. `/overview`. */
  readonly path: string;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly detail: string; readonly hint: string };
  readonly status?: number;
}

export interface FetchStub {
  readonly calls: readonly string[];
  restore(): void;
}

const META = { endpoint: 'test', capability: 'test', graphApiCalls: 0 };

/** Answers requests from a fixed table. An unmatched path is a 404 with the API's own error shape. */
export function stubFetch(routes: readonly StubbedRoute[]): FetchStub {
  const calls: string[] = [];

  const implementation = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    calls.push(url);

    // Longest match wins, so `/packages/core` is not answered by a stub for `/packages`.
    const match = [...routes]
      .filter((route) => url.includes(route.path))
      .sort((left, right) => right.path.length - left.path.length)[0];

    if (match === undefined) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'not-found', detail: `no stub for ${url}`, hint: 'add one' },
          meta: META,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }

    if (match.error !== undefined) {
      return new Response(JSON.stringify({ success: false, error: match.error, meta: META }), {
        status: match.status ?? 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, data: match.data, meta: META }), {
      status: match.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(implementation as typeof fetch);

  return {
    calls,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** Renders inside a fresh `QueryClient`. Retries are off so an error case fails fast rather than waiting. */
export function renderWithQuery(ui: React.ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });

  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
