# @traceiq/ai

Grounded answers about a repository, from facts the Context Builder already produced.

```ts
// The composition root — the only place that knows which vendor is answering.
const model = await new OllamaProvider().model('qwen2.5:7b-instruct');
const answerer = new RepositoryAnswerer(contextBuilder, model);

for await (const event of answerer.answer({
  question: 'What would break if I changed this?',
  subject: { kind: 'impact', id: 'sym:src/svc.ts#Service.run' },
})) {
  // 'grounding' → the facts and what was left out, before any prose
  // 'delta'     → text
  // 'complete'  → the answer, its citations and its verdict
}
```

## Why this package exists

`RepositoryContext` cannot go in a prompt. Measured on TraceIQ itself:

| Kind | context | ≈ tokens | vs 128k window |
|---|---|---|---|
| `search` | 197 KB | 56,146 | 0.4× |
| `file` | 288 KB | 81,899 | 0.6× |
| `symbol` | 621 KB | 176,712 | **1.3×** |
| `package` | 834 KB | 237,286 | **1.8×** |
| `repository` | 1,450 KB | 412,508 | **3.1×** |
| `impact` | 4,201 KB | 1,194,962 | **9.1×** |

An `impact` context is 1.2 million tokens — 146 times an 8k window. The Context Builder deliberately stopped
short of solving this: choosing what fits a budget needs a tokeniser, so it belongs above that layer.

**So the majority of this package is the projection**, not the provider. Everything else — streaming, the
model interface, the conversation types — is small by comparison and deliberately so.

## Architecture

```
question + subject
     │
     ▼  ContextSource.build(subject)      the one inbound path
RepositoryContext        [up to 1.2M tokens]
     │
     ▼  project()                          fixed priority, capped, counted
ContextProjection        [facts, a closed identifier set, omissions, a digest]
     │
     ▼  assemble()                         deterministic, fenced, labelled
PromptMessages
     │
     ▼  LanguageModel.generate()           streaming is the only primitive
ModelEvent stream
     │
     ▼  checkGrounding()                   every identifier must be in the closed set
AnswerEvent stream
```

**Constructor injection is the whole configuration surface**: a `ContextSource` and a `LanguageModel`.
There is no registry, no provider name and no vendor setting. The application decides which provider to
instantiate, takes a model from it, and injects that — which is why nothing in this package names a vendor,
and why a test asserts that nothing ever will.

## The boundary

**This package cannot reach the repository.** `ContextSource` has exactly one method:

```ts
interface ContextSource {
  build(request: ContextRequest): RepositoryContext;
}
```

No `search`, no `query`, no `getNode`. There is no repository intelligence to duplicate and no second
inbound path to audit. `RepositoryContextBuilder` satisfies it structurally and is never imported as a
value, so:

| Property | How it is enforced |
|---|---|
| No SQLite | `better-sqlite3` is not in the module graph. `boundary.test.ts` asserts no import of it. |
| No graph traversal | No `RepositoryGraphApi`, `QueryEngine` or traversal type appears. Asserted by name. |
| No backend implementation package | The compiled output imports **no** `@traceiq` module. Asserted. |
| No capability called directly | `Explorer`, `Explain`, `Impact`, `Health`, `QueryEngine` appear nowhere. Asserted. |
| No repository search | Nothing here resolves a subject; a resolved `ContextRequest` arrives. Asserted. |
| No vendor leak | No vendor name in the source **or in the published `.d.ts`**. Asserted. |
| One declared dependency | `@traceiq/context`, imported as types only. Asserted against `package.json`. |
| No control bytes in source | A literal NUL once made three files binary to `grep`, silently defeating these very audits. Asserted. |

`boundary.test.ts` checks all of these against the source and the build output, so none of them rests on a
claim in this file.

To be exact rather than absolute: the compiled output's **only** external import is `node:crypto`, a platform
builtin used for the projection digest. No npm package and no `@traceiq` module appears.

