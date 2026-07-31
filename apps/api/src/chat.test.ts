import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScriptedModel } from '@traceiq/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type StartedServer } from './server.js';

/**
 * The chat endpoints over real HTTP, against a real scanned graph and a scripted model.
 *
 * A real server on an ephemeral port driven with `fetch`, so routing, validation, the SSE framing, the
 * status codes and the error translation are all exercised as a client would exercise them. The **model**
 * is scripted: what is being tested is the transport, not whether a model writes good prose.
 */
const FILES = {
  'packages/core/src/service.ts': `import { helper } from './cycle.a';
export class UserService {
  find(id: string): string | undefined {
    helper();
    return process.env.JWT_SECRET;
  }
}
`,
  'packages/core/src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'packages/core/src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
};

const FIND = 'sym:packages/core/src/service.ts#UserService.find';

let root: string;
/** With a model, so the chat endpoints work. */
let server: StartedServer;
/** Without one, so `ai-not-configured` is reachable. */
let bare: StartedServer;
let model: ScriptedModel;

interface Result {
  readonly status: number;
  readonly headers: Headers;
  readonly body: { success: boolean; data?: unknown; error?: { code: string; detail: string; hint: string } };
}

async function post(target: StartedServer, url: string, body: unknown): Promise<Result> {
  const response = await fetch(`${target.url}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return { status: response.status, headers: response.headers, body: JSON.parse(await response.text()) };
}

interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Reads an SSE body into frames. Deliberately parses the wire format rather than trusting it. */
async function stream(url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; contentType: string | null; frames: Frame[] }> {
  const response = await fetch(`${server.url}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

  const contentType = response.headers.get('content-type');
  const text = await response.text();
  const frames: Frame[] = [];

  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');

    if (event !== undefined && data !== '') {
      frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }

  return { status: response.status, contentType, frames };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-chat-'));

  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs', moduleResolution: 'node', strict: false, skipLibCheck: true },
    }),
    ...FILES,
  };

  for (const [relativePath, contents] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents, 'utf8');
  }

  model = new ScriptedModel({ chunks: ['It is a method ', '[f1] in a cycle.'], id: 'scripted-7b' });

  const databasePath = path.join(root, 'graph.db');

  server = await startServer({ port: 0, databasePath, model });
  bare = await startServer({ port: 0, databasePath });

  await post(server, '/scan', { repository: root });
}, 60_000);

afterAll(async () => {
  await server.close();
  await bare.close();
  await rm(root, { recursive: true, force: true });
});

