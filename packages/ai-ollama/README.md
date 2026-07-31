# @traceiq/ai-ollama

The first model provider. The only place in TraceIQ that knows Ollama exists.

```ts
const provider = new OllamaProvider();                     // defaults to http://127.0.0.1:11434

const health = await provider.health();                    // → { available, version, detail }
const models = await provider.listModels();
const model = await provider.model('qwen2.5:7b-instruct'); // → a LanguageModel

new RepositoryAnswerer(contextBuilder, model);             // and the vendor is invisible from here up
```

## Why it is a separate package

`@traceiq/ai` must be provider-agnostic, and the milestone requires that Ollama "must not leak through public
interfaces". If the provider lived beside the abstraction, every consumer of the abstraction would carry the
Ollama client in its module graph and non-leakage would be a convention maintained by discipline.

Separated, it is enforced by the dependency direction — the same precedent as `graph-api` (abstract) versus
`graph` (SQLite). It also makes the rule a test: `@traceiq/ai` asserts that no vendor name appears in its
source **or in its published `.d.ts` files**.

## What is contained here

Everything vendor-specific ends at this edge. Nothing above `LanguageModel` learns what is answering.

| Vendor detail | Where it stops |
|---|---|
| `POST /api/chat` with newline-delimited JSON | `ollama-model.ts` |
| `message.content`, `done`, `done_reason`, `prompt_eval_count` | `ollama-model.ts` |
| `done_reason: 'length'` → `StopReason: 'max-tokens'` | `normaliseStopReason` |
| Ollama's error wording | `#translate` → this layer's eleven codes |
| `model_info['<arch>.context_length']` | `contextWindowOf` |
| The `/api/tags`, `/api/show`, `/api/version` endpoints | `ollama-provider.ts` |

## No SDK

Plain `fetch` and a streaming line reader. Ollama's chat endpoint is documented HTTP with an NDJSON body, and
Node has everything needed natively.

The result: **the whole AI layer has zero external runtime dependencies**, keeping the repository's total
runtime surface at `better-sqlite3`, `ts-morph`, `fast-glob` and `express`. An SDK would also put vendor types
in a position to leak upward.

## No default model

A model must always be named. Baking in a default would embed a vendor's catalogue in the code and would
answer, silently, with whatever happened to be installed.

## Streaming

`readNdjson` never buffers the body — only the current partial line — so a long answer is not held in memory
and a `done` line is acted on the moment it arrives. It reassembles objects split across arbitrary byte
boundaries, and a line it cannot parse is a `provider-protocol-error` rather than something to skip: silently
ignoring one would turn a version mismatch into a quietly incomplete answer.

**The read is raced against the abort.** Checking a flag between reads is not enough — a provider that opens
a stream and then sends nothing leaves the reader blocked *inside* `read()`, and the flag is never looked at
again. A real `fetch` body does error when its signal aborts, but relying on that would make the idle timeout
unenforceable against any body that does not. This was found by a test that hung.

## Timeouts

The timeout is on **idleness**, not total duration: a local model on a cold start can take seconds to its
first token, but silence after that is a failure. Default 120 s, and it resets on every line.

## Failure translation

| Situation | Code |
|---|---|
| nothing listening | `provider-unavailable` |
| `/api/show` answers 404 | `model-not-found` |
| "requires more system memory" | `model-load-failed` |
| "context length exceeded" | `context-window-exceeded` |
| an `error` field mid-stream | translated, with the partial text attached |
| body ends without `done` | `stream-interrupted`, with the partial text |
| no line within the idle timeout | `generation-timeout` |
| the caller aborts | `generation-aborted` |
| a line that is not JSON | `provider-protocol-error` |

Ollama reports a mid-stream failure as an `error` field rather than a status, because the status line is long
gone by then. Every one of these carries whatever text had already been delivered.

## Testing

28 tests. `fetch` is injectable, so the whole provider is covered with **no daemon, no model weights and no
network** — a stub returns a real `ReadableStream` of NDJSON bytes, which exercises the real reader rather
than bypassing it.

It also runs the shared contract battery from `@traceiq/ai/testing`, so it is held to the same standard any
future provider will be.

One live test, skipped unless both are set:

```
TRACEIQ_OLLAMA_LIVE=1 TRACEIQ_OLLAMA_MODEL=qwen2.5:7b-instruct pnpm test
```

It asserts that the protocol works against the real thing — not that a given model answers well.

## Verified against a real provider

Ollama 0.31.1 with `qwen2.5:7b-instruct` (32,768-token window), answering over a real scan of TraceIQ: health
reported, window read from `qwen2.context_length`, answers streamed, first token ~4 s, ~10 s for 200 tokens.
Of three questions one was `grounded` with nine resolved citations, one `unverifiable` and one `ungrounded`
with the fabricated identifier named. The layer reported that accurately, which is the intended behaviour.