One deliberate ugliness, stated rather than hidden: `ContextNotFoundError` is recognised by
`error.name`, not `instanceof`, because an `instanceof` check would need a runtime import of
`@traceiq/context` and would cost the property that makes the boundary provable.

## The projection

Four rules, each inherited from the discipline of the packages below.

**1. Fixed priority, never ranking.** Extractors run in a declared order — identity, limitations, the
subject's condition, impact counts, direct references, related nodes, dependencies, cycles — and each has a
declared cap per tier. No relevance score exists anywhere in TraceIQ and none is invented here.

Limitations come *second*, before any relationship, because they are few and they are the honesty
guarantee.

**2. Nothing is invented.** A `Fact` restates one edge or one field the context already carried. Where the
graph recorded an edge whose other end it could not name, the fact is simply absent — a `null` never
becomes an identifier.

**3. A cap is never silent.** Every extractor reports `kept` against `total`, and those omissions reach the
prompt *and* the caller. An answer built on 40 of 927 dependents that does not say so is a lie by omission.

**4. The same context and tier produce byte-identical facts.** A digest over the rendered lines identifies a
projection, so an unexpected answer can be investigated by re-projecting and comparing.

The extractors read the context's **kind-independent** parts — `related`, `references`, `dependencies`,
`impact`, `health`, `routes`, `limitations`. That is what the Context Builder normalised them for. Only a
small switch on `primary` looks inside a capability result, and it reads one thing: the subject's identity.

### Budget tiers

| Tier | Prompt tokens | Fits |
|---|---|---|
| `minimal` | 1,500 | a 4k window |
| `standard` | 6,000 | an 8k window with room to answer |
| `full` | 24,000 | a 32k window |

Half a model's window is reserved for the answer and the scaffolding. When a provider rejects a prompt this
layer estimated as fitting, it steps down **one named tier** and re-projects — deterministic, and announced
with a second `grounding` event so a consumer's displayed sources match what actually grounded the answer.

Caps stop one huge part starving the rest; the budget bounds the whole prompt. Both are real constraints and
both have tests.

## The grounding guard

This is where "grounded only in `RepositoryContext`" stops being aspirational.

Every identifier in the graph carries a fixed prefix — `sym:`, `file:`, `route:`, `env:`, `ext:` — and for a
given projection the permitted set is **closed and known**. So any identifier-shaped token in an answer that
is not in that set is a fabrication, decided deterministically with no model involved.

| Verdict | Meaning |
|---|---|
| `grounded` | at least one valid citation, nothing fabricated |
| `ungrounded` | an identifier or a fact id that does not exist |
| `unverifiable` | nothing fabricated, but nothing cited either |

**What it cannot do:** catch a wrong *claim* about a real identifier. "f12 proves X" when f12 proves Y passes.
It catches invented symbols, which is the failure that destroys trust fastest, and it does not pretend to be
more than that.

An ungrounded answer is **returned**, carrying its verdict and the fabrications by name. Withholding it would
hide the evidence of the failure; a caller that wants to suppress it has the verdict.

## Citations are first-class

`Answer.citations` carries the whole `Fact`, not just its id — subject, predicate, object, confidence and the
capability that established it. A consumer displays the supporting evidence and its provenance without
holding the projection that produced it.

## Streaming

`grounding` always arrives **before** the first `delta`, so a UI can show what an answer is permitted to be
based on, and what was left out, before any prose appears. Evidence precedes claim.

A failure is **thrown**, not emitted: an error event is ignorable, a throw from an async iterator is not.
Deltas already yielded are not lost, and `AiError.partial` carries them for a caller that did not keep them.
A transport that has already sent bytes cannot answer with an error status, so an SSE adapter would translate
a throw into a terminal frame — a wire concern, not this one.

`AbortSignal` is plumbed to the provider so cancelling actually stops a local model generating.

## Conversation

Types only. `Conversation`, `Turn`, `ConversationId`, `ConversationHistory` — **no store**. Persistence is a
later milestone, and shipping one now would put a database in this package's closure for a feature nobody has
asked for.

