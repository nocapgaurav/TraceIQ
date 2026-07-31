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
  /** No token within this long is a timeout. A local model on a cold start can be slow to first token. */
  readonly idleTimeoutMs?: number;
  /** Injectable so the contract tests can drive a stub with no daemon and no network. */
  readonly fetch?: typeof globalThis.fetch;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

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
  readonly #fetch: typeof globalThis.fetch;

  constructor(options?: OllamaOptions) {
    this.#baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
   * A model, with its real context window where the provider will say.
   *
   * The window is asked for rather than assumed because it decides the budget tier, and being wrong about
   * it is the difference between a full projection and a rejected prompt.
   */
  async model(id: string): Promise<LanguageModel> {
    if (id.trim() === '') {
      throw modelNotFound(id);
    }

    const show = await this.#show(id);

    return new OllamaModel({
      baseUrl: this.#baseUrl,
      id,
      contextWindow: contextWindowOf(show) ?? FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: null,
      idleTimeoutMs: this.#idleTimeoutMs,
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
