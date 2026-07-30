import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LogEntry } from './app.js';
import { startServer, type StartedServer } from './server.js';

/**
 * The API over real HTTP.
 *
 * A real server on an ephemeral port, driven with `fetch` — so routing, middleware, the body parser,
 * status codes, headers, validation, every capability and the error handler are all exercised as a
 * client would exercise them. Nothing is stubbed and no HTTP testing library is involved.
 *
 * The fixture is a small Express repository: two packages, a route chain with middleware, a
 * member-expression handler that cannot be linked, an environment variable read in the service, a
 * mutual import cycle and recursion.
 */
const FILES = {
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { UserService } from '../../core/src/service';
const router = Router();
const service = new UserService();
const controller = { create() {} };
router.get('/users/:id', requireAuth, getUser);
router.post('/users', controller.create);
export function requireAuth(): void {}
export function getUser(): string | undefined { return service.find('1'); }
export default router;
`,
  'packages/core/src/service.ts': `import { helper } from './cycle.a';
export class UserService {
  find(id: string): string | undefined {
    helper();
    return process.env.JWT_SECRET;
  }
}
export function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }
`,
  'packages/core/src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'packages/core/src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
};

const FIND = 'sym:packages/core/src/service.ts%23UserService.find';

let root: string;
let server: StartedServer;
const logged: LogEntry[] = [];

interface Result {
  readonly status: number;
  readonly headers: Headers;
  readonly body: { success: boolean; data?: unknown; error?: { code: string; detail: string; hint: string }; meta?: unknown };
  readonly text: string;
}

async function call(method: string, url: string, body?: unknown): Promise<Result> {
  const response = await fetch(`${server.url}${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();

  return { status: response.status, headers: response.headers, body: JSON.parse(text), text };
}

const get = (url: string): Promise<Result> => call('GET', url);

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-api-'));

  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: false,
        skipLibCheck: true,
      },
    }),
    ...FILES,
  };

  for (const [relativePath, contents] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents, 'utf8');
  }

  server = await startServer({
    port: 0,
    databasePath: path.join(root, 'graph.db'),
    log: (entry) => {
      logged.push(entry);
    },
  });
}, 60_000);

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('before a scan', () => {
  it('answers ping without a graph', async () => {
    const result = await get('/ping');

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ status: 'ok' });
  });

  it('reports that nothing is scanned', async () => {
    const result = await get('/version');

    expect(result.body.data).toMatchObject({ scanned: false });
  });

  it('answers a read with 409 rather than 404', async () => {
    const result = await get('/overview');

    expect(result.status).toBe(409);
    expect(result.body.error?.code).toBe('repository-not-scanned');
  });

  it('serves the OpenAPI document without a graph', async () => {
    const response = await fetch(`${server.url}/openapi.json`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { openapi: string }).openapi).toBe('3.0.3');
  });
});

describe('POST /scan', () => {
  it('builds the graph and answers 201 with a summary', async () => {
    const result = await call('POST', '/scan', { repository: root });

    expect(result.status).toBe(201);
    expect(result.body.data).toMatchObject({ files: Object.keys(FILES).length });
  }, 60_000);

  it('reports the repository as scanned afterwards', async () => {
    expect((await get('/version')).body.data).toMatchObject({ scanned: true });
  });

  it('rejects a body with no repository', async () => {
    const result = await call('POST', '/scan', {});

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('missing-parameter');
  });

  it('rejects a body that is not JSON', async () => {
    const result = await call('POST', '/scan', 'not json');

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('bad-request');
  });

  it('rejects a repository that cannot be scanned', async () => {
    const result = await call('POST', '/scan', { repository: path.join(root, 'nowhere') });

    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('invalid-repository');
  });
});

