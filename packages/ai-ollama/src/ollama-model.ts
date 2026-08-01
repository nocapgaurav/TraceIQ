import {
  AiError,
  estimatingCounter,
  type GenerationRequest,
  type LanguageModel,
  type ModelDescription,
  type ModelEvent,
  type StopReason,
  type TokenCounter,
  type TokenUsage,
} from '@traceiq/ai';

import { readNdjson } from './ndjson.js';

/**
 * One Ollama model, behind the shared interface.
 *
 * Everything vendor-specific ends here: the wire format, the field names, the stop-reason vocabulary and
 * the failure modes are all translated at this edge, so nothing above `LanguageModel` learns what is
 * answering.
 *
 * Plain `fetch` and a line reader rather than an SDK. Ollama's chat endpoint is documented HTTP with a
 * newline-delimited JSON body, and Node has everything needed natively — so the whole AI layer keeps a
 * runtime dependency count of zero, and no vendor type is ever in a position to leak upward.
 */
export interface OllamaModelOptions {
  readonly baseUrl: string;
  readonly id: string;
  /**
   * The context the runtime will actually be given, and the number the budget is computed from.
   *
   * **These used to be two different numbers, and that was the single largest defect in the AI layer.**
   * `/api/show` reports the *trained* context length — 32,768 for the model this was measured on — and
   * the projection budgeted against it. The daemon, given no `num_ctx`, chooses its own and resizes it
   * between requests; measured on a live stack, a 6,043-token prompt came back with
   * `prompt_eval_count: 2050` and a 24,811-token prompt with the same 2,050. The excess is discarded
   * from the **front**, so what is dropped is the system prompt and the highest-priority facts. Asked
   * to repeat the first fact id of 300, the model answered `[f241]`; of 1,200, `[f1148]`. Every rule
   * about citing, every identity fact and every limitation had been cut before the model read a word.
   *
   * So this value is now sent to the daemon as `num_ctx` on every request as well as being reported
   * upward, and the two cannot disagree. It is also held **constant for the life of the model**:
   * changing `num_ctx` makes the daemon reload the weights, measured at 106.8 s, which would otherwise
   * be paid by whichever unlucky request differed from the last.
   */
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  /**
   * No token from the provider within this long, **once tokens have started**, is a timeout.
   *
   * Separate from `firstTokenTimeoutMs` because the two measure different things. Between tokens a
   * healthy local model is silent for milliseconds; before the first token it is silent for as long as
   * the prompt takes to evaluate, which was measured at 45.75 tokens per second — 89 seconds for a
   * 4,087-token prompt. One timeout covering both is either too tight to survive a real prompt or too
   * loose to notice a dead stream.
   */
  readonly idleTimeoutMs: number;
  /** Nothing at all from the provider within this long is a timeout. Covers prompt evaluation. */
  readonly firstTokenTimeoutMs: number;
  readonly fetch: typeof globalThis.fetch;
}

/** What a chat response line looks like. Only the fields actually read are declared. */
interface ChatLine {
  readonly message?: { readonly content?: string };
  readonly done?: boolean;
  readonly done_reason?: string;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly error?: string;
}

export class OllamaModel implements LanguageModel {
  readonly tokens: TokenCounter;

  readonly #options: OllamaModelOptions;

  constructor(options: OllamaModelOptions) {
    this.#options = options;

    // Ollama exposes no tokeniser over HTTP, so the shared estimator is used and the budget is sized with
    // a margin. A provider that could count exactly would supply its own counter here instead.
    this.tokens = estimatingCounter;
  }

  describe(): ModelDescription {
    return {
      id: this.#options.id,
      contextWindow: this.#options.contextWindow,
      maxOutputTokens: this.#options.maxOutputTokens,
      // Ollama carries a system message natively. Tools are not declared: this layer defines none, and a
      // tool that read the repository would be a second inbound data path.
      capabilities: new Set(['system-prompt'] as const),
    };
  }

  async *generate(request: GenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal?.aborted === true) {
      throw new AiError('generation-aborted', 'the generation was cancelled before it started', { partial: '' });
    }

    // A composed controller so an idle stream can be cut without the caller's signal being touched.
    // `cancelled` is tracked rather than re-read from the signal: the guard above narrows `aborted` to
    // false for the rest of the function, and a flag set by the listener is in any case the more accurate
    // question — did the caller abort *during this generation*.
    const controller = new AbortController();
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      controller.abort();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    let idleTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let waitedMs = this.#options.firstTokenTimeoutMs;