The shape is this layer's own, never a provider's message format, which is what makes history
provider-independent. Two properties matter:

- **History is conversation, not evidence.** Only questions and answers are replayed; the facts that
  grounded a prior turn never are. A fact from turn one could otherwise still be grounding turn eight after
  a rescan.
- **`model` is metadata, not structure.** A history recorded against one model replays against another.

## Errors

Eleven fixed codes with fixed hints, matching the convention the REST API and CLI already hold:
`provider-unavailable`, `model-not-found`, `model-load-failed`, `subject-not-found`,
`context-source-failed`, `budget-not-satisfiable`, `context-window-exceeded`, `generation-timeout`,
`generation-aborted`, `stream-interrupted`, `provider-protocol-error`.

`generation-aborted` is a code rather than a silent return, so a caller can tell "the user stopped it" from
"it finished".

## Performance on TraceIQ — 228 files, 3,148 declarations, 12,911 edges

| Kind | context tokens | projected | reduction | facts | cold | warm |
|---|---|---|---|---|---|---|
| `repository` | 412,508 | 1,920 | **215×** | 64 | 0.74 ms | 0.10 ms |
| `symbol` | 176,712 | 5,995 | 29× | 166 | 0.27 ms | 0.16 ms |
| `impact` | 1,194,962 | 5,989 | **200×** | 152 | 0.20 ms | 0.12 ms |
| `file` | 81,899 | 3,176 | 26× | 81 | 0.09 ms | 0.06 ms |
| `package` | 237,286 | 1,428 | 166× | 47 | 0.07 ms | 0.05 ms |
| `search` | 56,146 | 907 | 62× | 30 | 0.03 ms | 0.02 ms |

The projection is not the bottleneck — sub-millisecond in every case. Generation dominates entirely: against
a local 7B model, first token is ~4 s and a 200-token answer ~10 s.

## Testing

```
pnpm test    # 128 tests here, 28 in @traceiq/ai-ollama (1 opt-in, live)
```

- **Fakes prove the boundary.** `ScriptedModel` and `FakeContextSource` mean the whole pipeline is exercised
  with no graph, no network and no model weights. If it works from fabricated data, it provably reaches no
  database, compiler or filesystem.
- **`pipeline.test.ts` proves reality.** It scans a real project, wires the five real capabilities behind a
  real `RepositoryContextBuilder`, and answers — so a passing unit test cannot be an artefact of the fakes.
  The model stays scripted: what is tested is the pipeline, not whether a 7B model writes good prose.
- **`boundary.test.ts` proves the architecture.** Eight constraints, checked mechanically.
- **The provider contract battery** ships from `@traceiq/ai/testing`, so a second provider inherits the whole
  standard rather than whichever parts someone copied.

Deliberately **not** tested: answer quality. That is model evaluation, needs labelled data, and belongs to a
later milestone.

## Limitations

- **The token counter is an estimate** — 3.6 characters per token, the ratio measured across these six
  context kinds. A provider that can count exactly supplies its own. The tier step-down exists because this
  estimate can be wrong.
- **The guard checks identifiers, not claims.** See above.
- **Prompt injection is mitigated, not solved.** Repository content reaches the prompt; a file named
  `IGNORE-PREVIOUS-INSTRUCTIONS.ts` is a legitimate identifier. The fence, the standing instruction and the
  identifier guard bound the exposure.
- **No source code is available**, because no layer below serves any. Facts are identifiers, predicates and
  counts. A test asserts that no file contents reach a prompt.
- **A weak model will produce weak answers.** On a live 7B run, one of three questions was `grounded`, one
  `unverifiable` and one `ungrounded`. The layer reported that accurately rather than hiding it — which is
  the intended behaviour, and the reason the verdict is part of the answer.
- **No subject resolution.** Turning free text into a subject is repository search and belongs to the
  Explorer. A resolved `ContextRequest` arrives here.
