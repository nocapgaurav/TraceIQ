# @traceiq/context

## Purpose

The final composition layer.

Everything below already knows **how** to analyse. This package decides **what context belongs
together** for a given question, and nothing more.

It does not answer questions, generate prompts, talk to a model, or write prose. It assembles
deterministic structured context that a downstream consumer — an assistant, a frontend, the CLI, the
REST API, an editor extension — can consume as data.

```ts
const builder = new RepositoryContextBuilder({ explorer, explain, impact, health, queries });

builder.build({ kind: 'symbol', id: 'sym:src/svc.ts#Service.run' });
builder.build({ kind: 'route', method: 'GET', path: '/users/:id' });
builder.build({ kind: 'repository' });
```

> **A note on the original design.** The placeholder this file replaces described ranking results and
> loading source to fit a token budget. This milestone excludes both: no ranking, no scoring, and no
> filesystem access. Selecting source text for a budget is a consumer's concern, and it needs a model's
> tokeniser — so it belongs above this layer, not inside a package that must stay deterministic.

## Architecture

```
RepositoryContextBuilder  →  RepositoryContext
```

**The package cannot traverse, query or read anything.** The constructor takes the capabilities; there
is no `RepositoryGraphApi`, no store, no compiler, no filesystem and no HTTP anywhere in its surface, so
the boundary is enforced by the type rather than by discipline. A test can build a whole context from
fabricated answers, which is exactly what the unit suite does.

Every value in a context was produced by a capability and is carried **unchanged**. Nothing is
recomputed, re-sorted, re-derived or reshaped.

**Nothing is generated.** No prose, no markdown, no prompt, no summary written in words, no ranking, no
score. A list is in the order the capability returned it; a cap takes the first entries of that order
rather than choosing which matter.

Stateless: one `build` holds no state and caches nothing. Whatever caching exists belongs to the
capabilities that were passed in, which is what makes a warm build fast.

## Public API

```ts
new RepositoryContextBuilder(capabilities: ContextCapabilities)
builder.build(request: ContextRequest): RepositoryContext        // throws ContextNotFoundError
```

Seven request kinds, one result type:

| Request | Subject |
|---|---|
| `{ kind: 'symbol', id }` | one declaration |
| `{ kind: 'impact', id }` | what a change to one declaration reaches |
| `{ kind: 'file', path }` | one file — a `file:` prefix is optional |
| `{ kind: 'package', name }` | one derived package |
| `{ kind: 'route', method, path }` | one route |
| `{ kind: 'repository' }` | the repository as a whole |
| `{ kind: 'search', query }` | search results |

`build` throws `ContextNotFoundError` when the request names something the graph does not hold, rather
than returning a hollow context — an empty context would read as "nothing is recorded about this" when
the truth is "this does not exist". A search matching nothing is *not* an error: an empty result set is a
real answer.

### The envelope

**One shape for every kind.** `kind` says which parts are populated, and a part that does not apply is
`null` or empty rather than absent, so no field has to be probed.

```
kind          which request produced this
primary       the leading capability result, unchanged
related       nodes around the subject, each with a relation and optional explanation
references    incoming/outgoing calls, references, type references
dependencies  the dependency view, externals, environment variables, cycles
impact        the whole analysis, or counts
routes        routes reaching the subject
health        the whole report, or the subject's own condition
limitations   this composition's caveats merged with every contributing capability's
provenance    which capability produced which part
statistics    what this build cost
```

`references` is a **kind-independent view, not additional data**: those edges also live inside `primary`
— under `explain.incomingCalls` for a symbol, under `callers` for an impact analysis — and are mirrored
so a consumer reads `context.references` without knowing which kind it holds. The cost is modest
repetition; the alternative is every consumer learning where each kind keeps its edges.

`provenance` is the point of a composition layer: every part names the package and operation that
produced it, so a context is auditable without reading this package's source.

## Reuse map

| Kind | Capability calls | Total |
|---|---|---|
| `symbol` | `explorer.browseSymbol`, `explorer.dependencies` | 2 |
| `impact` | `impact.analyze`, `explain.explain` × 5 | 6 |
| `file` | `explorer.browseFile`, `explorer.dependencies`, `health.analyze` | 3 |
| `package` | `explorer.browsePackage`, `health.analyze` | 2 |
| `route` | `queries.explainRoute`, `explain.explain` × handlers, `impact.analyze` × handlers | 1 + 2n |
| `repository` | `explorer.overview`, `.architecture`, `.hotspots`, `.cycles`, `health.analyze` | 5 |
| `search` | `explorer.search`, `explain.explain` × ≤5 | ≤6 |

`RepositoryNavigator` is deliberately **absent**: it is not in the permitted reuse set, and it is not
needed — `QueryEngine.explainRoute` already splits a route's chain into middleware and handler.

**A symbol context carries impact as counts on purpose.** `browseSymbol` runs the impact analyser
internally, so asking for the whole analysis as well would run it twice for one request. The `impact`
kind exists for the whole analysis, and the `impact-summary-only` limitation says so on every symbol
context.

## Performance