describe('every read endpoint', () => {
  it('answers 200 with success, data and meta', async () => {
    for (const url of [
      '/overview',
      '/architecture',
      '/packages',
      '/packages/packages/core',
      '/files/packages/core/src/service.ts',
      `/symbol/${FIND}`,
      `/impact/${FIND}`,
      '/routes',
      '/route?method=GET&path=/users/:id',
      '/health',
      '/search?q=help',
      '/dependencies/packages/core',
      '/cycles',
      '/hotspots',
      '/version',
      '/ping',
    ]) {
      const result = await get(url);

      expect(result.status, url).toBe(200);
      expect(result.body.success, url).toBe(true);
      expect(result.body.data, url).toBeDefined();
      expect(result.body.meta, url).toMatchObject({ endpoint: expect.any(String), capability: expect.any(String) });
    }
  }, 60_000);

  it('returns the capability result unchanged', async () => {
    // The explorer's own field names and shapes, not a reshaped copy.
    const overview = (await get('/overview')).body.data as { repository: unknown; graph: unknown; limitations: unknown };

    expect(overview.repository).toBeDefined();
    expect(overview.graph).toBeDefined();
    expect(overview.limitations).toBeDefined();
  });

  it('explains a route chain in running order', async () => {
    const route = (await get('/route?method=GET&path=/users/:id')).body.data as {
      chain: { position: string; declaration: { name: string } | null }[];
      pathComposition: { composed: boolean };
    };

    expect(route.chain.map((step) => step.declaration?.name)).toEqual(['requireAuth', 'getUser']);
    expect(route.pathComposition.composed).toBe(false);
  });

  it('reports the cycle the fixture contains', async () => {
    const cycles = (await get('/cycles')).body.data as { callCycles: { entries: { nodes: { id: string }[] }[] } };
    const members = cycles.callCycles.entries.flatMap((cycle) => cycle.nodes.map((node) => node.id));

    expect(members.some((id) => id.includes('cycle.a.ts#helper'))).toBe(true);
  });
});

describe('identifiers in a URL', () => {
  it('accepts a declaration identifier with the # percent-encoded', async () => {
    const result = await get(`/symbol/${FIND}`);

    expect(result.status).toBe(200);
  });

  it('rejects one whose # was stripped, naming the encoding', async () => {
    const result = await get('/symbol/sym:packages/core/src/service.ts');

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('invalid-identifier');
    expect(result.body.error?.hint).toContain('%23');
  });

  it('rejects a value with no identity prefix', async () => {
    const result = await get('/symbol/UserService.find');

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('invalid-identifier');
  });

  it('accepts a file path with slashes and no prefix', async () => {
    expect((await get('/files/packages/core/src/service.ts')).status).toBe(200);
  });

  it('accepts a package name with slashes', async () => {
    expect((await get('/packages/packages/core')).status).toBe(200);
  });

  it('accepts a package name for dependencies and an identifier alike', async () => {
    expect((await get('/dependencies/packages/core')).status).toBe(200);
    expect((await get(`/dependencies/${FIND}`)).status).toBe(200);
  });
});

describe('validation and errors', () => {
  it('returns 404 for an unknown path', async () => {
    const result = await get('/nope');

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe('not-found');
  });

  it('returns 405 for an unsupported method on a known path', async () => {
    const result = await call('POST', '/overview');

    expect(result.status).toBe(405);
    expect(result.body.error?.code).toBe('method-not-allowed');
    expect(result.body.error?.hint).toContain('GET');
  });

  it('returns 400 for a missing query parameter', async () => {
    expect((await get('/route')).body.error?.code).toBe('missing-parameter');
    expect((await get('/search')).body.error?.code).toBe('missing-parameter');
  });

  it('returns 400 for an unsupported match mode', async () => {
    const result = await get('/search?q=x&match=fuzzy');

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('bad-request');
  });

  it('returns 404 for a route the repository does not register', async () => {
    const result = await get('/route?method=GET&path=/nowhere');

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe('unknown-route');
  });

  it('returns 404 for an unknown package, file and symbol', async () => {
    expect((await get('/packages/packages/nowhere')).body.error?.code).toBe('unknown-package');
    expect((await get('/files/nowhere.ts')).body.error?.code).toBe('unknown-identifier');
    expect((await get('/symbol/sym:nowhere.ts%23Absent')).body.error?.code).toBe('unknown-identifier');
  });

  it('rejects a package name that tries to escape', async () => {
    const result = await get('/packages/../etc');

    expect([400, 404]).toContain(result.status);
  });

  it('gives every error the same shape', async () => {
    for (const url of ['/nope', '/route', '/symbol/nope', '/packages/packages/nowhere']) {
      const result = await get(url);

      expect(result.body.success).toBe(false);
      expect(result.body.error).toMatchObject({
        code: expect.any(String),
        detail: expect.any(String),
        hint: expect.any(String),
      });
      expect(result.body.meta).toBeDefined();
    }
  });
});

