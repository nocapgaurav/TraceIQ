/**
 * Every way an answer can fail, as a closed vocabulary.
 *
 * A code rather than a message, so a caller branches on the failure without matching prose — the same
 * contract the REST API and the CLI already hold. Each code has one fixed hint saying what to do next.
 */
export const AI_ERROR_CODES = [
  'provider-unavailable',
  'model-not-found',
  'model-load-failed',
  'subject-not-found',
  'context-source-failed',
  'budget-not-satisfiable',
  'context-window-exceeded',
  'generation-timeout',
  'generation-aborted',
  'stream-interrupted',
  'provider-protocol-error',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * Fixed wording per code.
 *
 * Composed nowhere: `detail` names the specific thing that was wrong and is the only part that varies
 * with input, while `hint` is constant for a code. Two identical failures therefore read identically.
 */
export const AI_ERROR_HINTS: Readonly<Record<AiErrorCode, string>> = {
  'provider-unavailable': 'start the model provider and try again',
  'model-not-found': 'list the provider models to see what is available',
  'model-load-failed': "check the provider's logs and the memory available to it",
  'subject-not-found': 'the repository graph holds nothing matching that subject',
  'context-source-failed': 'the context builder failed for a reason this layer cannot interpret; see cause',
  'budget-not-satisfiable': 'choose a narrower subject or a model with a larger context window',
  'context-window-exceeded': 'the prompt was rejected as too long even after re-projection',
  'generation-timeout': 'raise the deadline, or use a smaller model',
  'generation-aborted': 'the caller cancelled this generation',
  'stream-interrupted': 'the provider ended the stream before the answer finished',
  'provider-protocol-error': 'the provider sent something this client cannot parse; its version may be unsupported',
};

/**
 * A failure a caller can act on.
 *
 * `partial` carries whatever text had already been generated. A stream that dies halfway has produced
 * real output, and discarding it would lose work the user already watched arrive.
 */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly detail: string;
  readonly hint: string;
  readonly partial: string | null;

  constructor(code: AiErrorCode, detail: string, options?: { cause?: unknown; partial?: string }) {
    super(`${code}: ${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiError';
    this.code = code;
    this.detail = detail;
    this.hint = AI_ERROR_HINTS[code];
    this.partial = options?.partial ?? null;
  }

  /** True where retrying the identical request could plausibly succeed. */
  get isTransient(): boolean {
    return this.code === 'provider-unavailable' || this.code === 'generation-timeout' || this.code === 'stream-interrupted';
  }
}

export function providerUnavailable(detail: string, cause?: unknown): AiError {
  return new AiError('provider-unavailable', detail, cause === undefined ? {} : { cause });
}

export function modelNotFound(id: string): AiError {
  return new AiError('model-not-found', `the provider has no model named '${id}'`);
}

export function protocolError(detail: string, cause?: unknown): AiError {
  return new AiError('provider-protocol-error', detail, cause === undefined ? {} : { cause });
}

export function aborted(partial: string): AiError {
  return new AiError('generation-aborted', 'the generation was cancelled by the caller', { partial });
}
