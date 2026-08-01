import type { Response } from 'express';

/**
 * Server-sent events.
 *
 * **Why SSE and not a JSON array.** An answer arrives token by token over seconds; a client that had to
 * wait for the whole body would show nothing for ten seconds and then everything at once. SSE is a plain
 * `text/event-stream`, needs no protocol negotiation, and reconnects are the client's business.
 *
 * **Why a terminal `error` frame exists at all.** Once the first byte is written the status line is gone,
 * so a failure halfway through cannot become a 500 — the response is already a successful 200. The AI
 * layer throws, as designed, and this translates that throw into a final frame. Without it a client could
 * not tell a completed answer from a stream that died.
 */
export interface EventSink {
  /** Writes one named event, opening the stream if this is the first. Returns `false` once the client has gone. */
  send(event: string, data: unknown): boolean;
  /** Whether the client is still connected. */
  readonly open: boolean;
  /** Whether any frame has been written. Once true, the status can no longer change. */
  readonly started: boolean;
  /** Stops the keep-alive timer. Idempotent, and called automatically when the client disconnects. */
  close(): void;
}

/**
 * How often a silent stream writes a comment frame.
 *
 * **Chosen against the tightest hop in a realistic chain, not against this deployment.** Next's
 * built-in proxy defaults to a 30-second inactivity timeout (`proxyTimeout` in
 * `router-utils/proxy-request`), nginx's `proxy_read_timeout` is 60 seconds, and managed edges sit
 * around 60–100. Ten seconds is under a third of the tightest of those, so two heartbeats can be lost
 * to scheduling and the connection still survives.
 *
 * The cost is one 15-byte write per ten seconds of silence. The alternative costs an answer.
 */
export const HEARTBEAT_MS = 10_000;

/**
 * Prepares a stream on a response, **opening it on the first frame**.
 *
 * Laziness is the point. Writing the headers eagerly fixes the status at 200 before the handler has
 * validated anything, so a malformed body came back as a 200 carrying an error frame instead of a 400.
 * Deferring the headers until something is actually sent means every failure raised *before* the first
 * frame — a bad body, an unknown subject, no model configured — is still an ordinary JSON error with a
 * real status, and only a failure genuinely mid-answer becomes a terminal frame.
 *
 * Buffering is disabled explicitly: a proxy that batched this would defeat the point, and
 * `X-Accel-Buffering` is the one hint nginx honours.
 */
export function openEventStream(response: Response, heartbeatMs: number = HEARTBEAT_MS): EventSink {
  let open = true;
  let started = false;
  let timer: NodeJS.Timeout | undefined;

  /**
   * The keep-alive, rearmed after every write.
   *
   * **A comment frame, not an event.** `:` opens a comment in the SSE grammar; every conformant parser
   * discards the line, including this repository's own `parseFrame`, which finds no `event:` in the
   * block and returns `null`. So the bytes reset every inactivity timer between here and the browser
   * while adding nothing a consumer has to know about.
   *
   * Rearming on each write rather than ticking unconditionally means a stream producing tokens never
   * pays for this at all — the timer only ever fires during genuine silence.
   */
  const rearm = (): void => {
    clearTimeout(timer);

    if (!open || heartbeatMs <= 0) {
      return;
    }

    timer = setTimeout(() => {
      if (!open || !started) {
        return;
      }

      response.write(': keep-alive\n\n');
      rearm();
    }, heartbeatMs);

    // A pending heartbeat must not be the reason a process stays alive.
    timer.unref?.();
  };

  const stop = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };

  response.on('close', () => {
    open = false;
    stop();
  });

  const start = (): void => {
    if (started) {
      return;
    }

    started = true;
    response.status(200);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();
  };

  return {
    get open(): boolean {
      return open;
    },

    get started(): boolean {
      return started;
    },

    close(): void {
      stop();
    },

    send(event: string, data: unknown): boolean {
      if (!open) {
        return false;
      }

      start();
      rearm();

      // One `data:` line per line of payload, as the format requires. JSON never contains a raw newline,
      // so a single line is always enough — but splitting anyway costs nothing and cannot be wrong.
      const payload = JSON.stringify(data);
      const lines = payload.split('\n').map((line) => `data: ${line}`);

      response.write(`event: ${event}\n${lines.join('\n')}\n\n`);

      return true;
    },
  };
}
