import { AiError, type ModelEvent } from '@traceiq/ai';
import { assertProviderContract } from '@traceiq/ai/testing';
import { describe, expect, it } from 'vitest';

import { readNdjson } from './ndjson.js';
import { FALLBACK_CONTEXT_WINDOW, OllamaProvider, contextWindowOf } from './ollama-provider.js';
import { ollamaStub, splitStream } from './stub.test-helper.js';

/**
 * The provider, against a stub speaking its own wire protocol.
 *
 * No daemon, no model weights, no network — the contract is about shape, ordering and failure translation,
 * not about answer quality. A live suite against a real Ollama is opt-in at the end of this file.
 */
async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

describe('the shared provider contract', () => {
  it('is satisfied', async () => {
    const stub = ollamaStub({ known: ['qwen:7b'], models: ['qwen:7b'] });

    // The same battery every provider must pass, so a second provider inherits the whole standard rather
    // than whichever parts someone remembered to copy.
    await assertProviderContract(new OllamaProvider({ fetch: stub.fetch }), 'qwen:7b', {
      equal: (actual, expected, message) => {
        expect(actual, message).toEqual(expected);
      },
      ok: (condition, message) => {
        expect(condition, message).toBe(true);
      },
    });
  });
});

describe('health', () => {
  it('reports the version when the daemon answers', async () => {
    const health = await new OllamaProvider({ fetch: ollamaStub({ version: '0.31.1' }).fetch }).health();

    expect(health).toMatchObject({ available: true, version: '0.31.1' });
  });

  it('reports unavailable rather than throwing when nothing is listening', async () => {
    // Not running is this provider's characteristic failure and must be answerable, not an exception.
    const health = await new OllamaProvider({ fetch: ollamaStub({ unreachable: true }).fetch }).health();

    expect(health.available).toBe(false);
    expect(health.detail).toContain('nothing is listening');
  });

  it('reports unavailable for a non-2xx answer', async () => {
    const health = await new OllamaProvider({ fetch: ollamaStub({ httpStatus: 500 }).fetch }).health();

    expect(health.available).toBe(false);
  });
});

describe('listModels', () => {
  it('lists what the provider holds, alphabetically so two listings read the same', async () => {
    const stub = ollamaStub({ models: ['zeta:1b', 'alpha:1b'] });
    const models = await new OllamaProvider({ fetch: stub.fetch }).listModels();

    expect(models.map((model) => model.id)).toEqual(['alpha:1b', 'zeta:1b']);
  });

  it('raises provider-unavailable when the daemon is not there', async () => {
    const provider = new OllamaProvider({ fetch: ollamaStub({ unreachable: true }).fetch });

    await expect(provider.listModels()).rejects.toMatchObject({ code: 'provider-unavailable' });
  });
});

describe('model', () => {
  it('reads the real context window, whatever the architecture prefix is', async () => {
    const stub = ollamaStub({ known: ['qwen:7b'], contextLength: 32_768 });
    const model = await new OllamaProvider({ fetch: stub.fetch, maxContextWindow: 32_768 }).model('qwen:7b');

    expect(model.describe().contextWindow).toBe(32_768);
  });

  it('reports the window it will actually run with, not the one the model was trained with', async () => {
    // The two used to differ silently and the projection was budgeted from the wrong one. A model
    // trained at 32k that this deployment will only run at 16k has a 16k window as far as everything
    // above is concerned, because 16k is what the prompt will be truncated against.
    const stub = ollamaStub({ known: ['qwen:7b'], contextLength: 32_768 });
    const model = await new OllamaProvider({ fetch: stub.fetch, maxContextWindow: 16_384 }).model('qwen:7b');

    expect(model.describe().contextWindow).toBe(16_384);
  });

  it('never asks for more context than the model was trained with', async () => {
    const stub = ollamaStub({ known: ['tiny:1b'], contextLength: 2048 });
    const model = await new OllamaProvider({ fetch: stub.fetch, maxContextWindow: 16_384 }).model('tiny:1b');

    expect(model.describe().contextWindow).toBe(2048);
  });

  it('sends that window to the daemon on every request, so the two cannot disagree', async () => {
    // The defect this closes: with no num_ctx the daemon picks its own, varies it between requests and
    // discards the front of an over-long prompt — the system prompt and the highest-priority facts.
    const stub = ollamaStub({ known: ['qwen:7b'], contextLength: 32_768, chunks: ['hi'] });
    const model = await new OllamaProvider({ fetch: stub.fetch, maxContextWindow: 8192 }).model('qwen:7b');

    await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] }));

    const chat = stub.calls.filter((call) => call.url.endsWith('/api/chat')).at(-1);
    const body = chat?.body as { options?: { num_ctx?: number } } | undefined;

    expect(body?.options?.num_ctx).toBe(8192);
  });

  it('falls back to a pessimistic window when the provider will not say', async () => {
    // Under-estimating costs facts; over-estimating produces a rejected prompt. Low is the cheaper error.
    expect(contextWindowOf({})).toBeNull();
    expect(contextWindowOf({ model_info: { 'x.something_else': 4 } })).toBeNull();
    expect(FALLBACK_CONTEXT_WINDOW).toBeLessThan(8192);
  });

  it('raises model-not-found for a model the provider does not hold', async () => {
    const provider = new OllamaProvider({ fetch: ollamaStub({ known: ['qwen:7b'] }).fetch });

    await expect(provider.model('absent:1b')).rejects.toMatchObject({ code: 'model-not-found' });
  });

  it('raises model-not-found for an empty id without calling the provider', async () => {
    const stub = ollamaStub();
    const provider = new OllamaProvider({ fetch: stub.fetch });

    await expect(provider.model('   ')).rejects.toMatchObject({ code: 'model-not-found' });
    expect(stub.calls).toEqual([]);
  });

  it('declares a system prompt and no tools', async () => {
    const model = await new OllamaProvider({ fetch: ollamaStub({ known: ['q:1b'] }).fetch }).model('q:1b');

    expect(model.describe().capabilities.has('system-prompt')).toBe(true);
    expect(model.describe().capabilities.has('tools')).toBe(false);
  });
});

