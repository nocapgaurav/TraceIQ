export {
  DEFAULT_BASE_URL,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CONTEXT_WINDOW,
  FALLBACK_CONTEXT_WINDOW,
  OllamaProvider,
  contextWindowOf,
  type OllamaOptions,
} from './ollama-provider.js';
export { OllamaModel, type OllamaModelOptions } from './ollama-model.js';
export { readNdjson } from './ndjson.js';

// The first provider, and the only place in TraceIQ that knows Ollama exists. It implements @traceiq/ai's
// interfaces and adds nothing to them: every vendor difference — the wire format, the field names, the
// stop-reason vocabulary, the failure modes — is translated at this edge. No repository intelligence, no
// graph, no context. Runtime dependencies: none; Node's own fetch and streams are sufficient.
