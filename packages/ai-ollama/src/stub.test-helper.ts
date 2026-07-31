/**
 * A stub speaking Ollama's HTTP protocol.
 *
 * A fake `fetch` rather than a real server: it needs no port, no teardown and no daemon, and it still
 * exercises the real streaming reader because the body is a genuine `ReadableStream` of NDJSON bytes. The
 * whole provider is therefore covered in CI with no model installed and no network.
 */
export interface StubOptions {
  /** Chunks the chat endpoint streams, in order. */
  readonly chunks?: readonly string[];
  readonly models?: readonly string[];
  readonly version?: string;
  /** Models `/api/show` knows. Anything else answers 404, as Ollama does. */
  readonly known?: readonly string[];
  readonly contextLength?: number;
  /** Emitted as a mid-stream `error` field, the way Ollama reports a failure after a 200. */
  readonly streamError?: string;
  /** Sent instead of NDJSON, to exercise the protocol-error path. */
  readonly malformedBody?: string;
  /** End the stream without a `done` line. */
  readonly truncate?: boolean;
  readonly httpStatus?: number;
  readonly unreachable?: boolean;
  readonly doneReason?: string;
}

export interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: { readonly url: string; readonly body: unknown }[];
}

export function ollamaStub(options: StubOptions = {}): Stub {
  const calls: { url: string; body: unknown }[] = [];

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));

    calls.push({ url, body });

    if (options.unreachable === true) {
      throw new TypeError('fetch failed');
    }

    if (init?.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    if (url.endsWith('/api/version')) {
      return json({ version: options.version ?? '0.31.1' }, options.httpStatus ?? 200);
    }

    if (url.endsWith('/api/tags')) {
      return json({ models: (options.models ?? ['qwen:7b', 'alpha:1b']).map((name) => ({ model: name })) }, options.httpStatus ?? 200);
    }

    if (url.endsWith('/api/show')) {
      const requested = (body as { model?: string } | null)?.model ?? '';
      const known = options.known ?? options.models ?? ['qwen:7b', 'alpha:1b'];

      if (!known.includes(requested)) {
        return json({ error: 'model not found' }, 404);
      }

      return json(
        {
          details: { family: 'testfamily' },
          model_info: { 'testfamily.context_length': options.contextLength ?? 8192 },
        },
        200,
      );
    }

    if (url.endsWith('/api/chat')) {
      if (options.httpStatus !== undefined && options.httpStatus >= 400) {
        return new Response('the model requires more system memory than is available', {
          status: options.httpStatus,
        });
      }

      if (options.malformedBody !== undefined) {
        return new Response(stream([options.malformedBody]), { status: 200 });
      }

      const lines = (options.chunks ?? ['Hello ', 'world']).map((text) =>
        `${JSON.stringify({ model: 'stub', message: { role: 'assistant', content: text }, done: false })}\n`,
      );

      if (options.streamError !== undefined) {
        lines.push(`${JSON.stringify({ error: options.streamError })}\n`);
      } else if (options.truncate !== true) {
        lines.push(
          `${JSON.stringify({
            model: 'stub',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: options.doneReason ?? 'stop',
            prompt_eval_count: 42,
            eval_count: 7,
          })}\n`,
        );
      }

      return new Response(stream(lines), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  return { fetch: stub as typeof globalThis.fetch, calls };
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** A real byte stream, so the NDJSON reader is exercised rather than bypassed. */
function stream(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }

      controller.close();
    },
  });
}

/** Splits a payload across arbitrary byte boundaries, so partial-line handling is genuinely tested. */
export function splitStream(payload: string, size: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(payload);

  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }

      controller.close();
    },
  });
}