describe('generate', () => {
  it('streams deltas between a start and an end', async () => {
    const stub = ollamaStub({ known: ['q:1b'], chunks: ['Hello ', 'world'] });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    const events = await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'end']);
    expect(events.filter((event) => event.type === 'delta').map((event) => (event as { text: string }).text)).toEqual([
      'Hello ',
      'world',
    ]);
  });

  it('normalises the stop reason and carries the usage the provider reported', async () => {
    const model = await new OllamaProvider({ fetch: ollamaStub({ known: ['q:1b'], doneReason: 'length' }).fetch }).model(
      'q:1b',
    );

    const end = (await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] }))).at(-1);

    expect(end).toMatchObject({ type: 'end', stopReason: 'max-tokens', usage: { promptTokens: 42, outputTokens: 7 } });
  });

  it('sends temperature 0 by default, so an answer is reproducible', async () => {
    const stub = ollamaStub({ known: ['q:1b'] });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] }));

    const chat = stub.calls.find((call) => call.url.endsWith('/api/chat'));

    expect((chat?.body as { options?: { temperature?: number } }).options?.temperature).toBe(0);
    expect((chat?.body as { stream?: boolean }).stream).toBe(true);
  });

  it('passes the messages through unchanged', async () => {
    const stub = ollamaStub({ known: ['q:1b'] });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    await drain(
      model.generate({
        messages: [
          { role: 'system', content: 'rules' },
          { role: 'user', content: 'question' },
        ],
      }),
    );

    const chat = stub.calls.find((call) => call.url.endsWith('/api/chat'));

    expect((chat?.body as { messages: unknown }).messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'question' },
    ]);
  });

  it('translates a mid-stream error, keeping what had already arrived', async () => {
    const stub = ollamaStub({ known: ['q:1b'], chunks: ['partial'], streamError: 'context length exceeded' });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    const error = (await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] })).catch(
      (cause: unknown) => cause,
    )) as AiError;

    expect(error.code).toBe('context-window-exceeded');
    expect(error.partial).toBe('partial');
  });

  it('reports a truncated stream rather than a complete answer', async () => {
    const stub = ollamaStub({ known: ['q:1b'], chunks: ['half'], truncate: true });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    const error = (await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] })).catch(
      (cause: unknown) => cause,
    )) as AiError;

    expect(error.code).toBe('stream-interrupted');
    expect(error.partial).toBe('half');
  });

  it('translates an out-of-memory refusal to model-load-failed', async () => {
    const stub = ollamaStub({ known: ['q:1b'], httpStatus: 500 });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    const error = (await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] })).catch(
      (cause: unknown) => cause,
    )) as AiError;

    expect(error.code).toBe('model-load-failed');
  });

  it('reports an unreachable daemon as provider-unavailable', async () => {
    const provider = new OllamaProvider({ fetch: ollamaStub({ known: ['q:1b'] }).fetch });
    const model = await provider.model('q:1b');
    const broken = new OllamaProvider({ fetch: ollamaStub({ unreachable: true }).fetch });

    expect(model).toBeDefined();
    await expect(broken.listModels()).rejects.toMatchObject({ code: 'provider-unavailable' });
  });

  it('reports a non-JSON stream line as a protocol error', async () => {
    const stub = ollamaStub({ known: ['q:1b'], malformedBody: 'this is not json\n' });
    const model = await new OllamaProvider({ fetch: stub.fetch }).model('q:1b');

    const error = (await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] })).catch(
      (cause: unknown) => cause,
    )) as AiError;

    expect(error.code).toBe('provider-protocol-error');
  });

  it('refuses immediately when the caller has already aborted', async () => {
    const controller = new AbortController();

    controller.abort();

    const model = await new OllamaProvider({ fetch: ollamaStub({ known: ['q:1b'] }).fetch }).model('q:1b');

    await expect(
      drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal)),
    ).rejects.toMatchObject({ code: 'generation-aborted' });
  });

  it('times out when the provider opens a stream and then sends nothing', async () => {
    // A local model on a cold start can be slow to first token, so the timeout is on idleness rather than
    // on total duration. The body is opened and then simply never produces a line.
    const silent: typeof globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({ model_info: { 'x.context_length': 4096 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately never enqueues and never closes.
          },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    // Before any token has arrived it is the *first-token* deadline that applies, not the idle one:
    // prompt evaluation is legitimately silent for minutes, so one deadline covering both would either
    // kill a healthy prompt or fail to notice a dead stream.
    const model = await new OllamaProvider({ fetch: silent, firstTokenTimeoutMs: 30, idleTimeoutMs: 30 }).model(
      'q:1b',
    );

    await expect(
      drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toMatchObject({ code: 'generation-timeout' });
  }, 10_000);

  it('waits out a long prompt evaluation rather than calling it a timeout', async () => {
    // The generous first-token deadline is the whole reason two exist: a provider that is quiet for
    // longer than the between-token limit while it reads the prompt is working, not broken.
    const slow: typeof globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({ model_info: { 'x.context_length': 4096 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ message: { content: 'ok' } })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`,
                ),
              );
              controller.close();
            }, 120);
          },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const model = await new OllamaProvider({ fetch: slow, firstTokenTimeoutMs: 2000, idleTimeoutMs: 20 }).model(
      'q:1b',
    );

    const events = await drain(model.generate({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(events.some((event) => event.type === 'delta')).toBe(true);
  }, 10_000);
});

describe('readNdjson', () => {
  it('reassembles objects split across byte boundaries', async () => {
    const payload = `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ b: 2 })}\n`;
    const seen: unknown[] = [];

    // Three bytes at a time, so almost every object arrives in pieces.
    for await (const value of readNdjson(splitStream(payload, 3))) {
      seen.push(value);
    }

    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('yields a final object with no trailing newline', async () => {
    const seen: unknown[] = [];

    for await (const value of readNdjson(splitStream('{"a":1}', 100))) {
      seen.push(value);
    }

    expect(seen).toEqual([{ a: 1 }]);
  });

  it('ignores blank lines', async () => {
    const seen: unknown[] = [];

    for await (const value of readNdjson(splitStream('\n\n{"a":1}\n\n', 100))) {
      seen.push(value);
    }

    expect(seen).toEqual([{ a: 1 }]);
  });

  it('raises a protocol error rather than skipping a line it cannot parse', async () => {
    const read = async (): Promise<void> => {
      for await (const _ of readNdjson(splitStream('{"a":1}\nnot json\n', 100))) {
        // Silently skipping would turn a version mismatch into a quietly incomplete answer.
      }
    };

    await expect(read()).rejects.toMatchObject({ code: 'provider-protocol-error' });
  });

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController();

    controller.abort();

    const seen: unknown[] = [];

    for await (const value of readNdjson(splitStream('{"a":1}\n', 100), controller.signal)) {
      seen.push(value);
    }

    expect(seen).toEqual([]);
  });
});

/**
 * A real model, opt-in.
 *
 * Skipped unless `TRACEIQ_OLLAMA_LIVE=1` and a model is named, because it needs a running daemon and
 * downloaded weights. Never in CI: it asserts that the protocol works against the real thing, not that a
 * given model answers well.
 */
const live = process.env.TRACEIQ_OLLAMA_LIVE === '1' && process.env.TRACEIQ_OLLAMA_MODEL !== undefined;

describe.skipIf(!live)('against a real provider', () => {
  it('reports health, lists models and streams an answer', async () => {
    const provider = new OllamaProvider();
    const health = await provider.health();

    expect(health.available).toBe(true);

    const model = await provider.model(process.env.TRACEIQ_OLLAMA_MODEL ?? '');
    const events = await drain(
      model.generate({ messages: [{ role: 'user', content: 'Reply with exactly: ok' }], maxOutputTokens: 16 }),
    );

    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('end');
  }, 120_000);
});
