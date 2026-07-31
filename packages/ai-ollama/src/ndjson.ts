import { protocolError } from '@traceiq/ai';

/**
 * Reads newline-delimited JSON from a response body.
 *
 * **Nothing is buffered whole.** A generation streams for as long as the model talks, so accumulating the
 * body would defeat the point and would hold a large answer in memory for no reason. Only the current
 * partial line is retained.
 *
 * A line that is not JSON is a protocol failure, not something to skip: silently ignoring it would turn a
 * version mismatch into an answer that is quietly missing pieces.
 */
/** Resolved instead of a chunk when the caller aborts. A sentinel rather than a throw: raising the right
 *  error is the model layer's job, and it knows whether the abort was a cancellation or a timeout. */
const ABORTED = Symbol('aborted');

export async function* readNdjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();

  /**
   * The abort, as a promise to race against a read.
   *
   * Checking `signal.aborted` between reads is not enough: a provider that opens a stream and then sends
   * nothing leaves the reader blocked *inside* `read()`, and the flag is never looked at again. A real
   * `fetch` body does error when its signal aborts, but relying on that would make an idle timeout
   * unenforceable against any body that does not — so the race is done here.
   */
  const abortion =
    signal === undefined
      ? null
      : new Promise<typeof ABORTED>((resolve) => {
          if (signal.aborted) {
            resolve(ABORTED);

            return;
          }

          signal.addEventListener('abort', () => {
            resolve(ABORTED);
          }, { once: true });
        });

  let pending = '';

  try {
    // An already-aborted signal must yield nothing. Racing would be non-deterministic here: both promises
    // are effectively settled, and `Promise.race` would resolve whichever it subscribed to first.
    if (signal?.aborted === true) {
      await reader.cancel().catch(() => undefined);

      return;
    }

    for (;;) {
      const next = abortion === null ? await reader.read() : await Promise.race([reader.read(), abortion]);

      if (next === ABORTED) {
        // Cancelling releases the underlying stream so a stalled provider connection is not held open.
        await reader.cancel().catch(() => undefined);

        return;
      }

      const { done, value } = next;

      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });

      let newline = pending.indexOf('\n');

      while (newline !== -1) {
        const line = pending.slice(0, newline).trim();

        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');

        if (line !== '') {
          yield parse(line);
        }
      }
    }

    // A body that ended without a trailing newline still holds one complete object.
    const tail = pending.trim();

    if (tail !== '') {
      yield parse(tail);
    }
  } finally {
    // Releasing the lock lets the body be cancelled by the caller that owns the response.
    reader.releaseLock();
  }
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (cause) {
    throw protocolError(`the provider sent a line that is not JSON: ${line.slice(0, 120)}`, cause);
  }
}
