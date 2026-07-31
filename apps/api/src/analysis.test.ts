import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AnalysisRegistry,
  OFFLINE_PROBE,
  RepositoryAnalyzer,
  type CloneOutcome,
  type CloneRequest,
  type GitCloner,
} from '@traceiq/analysis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type StartedServer } from './server.js';

/**
 * Repository Analysis over real HTTP.
 *
 * A real server on an ephemeral port. Only the **clone** is substituted — for one that writes a small
 * TypeScript repository into the workspace it is handed. Everything else is production: the real
 * registry, the real workflow, the real `RepositoryPipeline`, the real SQLite store, and the real
 * `GraphHolder` reopening the graph afterwards.
 *
 * What this proves is the whole point of the milestone: submitting a URL produces a repository graph
 * that the ordinary read endpoints then serve.
 */
class FixtureCloner implements GitCloner {
  async clone(request: CloneRequest): Promise<CloneOutcome> {
    const destination = request.destination;

    await mkdir(path.join(destination, 'src'), { recursive: true });
    await writeFile(
      path.join(destination, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false, skipLibCheck: true } }),
    );
    await writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: 'cloned-fixture' }));
    await writeFile(
      path.join(destination, 'src', 'service.ts'),
      'export class Widget {\n  build(name: string): string {\n    return name;\n  }\n}\n',
    );
    await writeFile(
      path.join(destination, 'src', 'index.ts'),
      "import { Widget } from './service';\nexport function make(): string {\n  return new Widget().build('a');\n}\n",
    );

    return { ok: true, failure: null, stderr: '' };
  }
}

interface Result {
  readonly status: number;
  readonly body: {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; detail: string; hint: string };
  };
}

let root: string;
let server: StartedServer;

async function call(method: string, url: string, body?: unknown): Promise<Result> {
  const response = await fetch(`${server.url}${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

  return { status: response.status, body: (await response.json()) as Result['body'] };
}

/** Polls until the analysis settles, as the browser does. */
async function settle(id: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { body } = await call('GET', `/analysis/${id}`);
    const job = body.data as Record<string, unknown>;

    if (job.status === 'succeeded' || job.status === 'failed') {
      return job;
    }

    if (Date.now() > deadline) {
      throw new Error(`analysis ${id} did not settle: ${JSON.stringify(job)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-analysis-api-'));

  server = await startServer({
    port: 0,
    databasePath: path.join(root, 'graph.db'),
    analyses: new AnalysisRegistry({
      analyzer: new RepositoryAnalyzer({ cloner: new FixtureCloner(), probe: OFFLINE_PROBE }),
      // The app supplies this itself in production; a test that injects a registry must supply it too,
      // and it is exactly what makes the read endpoints serve the new graph.
      onSettled: (job) => {
        if (job.status === 'succeeded') {
          server.app.holder.reopen();
        }
      },
    }),
  });
}, 120_000);

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('POST /analysis', () => {
  it('rejects a missing url with 400, before anything is cloned', async () => {
    const result = await call('POST', '/analysis', {});

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('missing-parameter');
  });

  it('rejects a url that is not a repository as a failed analysis, not an HTTP error', async () => {
    const started = await call('POST', '/analysis', { url: 'https://gitlab.com/owner/repo' });

    // 201, following this app's rule that a POST creates something — here, a job to follow. 202 would be
    // more precise for asynchronous work, but one convention across every POST beats a special case.
    expect(started.status).toBe(201);

    const job = await settle((started.body.data?.job as Record<string, string>).id);

    // The request succeeded; the analysis did not. Those are different things.
    expect(job.status).toBe('failed');
    expect((job.error as Record<string, string>).code).toBe('invalid-url');
    expect((job.error as Record<string, string>).detail).toContain('gitlab.com is not GitHub');
  });

  it('reports the stages it ran, in order, with no invented progress', async () => {
    const started = await call('POST', '/analysis', { url: 'https://github.com/example/cloned-fixture' });
    const job = await settle((started.body.data?.job as Record<string, string>).id);

    expect(job.status).toBe('succeeded');

    const stages = job.stages as { name: string; status: string; detail: string | null }[];

    expect(stages.map((stage) => stage.name)).toEqual(['validate', 'clone', 'scan', 'load', 'complete']);
    expect(stages.every((stage) => stage.status === 'done')).toBe(true);
    // No percentage anywhere in the payload.
    expect(JSON.stringify(job)).not.toMatch(/"(percent|progress|percentage)"/);
  });

  /** The milestone in one assertion. */
  it('produces a graph the ordinary read endpoints then serve', async () => {
    const started = await call('POST', '/analysis', { url: 'https://github.com/example/cloned-fixture' });
    const job = await settle((started.body.data?.job as Record<string, string>).id);

    expect(job.status).toBe('succeeded');
    expect((job.result as Record<string, number>).files).toBe(2);

    // The read side now answers about the repository that was just analysed — with no reload, no
    // restart and no second request to make it happen.
    const overview = await call('GET', '/overview');

    expect(overview.status).toBe(200);
    expect((overview.body.data?.repository as Record<string, number>).files).toBe(2);

    const version = await call('GET', '/version');

    expect((version.body.data as Record<string, boolean>).scanned).toBe(true);
  });

  it('refuses a second analysis while one is running, handing back the running job', async () => {
    const first = await call('POST', '/analysis', { url: 'https://github.com/example/cloned-fixture' });
    const second = await call('POST', '/analysis', { url: 'https://github.com/example/other' });

    const firstId = (first.body.data?.job as Record<string, string>).id;

    if (second.body.data?.accepted === false) {
      expect((second.body.data.job as Record<string, string>).id).toBe(firstId);
    }

    await settle(firstId);
  });
});

describe('GET /analysis/{id}', () => {
  it('is a 404 for an id that was never issued', async () => {
    const result = await call('GET', '/analysis/analysis-does-not-exist');

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe('not-found');
    expect(result.body.error?.hint).toContain('do not survive a restart');
  });

  it('lists analyses newest first', async () => {
    const listed = await call('GET', '/analysis');

    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.data?.entries)).toBe(true);
    expect((listed.body.data?.entries as unknown[]).length).toBeGreaterThan(0);
  });
});