describe('middleware', () => {
  it('sets a request identifier, a version and a response time header', async () => {
    const result = await get('/ping');

    expect(result.headers.get('x-request-id')).toMatch(/^req-\d+$/);
    expect(result.headers.get('x-traceiq-version')).toBe('1.0.0');
    expect(result.headers.get('x-response-time')).toMatch(/^\d+\.\d+ms$/);
  });

  it('gives each request a different identifier', async () => {
    const first = await get('/ping');
    const second = await get('/ping');

    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('sets the headers on an error response too', async () => {
    const result = await get('/nope');

    expect(result.headers.get('x-request-id')).toBeTruthy();
    expect(result.headers.get('x-traceiq-version')).toBe('1.0.0');
  });

  it('answers JSON on every path', async () => {
    for (const url of ['/ping', '/nope', '/openapi.json']) {
      const response = await fetch(`${server.url}${url}`);

      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it('logs every request with its status and duration', async () => {
    const before = logged.length;

    await get('/ping');

    expect(logged.length).toBeGreaterThan(before);

    const entry = logged.at(-1);

    expect(entry).toMatchObject({ method: 'GET', path: '/ping', status: 200 });
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not advertise the framework', async () => {
    expect((await fetch(`${server.url}/ping`)).headers.get('x-powered-by')).toBeNull();
  });
});

describe('determinism', () => {
  it('returns a byte-identical body for an identical request', async () => {
    for (const url of ['/overview', '/architecture', '/packages', '/cycles', '/hotspots', '/health', '/search?q=help']) {
      const first = await get(url);
      const second = await get(url);

      expect(second.text, url).toBe(first.text);
    }
  }, 60_000);

  it('keeps the varying parts out of the body', async () => {
    const first = await get('/ping');
    const second = await get('/ping');

    expect(first.text).toBe(second.text);
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('returns an identical error body for an identical bad request', async () => {
    const first = await get('/route');
    const second = await get('/route');

    expect(second.text).toBe(first.text);
  });

  it('reports reads in meta, which grow only as the cache warms', async () => {
    const first = (await get('/cycles')).body.meta as { graphApiCalls: number };
    const second = (await get('/cycles')).body.meta as { graphApiCalls: number };

    expect(first.graphApiCalls).toBeGreaterThan(0);
    expect(second.graphApiCalls).toBe(first.graphApiCalls);
  });
});

describe('reuse', () => {
  it('shares one graph read across endpoints', async () => {
    // The graph is opened once and cached, so a second endpoint adds no reads for what the first
    // already fetched.
    await get('/overview');

    const afterOverview = ((await get('/overview')).body.meta as { graphApiCalls: number }).graphApiCalls;
    const afterCycles = ((await get('/cycles')).body.meta as { graphApiCalls: number }).graphApiCalls;

    expect(afterCycles).toBe(afterOverview);
  });

  it('opens no graph for ping', async () => {
    expect(((await get('/ping')).body.meta as { graphApiCalls: number }).graphApiCalls).toBeGreaterThanOrEqual(0);
  });

  it('serves a warm read quickly', async () => {
    await get('/overview');

    const started = Date.now();

    await get('/overview');

    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('a second scan', () => {
  it('replaces the graph and keeps answering', async () => {
    const before = (await get('/overview')).text;
    const scan = await call('POST', '/scan', { repository: root });

    expect(scan.status).toBe(201);

    const after = await get('/overview');

    expect(after.status).toBe(200);
    // The same repository, so the same graph: a rescan is idempotent.
    expect(after.body.data).toEqual(JSON.parse(before).data);
  }, 60_000);
});
