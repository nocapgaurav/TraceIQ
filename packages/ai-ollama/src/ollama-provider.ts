import {
  AiError,
  modelNotFound,
  providerUnavailable,
  type LanguageModel,
  type ModelDescription,
  type ModelProvider,
  type ProviderHealth,
} from '@traceiq/ai';

import { OllamaModel } from './ollama-model.js';

/**
 * The Ollama provider.
 *
 * The only place in TraceIQ that knows Ollama exists. An application composition root constructs one,
 * takes a `LanguageModel` from it, and injects that into `RepositoryAnswerer` — which is why no vendor
 * name appears anywhere above this package.
 *
 * **No default model.** A model must always be named. Baking in a default would put a vendor's model
 * catalogue into the code and would answer, silently, with whatever happened to be installed.
 */
export interface OllamaOptions {
  /** Where the daemon is listening. Defaults to Ollama's documented local address. */
  readonly baseUrl?: string;
  /** No token within this long, once tokens have started, is a timeout. */
  readonly idleTimeoutMs?: number;
  /** Nothing at all within this long is a timeout. Covers prompt evaluation before the first token. */
  readonly firstTokenTimeoutMs?: number;
  /**
   * The largest runtime context to ask the daemon for, whatever the model claims it was trained with.
   *
   * A ceiling rather than a setting: the window used is `min(this, what the model reports)`, so naming
   * a big number here never asks a small model for a context it cannot hold.
   */
  readonly maxContextWindow?: number;
  /** Injectable so the contract tests can drive a stub with no daemon and no network. */
  readonly fetch?: typeof globalThis.fetch;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * How long the provider waits for the very first token.
 *
 * Sized from measurement rather than taste. Prompt evaluation on the reference stack — a 7B model,
 * CPU only, in a container — runs at **45.75 tokens per second**, so a prompt filling a 16,384-token
 * window would take close to six minutes before a single token came back. Six minutes is not a
 * product, but *failing at two* would report a working provider as broken, so the deadline is set
 * above the worst case the budget can produce and the wait is made visible instead of short.
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 420_000;

/**
 * The largest runtime context this provider will ask for by default.
 *
 * **Not the model's trained context length, and the difference is the point.** A window costs memory
 * for its key/value cache whether or not it is filled, and — because the projection is budgeted from
 * this number — it costs *latency* directly: at the measured 45.75 tokens per second, every 1,000
 * tokens of prompt is another 22 seconds before the answer starts. 16,384 leaves the `standard` tier
 * (6,000 fact tokens plus scaffolding, question and room to answer) fitting comfortably with the
 * runtime honouring every token of it, which is the property that was missing.
 *
 * Raise it with `maxContextWindow` where the deployment has the memory and the patience.
 */
export const DEFAULT_MAX_CONTEXT_WINDOW = 16_384;

/** A model as `/api/tags` reports it. Only the fields actually read are declared. */
interface TagLine {
  readonly name?: string;
  readonly model?: string;
}

/** What `/api/show` reports. `model_info` keys are prefixed by architecture, e.g. `llama.context_length`. */
interface ShowResponse {
  readonly model_info?: Readonly<Record<string, unknown>>;
  readonly details?: { readonly family?: string };
}

/**
 * Ollama reports no context window unless `/api/show` is asked, and even then only under an
 * architecture-prefixed key. This is the fallback when neither is available.
 *
 * 4096 is deliberately pessimistic: under-estimating the window costs facts, over-estimating produces a
 * rejected prompt. The projection steps down a tier on rejection, but starting low is cheaper.
 */
export const FALLBACK_CONTEXT_WINDOW = 4096;

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';

