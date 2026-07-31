import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from './api-client';
import { parseFrame, streamChat } from './chat-service';
import type { ChatEvent } from '@/types/api';

/**
 * The SSE client.
 *
 * The frames are built by hand and split at awkward byte boundaries, because reassembling a delta that
 * arrived in two pieces is the one thing a hand-written stream reader gets wrong.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

/** A response whose body yields the given chunks, exactly as written. */
function eventStream(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const GROUNDING = {
  kind: 'repository',
  subject: null,
  factCount: 64,
  tier: 'standard',
  tokens: 1920,
  digest: 'c0a8bdfbb1fe2e3f',
  omissions: [{ part: 'cycles', kept: 15, total: 18 }],
};

const ANSWER = {
  question: 'q',
  subject: { kind: 'repository' },
  text: 'It has 228 files [f2].',
  verdict: 'grounded',
  citations: [
    { factId: 'f2', subject: 'repository', predicate: 'contains', object: '228 files', confidence: 'CERTAIN', provenance: '@traceiq/explorer' },
  ],
  fabricatedIdentifiers: [],
  unknownCitations: [],
  grounding: GROUNDING,
  model: 'test:1b',
  stopReason: 'complete',
  usage: { promptTokens: 2002, outputTokens: 13 },
};

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];

  for await (const event of events) {
    out.push(event);
  }

  return out;
}

const REQUEST = { question: 'q', subject: { kind: 'repository' } } as const;

describe('parseFrame', () => {
  it('reads each event type', () => {
    expect(parseFrame('event: open\ndata: {"model":"m"}')).toEqual({ type: 'open', model: 'm' });
    expect(parseFrame(`event: grounding\ndata: ${JSON.stringify(GROUNDING)}`)).toMatchObject({ type: 'grounding' });
    expect(parseFrame('event: delta\ndata: {"text":"hi"}')).toEqual({ type: 'delta', text: 'hi' });
    expect(parseFrame(`event: complete\ndata: ${JSON.stringify(ANSWER)}`)).toMatchObject({ type: 'complete' });
  });

  it('reads an error frame with its partial text', () => {
    expect(
      parseFrame('event: error\ndata: {"code":"stream-interrupted","detail":"d","hint":"h","partial":"half"}'),
    ).toEqual({ type: 'error', code: 'stream-interrupted', detail: 'd', hint: 'h', partial: 'half' });
  });

  it('ignores a comment, an unknown name and a frame with no data', () => {
    expect(parseFrame(': keep-alive')).toBeNull();
    expect(parseFrame('event: unheard-of\ndata: {}')).toBeNull();
    expect(parseFrame('event: delta')).toBeNull();
  });

  it('drops a frame whose data is not JSON rather than crashing the stream', () => {
    // What has already arrived is still worth showing; the terminal frame decides the outcome.
    expect(parseFrame('event: delta\ndata: not json')).toBeNull();
  });

  it('rejoins a payload split across several data lines, as the format allows', () => {
    expect(parseFrame('event: delta\ndata: {"text":\ndata: "hi"}')).toEqual({ type: 'delta', text: 'hi' });
  });
});

describe('streamChat', () => {
  it('yields frames in the order the server sent them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      eventStream([frame('open', { model: 'test:1b' }), frame('grounding', GROUNDING), frame('delta', { text: 'a' }), frame('complete', ANSWER)]),
    );

    const events = await collect(streamChat(REQUEST));

    expect(events.map((event) => event.type)).toEqual(['open', 'grounding', 'delta', 'complete']);
  });

  it('posts to the stream endpoint with the question and subject', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(eventStream([frame('complete', ANSWER)]));

    await collect(streamChat(REQUEST));

    expect(spy.mock.calls[0]?.[0]).toBe('/api/chat/stream');
    expect(spy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({ question: 'q', subject: { kind: 'repository' } });
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The whole point of a hand-written reader: a delta arriving in two TCP chunks must not be lost.
    const whole = frame('delta', { text: 'hello world' });
    const cut = Math.floor(whole.length / 2);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(eventStream([whole.slice(0, cut), whole.slice(cut)]));

    expect(await collect(streamChat(REQUEST))).toEqual([{ type: 'delta', text: 'hello world' }]);
  });

  it('reassembles a stream delivered one byte at a time', async () => {
    const whole = `${frame('delta', { text: 'ab' })}${frame('complete', ANSWER)}`;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(eventStream([...whole]));

    expect((await collect(streamChat(REQUEST))).map((event) => event.type)).toEqual(['delta', 'complete']);
  });

  it('yields several frames arriving in one chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      eventStream([`${frame('delta', { text: 'a' })}${frame('delta', { text: 'b' })}`]),
    );

    expect(await collect(streamChat(REQUEST))).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
    ]);
  });

  it('raises the API error for a failure detected before the stream opened', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: { code: 'ai-not-configured', detail: 'no model', hint: 'set one' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );

    const error = (await collect(streamChat(REQUEST)).catch((cause: unknown) => cause)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('ai-not-configured');
    expect(error.status).toBe(503);
  });

  it('raises bad-response for a 200 that is somehow not a stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const error = (await collect(streamChat(REQUEST)).catch((cause: unknown) => cause)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
  });

  it('reports an unreachable API as a NetworkError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(collect(streamChat(REQUEST))).rejects.toBeInstanceOf(NetworkError);
  });

  it('ends quietly when the caller aborts before the response arrives', async () => {
    // An abort is the user's choice, not a failure to report.
    const controller = new AbortController();

    controller.abort();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    expect(await collect(streamChat(REQUEST, controller.signal))).toEqual([]);
  });

  it('passes the abort signal to fetch, so stopping really stops the model', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(eventStream([frame('complete', ANSWER)]));

    await collect(streamChat(REQUEST, controller.signal));

    expect(spy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('surfaces a terminal error frame rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      eventStream([
        frame('delta', { text: 'half ' }),
        frame('error', { code: 'stream-interrupted', detail: 'died', hint: 'retry', partial: 'half ' }),
      ]),
    );

    const events = await collect(streamChat(REQUEST));

    expect(events.map((event) => event.type)).toEqual(['delta', 'error']);
    expect(events[1]).toMatchObject({ code: 'stream-interrupted', partial: 'half ' });
  });

  it('tolerates a body that ends without a trailing blank line', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      eventStream([`${frame('delta', { text: 'a' })}event: delta\ndata: {"text":"b"}`]),
    );

    // The trailing partial frame is not yielded, because a frame is only complete at its separator — and
    // dropping it is correct: half a frame is not an event.
    expect(await collect(streamChat(REQUEST))).toEqual([{ type: 'delta', text: 'a' }]);
  });
});