Measured on TraceIQ itself — 202 files, 2,594 declarations, 2,822 nodes, 11,185 edges. **Cold** is the
first build on a freshly opened graph; **warm** is a repeat once the shared cache and index exist.

| Kind | Cold | Warm | Payload | Related | Explained |
|---|---|---|---|---|---|
| `search` | 46.4 ms | **0.3 ms** | 78 KB | 1 | 1 |
| `impact` | 19.2 ms | **1.4 ms** | 2.1 MB | 33 | 5 |
| `symbol` | 72.1 ms | **2.6 ms** | 198 KB | 17 | 0 |
| `package` | 51.9 ms | 4.8 ms | 808 KB | 14 | 0 |
| `file` | 55.5 ms | 7.4 ms | 249 KB | 43 | 0 |
| `repository` | 161.3 ms | 11.4 ms | 1.4 MB | 0 | 0 |

### Which capability dominates

Warm cost of each capability in isolation:

| Capability | Warm |
|---|---|
| `health.analyze` | **4.9 ms** |
| `explorer.hotspots` | 1.4 ms |
| `explorer.cycles` | 0.9 ms |
| `explorer.browseSymbol` | 0.7 ms |
| `impact.analyze` | 0.3 ms |
| `explorer.overview` | 0.1 ms |
| `explorer.architecture` | 0.0 ms |

**`health.analyze` is the bottleneck**, and it explains the warm ranking exactly: every kind that calls
it — `repository`, `file`, `package` — is slower than every kind that does not. Inside the health
analyser the cost is one `getRoles` per declaration, for want of a role index on the Graph API.

**Cold is the shared index build**, ~45 ms, which the first build of any kind pays once and no later
build pays again. `search` cold at 46.4 ms is essentially the index and nothing else.

**The `repository` kind computes health twice.** `explorer.overview` derives a health summary internally
and `health.analyze` produces the full report, so the analyser runs once inside the explorer and once
here — about 4.9 ms of its 11.4 ms warm total, or 43%. Reported as
`repository-health-computed-independently` rather than hidden. Both results agree, because the graph is
one immutable revision.

## Limitations

Reported in every context's `limitations` field, merged with those of each contributing capability and
deduplicated by code.

- **`context-is-a-composition`** — every value came from a capability and is carried unchanged, so a
  caveat belonging to a capability applies to the part it produced.
- **`impact-summary-only`** — the `symbol` kind carries impact as counts; request the `impact` kind for
  the affected sets.
- **`related-nodes-are-not-all-explained`** — at most five related nodes carry a full explanation, with
  the count that did not reported. One `ExplainSymbolResult` is around 85 KB, so twenty made an impact
  context roughly 3 MB of which 1.7 MB was explanations. Every related node is still listed by
  identifier, so a consumer asks for more by requesting the `symbol` kind for the one it cares about.
- **`repository-health-computed-independently`** — see performance.
- **`capped-lists`** — a list carried from a capability keeps that capability's cap and its true total.

Beyond the codes:

- **Payloads are large.** An `impact` context is 2.1 MB and a `repository` context 1.4 MB, because
  capability results are carried whole. There is no field selection.
- **A `package` context embeds the whole health report** (about 517 KB of its 808 KB). A consumer
  fetching many package contexts pays for the same report each time.
- Everything inherited from below: uncomposed route prefixes, partial call coverage, `INFERRED` calls,
  no interface or dynamic dispatch, path-derived package boundaries, cross-package imports resolving
  outside the analysed set.

## Package boundary

| Allowed | Absent by construction |
|---|---|
| `@traceiq/explorer` | graph traversal |
| `@traceiq/explain` | `RepositoryGraphApi` |
| `@traceiq/impact` | SQLite, any store |
| `@traceiq/health` | ts-morph, any compiler |
| `@traceiq/query` | filesystem |
| `@traceiq/graph-api` (types only) | HTTP |
| `@traceiq/types` | prompts, markdown, prose |

`@traceiq/graph-api` is imported for `GraphNode`, `GraphEdge` and `GraphProvenance` — the shapes a
capability result already contains. No operation on it is called, and `RepositoryGraphApi` never appears.

## Future consumers

Every consumer takes the same `RepositoryContext` and renders it differently:

- an **assistant** turns one into whatever representation it needs — this package deliberately stops
  short of that, so the composition is testable and the formatting is not baked in;
- a **frontend** renders `primary` as a page and `related` as navigation;
- the **CLI** and **REST API** already have their own composition and would use this to answer a
  question spanning several capabilities at once;
- an **editor extension** requests a `symbol` context for the declaration under the cursor.

## Testing Notes

The unit suite runs against capabilities that answer from fixed values and record every call. There is no
graph in that file — which is the point: if composition works with fabricated answers, it provably
reaches no database, no compiler and no filesystem. Those tests assert the exact call set per kind, so
"no duplicated assembly" is measured rather than claimed, and that the builder calls only operations the
consumed interface declares.

`pipeline.test.ts` scans a real project through `@traceiq/pipeline`, wires the five real capabilities over
one shared graph, and builds every kind — so a passing unit test cannot be an artefact of the fakes. It
also asserts that no context contains a database path, a connection or the string `sqlite`, and that
none contains markdown fences or prompt-like text.
