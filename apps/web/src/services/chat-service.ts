import { API_BASE, ApiError, NetworkError } from './api-client';
import type { ChatAnswer, ChatEvent, ChatGrounding, ChatPhase, ChatRequest } from '@/types/api';

/**
 * The chat endpoints. Nothing else in the app knows these URLs.
 *
 * **Streamed with `fetch`, not `EventSource`.** `EventSource` can only issue a GET and cannot send a body,
 * and a chat request carries a question, a subject and a conversation. So the SSE wire format is parsed by
 * hand from the response body — which is a dozen lines and removes the need for a second transport.
 */

/**
 * Streams an answer, yielding each frame as it arrives.
 *
 * `signal` is honoured twice over: it aborts the request, and it ends the iteration. Aborting matters — a
 * local model keeps generating for as long as the connection is open, so a user pressing Stop must actually
 * stop it rather than just stop watching.
 */
export async function* streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    // An abort before the response arrives is the user's choice, not a failure to report.
    if (isAbort(cause)) {
      return;
    }

    throw new NetworkError(cause);
  }

  // A failure detected before the stream opened is still an ordinary JSON error with a real status: the
  // server opens the stream lazily on its first frame precisely so this stays true.
  if (!response.ok || (response.headers.get('content-type') ?? '').includes('application/json')) {
    throw await toApiError(response);
  }

  if (response.body === null) {
    throw new ApiError({
      code: 'bad-response',
      detail: 'the API returned no body for a streaming request',
      hint: 'check that TRACEIQ_API_URL points at a running TraceIQ API',
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  /**
   * The abort, as a promise to race against a read.
   *
   * A real `fetch` body errors when its signal aborts, so this is belt to that braces — but only just: any
   * body that does not honour the signal would leave `reader.read()` blocked forever, and Stop would appear
   * to do nothing while a local model kept generating. Racing makes cancellation the reader's own guarantee.
   */
  const abortion =
    signal === undefined
      ? null
      : new Promise<'aborted'>((resolve) => {
          if (signal.aborted) {
            resolve('aborted');

            return;
          }

          signal.addEventListener('abort', () => {
            resolve('aborted');
          }, { once: true });
        });

  try {
    for (;;) {
      const next = abortion === null ? await reader.read() : await Promise.race([reader.read(), abortion]);

      if (next === 'aborted') {
        return;
      }

      const { done, value } = next;

      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Anything after the last separator is a partial frame and is
      // kept for the next read rather than parsed — a delta split across two chunks must not be lost.
      let boundary = pending.indexOf('\n\n');

      while (boundary !== -1) {
        const block = pending.slice(0, boundary);

        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf('\n\n');

        const event = parseFrame(block);

        if (event !== null) {
          yield event;
        }
      }
    }
  } catch (cause) {
    if (!isAbort(cause)) {
      throw new NetworkError(cause);
    }
  } finally {
    // Cancelling releases the connection, which is what actually stops the model.
    await reader.cancel().catch(() => undefined);
  }
}

/** One `event:`/`data:` block. Returns `null` for a comment or an unrecognised name. */
export function parseFrame(block: string): ChatEvent | null {
  const lines = block.split('\n');
  const name = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');

  if (name === undefined || data === '') {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(data);
  } catch {
    // A frame this client cannot parse is dropped rather than crashing the stream: the answer so far is
    // still worth showing, and the terminal frame is what decides the outcome.
    return null;
  }

  switch (name) {
    case 'open': {
      const open = payload as { model?: string | null; contextWindow?: number | null };

      return { type: 'open', model: open.model ?? null, contextWindow: open.contextWindow ?? null };
    }
    case 'status': {
      const phase = (payload as { phase?: string }).phase;

      // An unknown phase is dropped rather than rendered: the vocabulary is closed on the server, and a
      // frontend that guessed at a new one would print a raw slug at a user.
      return phase === undefined ? null : { type: 'status', phase: phase as ChatPhase };
    }
    case 'grounding':
      return { type: 'grounding', grounding: payload as ChatGrounding };
    case 'delta':
      return { type: 'delta', text: (payload as { text?: string }).text ?? '' };
    case 'restart': {
      const reasons = (payload as { reasons?: readonly string[] }).reasons;

      return { type: 'restart', reasons: reasons ?? [] };
    }
    case 'complete':
      return { type: 'complete', answer: payload as ChatAnswer };
    case 'error': {
      const error = payload as { code?: string; detail?: string; hint?: string; partial?: string | null };

      return {
        type: 'error',
        code: error.code ?? 'bad-response',
        detail: error.detail ?? 'the stream failed without saying why',
        hint: error.hint ?? '',
        partial: error.partial ?? null,
      };
    }
    default:
      return null;
  }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code: string; detail: string; hint: string } };

    if (body.error !== undefined) {
      return new ApiError({ ...body.error, status: response.status });
    }
  } catch {
    // Falls through to the generic shape below.
  }

  return new ApiError({
    code: 'bad-response',
    detail: `the API returned ${response.status} for a chat request`,
    hint: 'check that a model is configured on the API',
    status: response.status,
  });
}
