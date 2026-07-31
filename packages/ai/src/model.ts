/**
 * The model contract. No vendor is named here or anywhere else in this package.
 *
 * **Streaming is the only primitive.** A blocking call is `collect(model.generate(...))`, four lines in
 * `stream.ts`. Were both primitives, every provider would implement two paths and they would drift —
 * and streaming would become the one nobody exercises.
 */

export const MODEL_CAPABILITIES = ['system-prompt', 'tools'] as const;

/**
 * What a model can do beyond streaming text.
 *
 * `streaming` is absent deliberately: it is not optional, it is the interface. `tools` exists as a
 * discovery hook only — this layer defines no tool, because a tool that read the repository would be a
 * second inbound data path and would bypass the Context Builder.
 */
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface ModelDescription {
  /** Opaque and provider-scoped. This layer never parses it. */
  readonly id: string;
  /** Prompt tokens the model accepts. The projection is budgeted against this. */
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly capabilities: ReadonlySet<ModelCapability>;
}

export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  readonly role: MessageRole;
  readonly content: string;
}

export interface GenerationRequest {
  readonly messages: readonly Message[];
  /** Absent means the model's own default. Set to 0 by this layer, since an answer must be reproducible. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
}

export type StopReason = 'complete' | 'max-tokens' | 'stop-sequence' | 'aborted';

export interface TokenUsage {
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * What a generation emits.
 *
 * A failure is **thrown**, not emitted: an error event is ignorable, and a throw from an async iterator
 * is not. Deltas already yielded are not lost — the consumer has them, and `AiError.partial` carries
 * them for a caller that did not keep them.
 */
export type ModelEvent =
  | { readonly type: 'start'; readonly model: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'end'; readonly stopReason: StopReason; readonly usage: TokenUsage };

/**
 * Counts tokens.
 *
 * An interface rather than a function because being wrong by a factor of three on some model is a real
 * failure mode, and providers differ. A provider that can count exactly supplies its own; the rest use
 * the shared estimator in `budget.ts`.
 */
export interface TokenCounter {
  count(text: string): number;
}

export interface LanguageModel {
  describe(): ModelDescription;
  /** The one generation primitive. `signal` must actually stop the provider, not merely detach a listener. */
  generate(request: GenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  readonly tokens: TokenCounter;
}

/**
 * A source of models.
 *
 * Kept as an interface because a provider is where vendor differences live — auth, wire format, token
 * counting, stop-reason vocabulary — and none of that may reach the layer above. There is deliberately
 * **no registry**: the application composition root instantiates one provider, takes one
 * `LanguageModel` from it, and injects that. A registry would put vendor selection inside this package.
 */
export interface ModelProvider {
  /** For errors and logs only. Nothing branches on it. */
  readonly name: string;
  health(): Promise<ProviderHealth>;
  listModels(): Promise<readonly ModelDescription[]>;
  /** Throws `model-not-found`. */
  model(id: string): Promise<LanguageModel>;
}

export interface ProviderHealth {
  readonly available: boolean;
  /** The provider's own version string, where it reports one. */
  readonly version: string | null;
  readonly detail: string;
}
