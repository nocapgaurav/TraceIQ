import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

import { HEARTBEAT_MS, openEventStream } from './sse.js';

/**
 * The keep-alive.
 *
 * **Tested against a clock rather than against a model**, because the thing it protects is a silence
 * that was measured at 102 seconds on the reference stack — the gap between the last preparatory frame
 * and the first token, all of it the provider reading the prompt. Reproducing that with a real model
 * takes two minutes per assertion; reproducing it with a fake timer takes none.
 */
function fakeResponse(): Response & { readonly written: string[] } {
  const written: string[] = [];
  const handlers = new Map<string, () => void>();

  return {
    written,
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    status: () => undefined,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      written.push(chunk);

      return true;
    },
    // Exposed so a test can close the stream the way the runtime does.
    emit: (event: string) => handlers.get(event)?.(),
  } as unknown as Response & { readonly written: string[] };
}

describe('the keep-alive', () => {
  it('writes a comment frame after a silent interval', () => {
    vi.useFakeTimers();

    try {
      const response = fakeResponse();
      const sink = openEventStream(response, 100);

      sink.send('open', { model: 'm' });
      expect(response.written).toHaveLength(1);

      vi.advanceTimersByTime(350);

      // Three intervals of silence, three comments — and a comment is exactly what a conformant SSE
      // parser discards, so the bytes cost a consumer nothing while resetting every idle timer between
      // here and the browser.
      expect(response.written.filter((chunk) => chunk.startsWith(': '))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tick while frames are flowing, so a fast answer never pays for it', () => {
    vi.useFakeTimers();

    try {
      const response = fakeResponse();
      const sink = openEventStream(response, 100);

      for (let index = 0; index < 5; index += 1) {
        sink.send('delta', { text: 'x' });
        vi.advanceTimersByTime(80);
      }

      expect(response.written.filter((chunk) => chunk.startsWith(': '))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when the client disconnects, so nothing writes to a dead socket', () => {
    vi.useFakeTimers();

    try {
      const response = fakeResponse();
      const sink = openEventStream(response, 100);

      sink.send('open', {});
      (response as unknown as { emit(event: string): void }).emit('close');
      vi.advanceTimersByTime(500);

      expect(response.written.filter((chunk) => chunk.startsWith(': '))).toHaveLength(0);
      expect(sink.open).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when the answer closes it', () => {
    vi.useFakeTimers();

    try {
      const response = fakeResponse();
      const sink = openEventStream(response, 100);

      sink.send('complete', {});
      sink.close();
      vi.advanceTimersByTime(500);

      expect(response.written.filter((chunk) => chunk.startsWith(': '))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is well under the tightest timeout in a realistic proxy chain', () => {
    // Next's own proxy defaults to 30s of inactivity, nginx's proxy_read_timeout to 60s. A third of
    // the tightest leaves room for two heartbeats to be lost to scheduling.
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(30_000 / 3);
  });
});