  readonly #baseUrl: string;
  readonly #idleTimeoutMs: number;
  readonly #firstTokenTimeoutMs: number;
  readonly #maxContextWindow: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options?: OllamaOptions) {
    this.#baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#firstTokenTimeoutMs = options?.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    this.#maxContextWindow = options?.maxContextWindow ?? DEFAULT_MAX_CONTEXT_WINDOW;
    this.#fetch = options?.fetch ?? globalThis.fetch;
  }

  /**
   * Whether the daemon is reachable.
   *
   * A first-class operation because *not running* is this provider's characteristic failure, and a
   * connection-refused stack trace is not something a user can act on.
   */
  async health(): Promise<ProviderHealth> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/version`, { method: 'GET' });

      if (!response.ok) {
        return { available: false, version: null, detail: `the provider answered HTTP ${response.status}` };
      }

      const body = (await response.json()) as { readonly version?: string };

      return {
        available: true,
        version: body.version ?? null,
        detail: `reachable at ${this.#baseUrl}`,
      };
    } catch {
      return {
        available: false,
        version: null,
        detail: `nothing is listening at ${this.#baseUrl}`,
      };
    }
  }

  async listModels(): Promise<readonly ModelDescription[]> {
    const body = await this.#get<{ readonly models?: readonly TagLine[] }>('/api/tags');
    const names = (body.models ?? [])
      .map((entry) => entry.model ?? entry.name)
      .filter((name): name is string => typeof name === 'string' && name !== '');

    // Alphabetical, so listing twice reads the same. Ollama's own order is by modification time.
    return [...names].sort((left, right) => left.localeCompare(right)).map((id) => ({
      id,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: null,
      capabilities: new Set(['system-prompt'] as const),
    }));
  }

  /**
   * A model, with the context window it will genuinely be run with.
   *
   * **The window reported here is the window requested at generation time**, because the budget is
   * computed from the first and the prompt is truncated against the second. Reporting the model's
   * trained length while letting the daemon pick something smaller is what silently discarded most of
   * every prompt; see `OllamaModelOptions.contextWindow`.
   *
   * `min(trained, ceiling)` — the model's own figure is an upper bound on what it can be asked for, and
   * the ceiling is an upper bound on what this deployment is willing to pay for in memory and in
   * time-to-first-token.
   */
  async model(id: string): Promise<LanguageModel> {
    if (id.trim() === '') {
      throw modelNotFound(id);
    }

    const show = await this.#show(id);
    const trained = contextWindowOf(show) ?? FALLBACK_CONTEXT_WINDOW;

    return new OllamaModel({
      baseUrl: this.#baseUrl,
      id,
      contextWindow: Math.min(trained, this.#maxContextWindow),
      maxOutputTokens: null,
      idleTimeoutMs: this.#idleTimeoutMs,
      firstTokenTimeoutMs: this.#firstTokenTimeoutMs,
      fetch: this.#fetch,
    });
  }

  async #show(id: string): Promise<ShowResponse> {
    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id }),
      });
    } catch (cause) {
      throw providerUnavailable(`could not reach the model provider at ${this.#baseUrl}`, cause);
    }

    if (response.status === 404) {
      throw modelNotFound(id);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      throw new AiError(
        'provider-protocol-error',
        detail === '' ? `the provider answered HTTP ${response.status} for /api/show` : detail,
      );
    }

    try {
      return (await response.json()) as ShowResponse;
    } catch (cause) {
      throw new AiError('provider-protocol-error', 'the provider sent a non-JSON response to /api/show', { cause });
    }
  }

  async #get<T>(path: string): Promise<T> {
    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { method: 'GET' });
    } catch (cause) {
      throw providerUnavailable(`could not reach the model provider at ${this.#baseUrl}`, cause);
    }

    if (!response.ok) {
      throw new AiError('provider-protocol-error', `the provider answered HTTP ${response.status} for ${path}`);
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new AiError('provider-protocol-error', `the provider sent a non-JSON response to ${path}`, { cause });
    }
  }
}

/**
 * Finds the context length among `model_info`.
 *
 * The key is architecture-prefixed — `llama.context_length`, `qwen2.context_length` — so it is matched by
 * suffix rather than by a table of architectures that would need extending for every new model family.
 */
export function contextWindowOf(show: ShowResponse): number | null {
  const info = show.model_info;

  if (info === undefined) {
    return null;
  }

  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value;
    }
  }

  return null;
}
