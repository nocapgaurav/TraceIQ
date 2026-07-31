import type { ContextRequest, RepositoryContext } from '@traceiq/context';

import { estimatingCounter } from './budget.js';
import type { ContextSource } from './context-source.js';
import { AiError } from './errors.js';
import type {
  GenerationRequest,
  LanguageModel,
  Message,
  ModelCapability,
  ModelDescription,
  ModelEvent,
  ModelProvider,
  StopReason,
  TokenCounter,
} from './model.js';

/**
 * Fakes and a provider contract battery.
 *
 * Exported as a separate entry point (`@traceiq/ai/testing`) so a provider package can prove it satisfies
 * the interface without the fakes reaching production code.
 */

/**
 * A model that emits a script.
 *
 * Makes the whole pipeline testable with no provider, no network and no model weights. Records every
 * request, so a test can assert what the prompt actually contained rather than trusting that it did.
 */
export class ScriptedModel implements LanguageModel {
  readonly requests: GenerationRequest[] = [];
  readonly tokens: TokenCounter;

  readonly #description: ModelDescription;
  readonly #chunks: readonly string[];
  readonly #failAfter: number | null;
  readonly #failWith: AiError | null;
  readonly #stopReason: StopReason;

  constructor(options?: {
    readonly text?: string;
    readonly chunks?: readonly string[];
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number | null;
    readonly capabilities?: readonly ModelCapability[];
    readonly id?: string;
    readonly counter?: TokenCounter;
    /** Throw after this many chunks, to exercise a mid-stream failure with partial output delivered. */
    readonly failAfter?: number;
    readonly failWith?: AiError;
    readonly stopReason?: StopReason;
  }) {
    this.#description = {
      id: options?.id ?? 'scripted',
      contextWindow: options?.contextWindow ?? 16_384,
      maxOutputTokens: options?.maxOutputTokens ?? 2048,
      capabilities: new Set(options?.capabilities ?? (['system-prompt'] as const)),
    };

    this.#chunks = options?.chunks ?? [options?.text ?? 'no answer scripted'];
    this.#failAfter = options?.failAfter ?? null;
    this.#failWith = options?.failWith ?? null;
    this.#stopReason = options?.stopReason ?? 'complete';
    this.tokens = options?.counter ?? estimatingCounter;
  }

  describe(): ModelDescription {
    return this.#description;
  }

  async *generate(request: GenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);

    yield { type: 'start', model: this.#description.id };

    let emitted = 0;
    let delivered = '';

    for (const chunk of this.#chunks) {
      if (signal?.aborted === true) {
        throw new AiError('generation-aborted', 'the generation was cancelled by the caller', { partial: delivered });
      }

      if (this.#failAfter !== null && emitted === this.#failAfter) {
        throw this.#failWith ?? new AiError('stream-interrupted', 'the scripted model failed', { partial: delivered });
      }

      yield { type: 'delta', text: chunk };
      delivered += chunk;
      emitted += 1;
    }

    if (this.#failAfter !== null && emitted === this.#failAfter) {
      throw this.#failWith ?? new AiError('stream-interrupted', 'the scripted model failed', { partial: delivered });
    }

    yield {
      type: 'end',
      stopReason: this.#stopReason,
      usage: { promptTokens: this.tokens.count(textOf(request.messages)), outputTokens: this.tokens.count(delivered) },
    };
  }

  /** The last prompt, as one string. Lets a test assert what the model was actually shown. */
  lastPrompt(): string {
    const last = this.requests.at(-1);

    return last === undefined ? '' : textOf(last.messages);
  }
}