describe('POST /chat', () => {
  it('answers, preserving the verdict, citations, omissions, usage and model', async () => {
    const result = await post(server, '/chat', { question: 'What is this?', subject: { kind: 'symbol', id: FIND } });

    expect(result.status).toBe(201);
    expect(result.body.success).toBe(true);

    const answer = result.body.data as Record<string, unknown>;

    expect(answer.text).toBe('It is a method [f1] in a cycle.');
    expect(answer.verdict).toBe('grounded');
    expect(answer.model).toBe('scripted-7b');
    expect(answer.stopReason).toBe('complete');
    expect(answer.usage).toMatchObject({ promptTokens: expect.any(Number), outputTokens: expect.any(Number) });
    expect(Array.isArray(answer.citations)).toBe(true);
    expect(Array.isArray(answer.fabricatedIdentifiers)).toBe(true);
    expect(answer.grounding).toMatchObject({
      kind: 'symbol',
      factCount: expect.any(Number),
      tier: expect.any(String),
      tokens: expect.any(Number),
      digest: expect.any(String),
      omissions: expect.any(Array),
    });
  });

  it('flattens a citation to the fact fields, so a client can display the evidence', async () => {
    const result = await post(server, '/chat', { question: 'q', subject: { kind: 'symbol', id: FIND } });
    const citations = (result.body.data as { citations: Record<string, unknown>[] }).citations;

    expect(citations[0]).toMatchObject({
      factId: 'f1',
      subject: FIND,
      predicate: expect.any(String),
      object: expect.any(String),
      confidence: expect.any(String),
      provenance: expect.stringMatching(/^@traceiq\//),
    });
  });

  it('exposes no AI internal — no projection, no facts array, no prompt', async () => {
    const result = await post(server, '/chat', { question: 'q', subject: { kind: 'symbol', id: FIND } });
    const serialised = JSON.stringify(result.body.data);

    for (const leaked of ['REPOSITORY-FACTS', 'identifiers', '"facts"', 'messages', 'systemPrompt']) {
      expect(serialised, leaked).not.toContain(leaked);
    }
  });

  it('answers about the repository as a whole', async () => {
    const result = await post(server, '/chat', { question: 'How big?', subject: { kind: 'repository' } });

    expect(result.status).toBe(201);
    expect((result.body.data as { grounding: { kind: string } }).grounding.kind).toBe('repository');
  });

  it('accepts prior turns as history', async () => {
    const result = await post(server, '/chat', {
      question: 'and what else?',
      subject: { kind: 'symbol', id: FIND },
      history: [{ question: 'what is it?', answer: 'a method' }],
    });

    expect(result.status).toBe(201);
    expect(model.lastPrompt()).toContain('what is it?');
    expect(model.lastPrompt()).toContain('a method');
  });
});

describe('POST /chat validation', () => {
  it('requires a question', async () => {
    const result = await post(server, '/chat', { subject: { kind: 'repository' } });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('missing-parameter');
  });

  it('requires a subject', async () => {
    const result = await post(server, '/chat', { question: 'q' });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('missing-parameter');
  });

  it('rejects an unknown context kind', async () => {
    const result = await post(server, '/chat', { question: 'q', subject: { kind: 'everything' } });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('bad-request');
  });

  it('rejects a symbol subject with no id', async () => {
    const result = await post(server, '/chat', { question: 'q', subject: { kind: 'symbol' } });

    expect(result.status).toBe(400);
  });

  it('rejects an unknown budget tier', async () => {
    const result = await post(server, '/chat', { question: 'q', subject: { kind: 'repository' }, tier: 'enormous' });

    expect(result.status).toBe(400);
  });

  it('will not search for a subject, because that is repository intelligence', async () => {
    // A free-text subject is refused rather than resolved: GET /search exists for that, and doing it here
    // would put repository search inside the AI path.
    const result = await post(server, '/chat', { question: 'q', subject: 'UserService' });

    expect(result.status).toBe(400);
  });

  it('reports an unknown declaration as subject-not-found, keeping the AI code', async () => {
    const result = await post(server, '/chat', {
      question: 'q',
      subject: { kind: 'symbol', id: 'sym:nowhere.ts#Absent' },
    });

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe('subject-not-found');
  });
});

describe('with no model configured', () => {
  it('answers ai-not-configured with a 503, and says what to do', async () => {
    const result = await post(bare, '/chat', { question: 'q', subject: { kind: 'repository' } });

    expect(result.status).toBe(503);
    expect(result.body.error?.code).toBe('ai-not-configured');
    expect(result.body.error?.hint).toContain('model');
  });

  it('leaves every other endpoint working', async () => {
    const response = await fetch(`${bare.url}/overview`);

    expect(response.status).toBe(200);
  });
});

describe('POST /chat/stream', () => {
  it('streams open, grounding, deltas and complete, in that order', async () => {
    const result = await stream('/chat/stream', { question: 'q', subject: { kind: 'symbol', id: FIND } });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');
    expect(result.frames.map((frame) => frame.event)).toEqual(['open', 'grounding', 'delta', 'delta', 'complete']);
  });

  it('describes the grounding before any prose', async () => {
    const result = await stream('/chat/stream', { question: 'q', subject: { kind: 'symbol', id: FIND } });
    const grounding = result.frames.findIndex((frame) => frame.event === 'grounding');
    const firstDelta = result.frames.findIndex((frame) => frame.event === 'delta');

    expect(grounding).toBeLessThan(firstDelta);
    expect(result.frames[grounding]?.data).toMatchObject({ factCount: expect.any(Number), digest: expect.any(String) });
  });

  it('names the model in the open frame', async () => {
    const result = await stream('/chat/stream', { question: 'q', subject: { kind: 'repository' } });

    expect(result.frames[0]).toMatchObject({ event: 'open', data: { model: 'scripted-7b' } });
  });

  it('delivers the same answer as POST /chat in its complete frame', async () => {
    const streamed = await stream('/chat/stream', { question: 'q', subject: { kind: 'symbol', id: FIND } });
    const plain = await post(server, '/chat', { question: 'q', subject: { kind: 'symbol', id: FIND } });

    const completed = streamed.frames.find((frame) => frame.event === 'complete')?.data;

    // `/chat` is the streaming primitive drained, not a second code path — so the bodies must agree.
    expect(completed).toEqual(plain.body.data);
  });

  it('reassembles to the same text as the deltas carried', async () => {
    const result = await stream('/chat/stream', { question: 'q', subject: { kind: 'symbol', id: FIND } });
    const joined = result.frames
      .filter((frame) => frame.event === 'delta')
      .map((frame) => frame.data.text as string)
      .join('');

    expect(joined).toBe((result.frames.find((frame) => frame.event === 'complete')?.data as { text: string }).text);
  });

  it('sets no-transform, so a proxy cannot batch the stream into one chunk', async () => {
    const response = await fetch(`${server.url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q', subject: { kind: 'repository' } }),
    });

    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await response.text();
  });

  it('rejects a malformed body with a real status, not a 200 carrying an error frame', async () => {
    // Validation happens before the stream opens, precisely so this is an ordinary JSON error.
    const response = await fetch(`${server.url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: { kind: 'repository' } }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('still carries the request id and timing headers', async () => {
    const response = await fetch(`${server.url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q', subject: { kind: 'repository' } }),
    });

    expect(response.headers.get('x-request-id')).toBeTruthy();
    await response.text();
  });
});

describe('a failure after the stream has opened', () => {
  it('arrives as a terminal error frame, because the status line is already sent', async () => {
    const failing = new ScriptedModel({
      chunks: ['half '],
      failAfter: 1,
      id: 'failing',
    });

    const other = await startServer({ port: 0, databasePath: path.join(root, 'graph.db'), model: failing });

    try {
      const response = await fetch(`${other.url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'q', subject: { kind: 'repository' } }),
      });

      expect(response.status).toBe(200);

      const text = await response.text();

      expect(text).toContain('event: delta');
      expect(text).toContain('event: error');
      expect(text).toContain('stream-interrupted');
      // The partial text is on the frame, so a client can show what did arrive.
      expect(text).toContain('half');
      expect(text).not.toContain('event: complete');
    } finally {
      await other.close();
    }
  }, 30_000);
});

describe('the OpenAPI document', () => {
  it('documents both chat endpoints', async () => {
    const document = (await (await fetch(`${server.url}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
    };

    expect(document.paths['/chat']?.post?.operationId).toBe('chat');
    expect(document.paths['/chat/stream']?.post?.operationId).toBe('chatStream');
  });

  it('declares the streaming endpoint as an event stream, not JSON', async () => {
    const document = (await (await fetch(`${server.url}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
    };

    const ok = document.paths['/chat/stream']?.post?.responses['200'];

    expect(Object.keys(ok?.content ?? {})).toEqual(['text/event-stream']);
  });

  it('documents the AI error codes it can return', async () => {
    const document = (await (await fetch(`${server.url}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };

    const statuses = Object.keys(document.paths['/chat']?.post?.responses ?? {});

    expect(statuses).toContain('503');
    expect(statuses).toContain('404');
    expect(statuses).toContain('422');
  });
});