    // Two deadlines behind one timer. Until the first token arrives the generous one applies, because
    // the provider is evaluating the prompt and silence is expected; afterwards the tight one does,
    // because silence between tokens means the stream has died.
    const resetIdle = (limitMs: number): void => {
      waitedMs = limitMs;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limitMs);
    };

    let delivered = '';

    try {
      resetIdle(this.#options.firstTokenTimeoutMs);

      const response = await this.#post('/api/chat', {
        model: this.#options.id,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        options: {
          // Temperature 0 by default: an answer about a repository should be reproducible, and the whole
          // pipeline below is deterministic. Sampling would be the only source of variation left.
          temperature: request.temperature ?? 0,
          // Always sent, always the same. See `contextWindow` above: omitting it hands the daemon the
          // decision, and the daemon answers it differently between requests and truncates the prompt
          // from the front without saying so.
          num_ctx: this.#options.contextWindow,
          ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
          ...(request.stopSequences === undefined ? {} : { stop: [...request.stopSequences] }),
        },
      }, controller.signal);

      if (response.body === null) {
        throw new AiError('provider-protocol-error', 'the provider returned no body for a streaming request');
      }

      yield { type: 'start', model: this.#options.id };

      let stopReason: StopReason = 'complete';
      let usage: TokenUsage = { promptTokens: null, outputTokens: null };

      for await (const line of readNdjson(response.body, controller.signal)) {
        // A line arrived, so the provider is alive. Which deadline applies next depends on whether any
        // text has been delivered yet — a keep-alive line before the first token does not mean the
        // prompt has finished evaluating.
        resetIdle(delivered === '' ? this.#options.firstTokenTimeoutMs : this.#options.idleTimeoutMs);

        const chunk = line as ChatLine;

        // Ollama reports a mid-stream failure as an `error` field rather than a status, because the status
        // line is long gone by then.
        if (typeof chunk.error === 'string') {
          throw this.#translate(chunk.error, delivered);
        }

        const text = chunk.message?.content ?? '';

        if (text !== '') {
          delivered += text;
          yield { type: 'delta', text };
        }

        if (chunk.done === true) {
          stopReason = normaliseStopReason(chunk.done_reason);
          usage = {
            promptTokens: chunk.prompt_eval_count ?? null,
            outputTokens: chunk.eval_count ?? null,
          };
          yield { type: 'end', stopReason, usage };

          return;
        }
      }

      // The body ended without a `done` line: the answer is incomplete and saying so is the only honest
      // option. The partial text is attached rather than discarded.
      throw new AiError('stream-interrupted', 'the provider closed the stream before the answer finished', {
        partial: delivered,
      });
    } catch (cause) {
      // Order matters: a timeout aborts through the same controller a cancellation does, so asking
      // "was it cancelled" first would report every timeout as the user's own doing.
      if (timedOut) {
        throw new AiError(
          'generation-timeout',
          delivered === ''
            ? `the provider produced no output within ${Math.round(waitedMs / 1000)}s of receiving the prompt`
            : `the provider stopped mid-answer, sending nothing for ${Math.round(waitedMs / 1000)}s`,
          { cause, partial: delivered },
        );
      }

      if (cancelled) {
        throw new AiError('generation-aborted', 'the generation was cancelled by the caller', { partial: delivered });
      }

      throw cause instanceof AiError ? cause : this.#connectionError(cause, delivered);
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let response: Response;

    try {
      response = await this.#options.fetch(`${this.#options.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw this.#connectionError(cause, '');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      throw this.#translate(detail === '' ? `HTTP ${response.status}` : detail, '', response.status);
    }

    return response;
  }

  /** Turns a provider message into this layer's vocabulary. Nothing above ever sees Ollama's wording. */
  #translate(detail: string, partial: string, status?: number): AiError {
    const lower = detail.toLowerCase();

    if (lower.includes('not found') || (status === 404 && lower.includes('model'))) {
      return new AiError('model-not-found', `the provider has no model named '${this.#options.id}'`);
    }

    if (lower.includes('context length') || lower.includes('too long') || lower.includes('exceeds context')) {
      return new AiError('context-window-exceeded', detail, { partial });
    }

    if (lower.includes('memory') || lower.includes('failed to load') || lower.includes('unable to load')) {
      return new AiError('model-load-failed', detail);
    }

    return new AiError('provider-protocol-error', detail, { partial });
  }

  #connectionError(cause: unknown, partial: string): AiError {
    return new AiError(
      'provider-unavailable',
      `could not reach the model provider at ${this.#options.baseUrl}`,
      { cause, partial },
    );
  }
}

/** Ollama's reasons, mapped onto the shared closed vocabulary. */
function normaliseStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'length':
      return 'max-tokens';
    case 'stop':
      return 'stop-sequence';
    case 'aborted':
      return 'aborted';
    default:
      return 'complete';
  }
}
