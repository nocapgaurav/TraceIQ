import type { LanguageModel, ModelProvider } from '@traceiq/ai';
import { OllamaProvider } from '@traceiq/ai-ollama';

import { CliError } from './errors.js';

/**
 * The CLI's composition root for models.
 *
 * **This is the only file in the CLI that names a model vendor.** `--provider` has to map to something,
 * and that mapping belongs in exactly one place rather than in a registry the AI layer would carry. Every
 * other file — including the chat REPL — sees a `LanguageModel` and never learns what is behind it.
 *
 * Adding a provider means one entry here and one new package. Nothing above changes.
 */
export const PROVIDER_NAMES = ['ollama'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * The provider used when `--provider` is omitted.
 *
 * Exported so no other file has to name a vendor: `cli.ts` reads this for its default and its help text,
 * which keeps "one file knows the vendors" true rather than nearly true.
 */
export const DEFAULT_PROVIDER: ProviderName = 'ollama';

/** An example for help and error text. A real installed model, so the suggestion is one that can work. */
export const EXAMPLE_MODEL = 'qwen2.5:7b-instruct';

export function isProviderName(value: string): value is ProviderName {
  return PROVIDER_NAMES.includes(value as ProviderName);
}

export function providerFor(name: string): ModelProvider {
  if (!isProviderName(name)) {
    throw new CliError(
      'unknown-provider',
      `'${name}' is not a provider this build knows`,
      `use one of: ${PROVIDER_NAMES.join(', ')}`,
    );
  }

  return new OllamaProvider();
}

/**
 * Resolves a provider and a model, failing early and legibly.
 *
 * Health is checked before the model is asked for, because "nothing is listening" and "that model is not
 * installed" are different problems and a user should be told which one they have.
 */
export async function resolveModel(providerName: string, modelId: string): Promise<LanguageModel> {
  const provider = providerFor(providerName);
  const health = await provider.health();

  if (!health.available) {
    throw new CliError('provider-unavailable', health.detail, `start ${provider.name} and try again`);
  }

  const models = await provider.listModels();

  if (!models.some((model) => model.id === modelId)) {
    throw new CliError(
      'model-not-found',
      `${provider.name} does not hold a model named '${modelId}'`,
      models.length === 0
        ? `${provider.name} has no models installed`
        : `installed: ${models.map((model) => model.id).join(', ')}`,
    );
  }

  return provider.model(modelId);
}