function textOf(messages: readonly Message[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n');
}

/**
 * A context source answering from a fixed table.
 *
 * The point of the fakes: if the pipeline works from fabricated contexts, it provably reaches no database,
 * no compiler and no filesystem. Records every request, so a test can prove `build` was called once.
 */
export class FakeContextSource implements ContextSource {
  readonly requests: ContextRequest[] = [];

  readonly #contexts: readonly RepositoryContext[];

  constructor(contexts: RepositoryContext | readonly RepositoryContext[]) {
    this.#contexts = Array.isArray(contexts) ? contexts : [contexts as RepositoryContext];
  }

  build(request: ContextRequest): RepositoryContext {
    this.requests.push(request);

    const match = this.#contexts.find((context) => context.kind === request.kind) ?? this.#contexts[0];

    if (match === undefined) {
      // Mirrors what the real builder throws, and is recognised the same way — by name, not by class.
      const error = new Error(`no context for ${request.kind}`);

      error.name = 'ContextNotFoundError';
      throw error;
    }

    return match;
  }
}

/** A source that always fails, for the `subject-not-found` path. */
export class MissingContextSource implements ContextSource {
  build(request: ContextRequest): RepositoryContext {
    const error = new Error(`the graph holds nothing for ${request.kind}`);

    error.name = 'ContextNotFoundError';
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The provider contract
// ---------------------------------------------------------------------------------------------

export interface ProviderContractHooks {
  /** Assert equality. Passed in so this module needs no test framework of its own. */
  readonly equal: (actual: unknown, expected: unknown, message: string) => void;
  readonly ok: (condition: boolean, message: string) => void;
}

/**
 * What every provider must satisfy, whatever it is talking to.
 *
 * A shared battery rather than per-provider tests, so a second provider inherits the same standard instead
 * of a subset of it someone remembered to copy. The framework is injected, so this file imports no test
 * runner and can ship in the package's normal build.
 *
 * The provider under test is expected to be pointed at a stub, not at a real model: the contract is about
 * shape and ordering, not about answer quality.
 */
export async function assertProviderContract(
  provider: ModelProvider,
  modelId: string,
  hooks: ProviderContractHooks,
): Promise<void> {
  hooks.ok(typeof provider.name === 'string' && provider.name.length > 0, 'a provider must name itself');

  const health = await provider.health();

  hooks.ok(typeof health.available === 'boolean', 'health must report availability as a boolean');
  hooks.ok(typeof health.detail === 'string', 'health must carry a detail string');

  const models = await provider.listModels();

  hooks.ok(Array.isArray(models), 'listModels must return an array');

  const model = await provider.model(modelId);
  const description = model.describe();

  hooks.equal(description.id, modelId, 'describe must report the id that was requested');
  hooks.ok(description.contextWindow > 0, 'a model must report a positive context window');
  hooks.ok(typeof model.tokens.count('hello') === 'number', 'a model must supply a token counter');
  hooks.ok(model.tokens.count('') === 0, 'an empty string must cost no tokens');

  const events: ModelEvent[] = [];

  for await (const event of model.generate({ messages: [{ role: 'user', content: 'ping' }], temperature: 0 })) {
    events.push(event);
  }

  hooks.ok(events.length >= 2, 'a generation must emit at least a start and an end');
  hooks.equal(events[0]?.type, 'start', 'the first event must be start');
  hooks.equal(events.at(-1)?.type, 'end', 'the last event must be end');

  const end = events.at(-1);

  if (end?.type === 'end') {
    hooks.ok(
      ['complete', 'max-tokens', 'stop-sequence', 'aborted'].includes(end.stopReason),
      'the stop reason must be normalised to the shared vocabulary',
    );
  }

  hooks.ok(
    events.slice(1, -1).every((event) => event.type === 'delta'),
    'everything between start and end must be a delta',
  );

  // An unknown model must fail with the shared code, not with a provider-shaped error.
  let rejected: unknown = null;

  try {
    await provider.model(' definitely-not-a-model');
  } catch (cause) {
    rejected = cause;
  }

  hooks.ok(rejected instanceof AiError, 'an unknown model must raise an AiError');
  hooks.equal((rejected as AiError | null)?.code, 'model-not-found', 'an unknown model must raise model-not-found');

  // Aborting before the first token must not silently return an empty answer.
  const controller = new AbortController();

  controller.abort();

  let abortError: unknown = null;

  try {
    for await (const _ of model.generate({ messages: [{ role: 'user', content: 'ping' }] }, controller.signal)) {
      // The provider may legitimately emit nothing before observing the signal.
    }
  } catch (cause) {
    abortError = cause;
  }

  hooks.ok(abortError instanceof AiError, 'an aborted generation must raise an AiError');
  hooks.equal((abortError as AiError | null)?.code, 'generation-aborted', 'an aborted generation must raise generation-aborted');
}
