import type { ContextRequest, RepositoryContext } from '@traceiq/context';

import { AiError } from './errors.js';

/**
 * The only way repository data enters the AI layer.
 *
 * One method. There is no `search`, no `query`, no `getNode` — so there is no repository intelligence to
 * duplicate here and no second inbound path to audit. `RepositoryContextBuilder` satisfies this
 * **structurally**; it is never imported as a value, which is why nothing in this package's compiled
 * output imports a `@traceiq` module and why SQLite and ts-morph are unreachable from it.
 *
 * If a future need cannot be expressed as a `ContextRequest`, that is a Context Builder change with its
 * own approval — not something to work around from up here.
 */
export interface ContextSource {
  build(request: ContextRequest): RepositoryContext;
}

/**
 * Calls `build` and turns its failure into this layer's error vocabulary.
 *
 * **`ContextNotFoundError` is recognised by name rather than by `instanceof`.** An `instanceof` check
 * needs a runtime import of `@traceiq/context`, which would put a `@traceiq` module in this package's
 * runtime closure and cost the property that makes the boundary provable rather than asserted. String
 * discrimination is normally a smell; here it buys a structurally verifiable boundary, and the trade is
 * stated rather than hidden.
 *
 * Anything that is *not* that error is a genuine surprise, so it surfaces as `context-source-failed` with
 * the original attached rather than being flattened into "not found".
 */
export function acquire(source: ContextSource, request: ContextRequest): RepositoryContext {
  try {
    return source.build(request);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'ContextNotFoundError') {
      throw new AiError('subject-not-found', cause.message, { cause });
    }

    throw new AiError('context-source-failed', describe(request), { cause });
  }
}

/** Names the request in an error, without leaking the whole payload into a message. */
export function describe(request: ContextRequest): string {
  switch (request.kind) {
    case 'symbol':
    case 'impact':
      return `${request.kind} ${request.id}`;
    case 'file':
      return `file ${request.path}`;
    case 'package':
      return `package ${request.name}`;
    case 'route':
      return `route ${request.method} ${request.path}`;
    case 'repository':
      return 'repository';
    case 'search':
      return `search ${request.query.text}`;
  }
}
