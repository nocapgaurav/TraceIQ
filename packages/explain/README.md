# @traceiq/explain

## Purpose

Everything the repository records about one declaration, in one result.

`new SymbolExplainer(queryEngine).explain(id)` → `ExplainSymbolResult | null`. The first
end-to-end user capability, and a pure assembly step: it asks the Query Engine nine
questions and arranges the answers.

## Responsibilities

```
declaration            the node, with its architectural roles
kind                   the declaration kind
sourceFile             the file identifier and the path inside it
locations              every source location, so an overload set keeps all of them
enclosingDeclaration   the container, with the DECLARES edge establishing it
incomingCalls          what calls it, one step back
outgoingCalls          what it calls, one step forward
references             every incoming edge except DECLARES
typeReferences         references from a type position
routes                 routes whose chain reaches it, and where in the chain
environmentVariables   variables it reads, with only its own reads
externalDependencies   externals its file imports
confidence             the declaration's own
provenance             the declaration's own
unresolved             references that could not be resolved, scoped
limitations            what this result cannot tell you
```

## Non-goals

**No AI.** Nothing here summarises, ranks, scores, embeds, searches loosely or writes
prose. There is no model, no prompt and no natural-language generation.

**No facts of its own.** Every field is carried out of the graph with the node or edge it
came from still attached. The explainer computes nothing, infers nothing and improves
nothing — it only selects and arranges.

**No storage.** The constructor takes `ExplainSymbolQueries`, which names nine questions
and no connection, statement or path. `@traceiq/query`, `@traceiq/graph-api` and
`@traceiq/types` are the only runtime dependencies, and `pnpm why better-sqlite3 --prod`
against this package returns nothing: SQLite, the Graph Builder, the Graph Store and the
Project Host are all absent from the runtime closure.

`ts-morph` **is** in that closure, and this is worth stating precisely rather than glossing:
`@traceiq/graph-api` takes `SourceRange` from `@traceiq/ir`, which depends on ts-morph, so
every reader of the graph installs it. No file here imports ts-morph and no code path
reaches it — it is one type's worth of package coupling that predates this milestone. Moving
`SourceRange` to `@traceiq/types` would remove it for every reader; that is an approval item
in `docs/progress.md`.

## Why an interface rather than the class

`SymbolExplainer` takes `ExplainSymbolQueries`, not a `QueryEngine`. `QueryEngine`
satisfies it structurally and is what production passes, but declaring the interface
writes down the consumed surface: a reader sees exactly which nine questions are asked, and
a test can count them. It also makes storage leakage impossible to express — there is no
name in the interface that could carry a database.

## The limitations field

The requested output includes "known limitations", which is text — so it comes from a
**closed table with fixed wording** in `limitations.ts`, never composed. A limitation is
*selected* when a fact makes it apply; counts live in a structured `affected` field rather
than being interpolated into the sentence. That keeps the field deterministic, keeps it
matchable on `code` instead of parseable as prose, and keeps generation out of a milestone
that must not generate.

`null` in `affected` marks a limitation that always holds. A number is how many parts of
this result it bears on; zero means it does not apply and it is omitted. Emission follows
the order of `LIMITATION_CODES`, so the field is stable across runs.

## Determinism

**Nothing is sorted here.** Every list is in the order the Query Engine returned it, which
is itself defined, so identical inputs give an identical result. Verified on this
repository: 150 declarations explained twice each produced byte-identical output.

## Query budget

Nine queries, one per question, plus one `explainRoute` per route that actually reaches the
declaration — none for almost every declaration. The suite asserts the exact counts.

`incomingCalls` and `typeReferences` are **projections of `findReferences`** rather than
calls to `findCallers` and `findTypeReferences`. Those would re-read the same incoming
edges, and a projection additionally guarantees what a consumer would otherwise have to
trust: that both are subsets of `references`, in the same order.

`explainRoute` is asked only about a route that matched, so the middleware/handler split
stays the Query Engine's rule rather than being re-derived here where the two could
disagree.

## Performance

**One explain costs about 49 ms on this repository, and 98% of it is two Query Engine
operations that hydrate the whole repository before this package filters them.** Measured
against real SQLite for `symbolId`:

| Query | Time | Graph API calls |
|---|---|---|
| `findDeclaration` | 0.24 ms | 2 |
| `findEnclosingDeclaration` | 0.11 ms | 2 |
| `findReferences` | 0.28 ms | 13 |
| `findCallees` | 0.10 ms | 6 |
| `findRoutes` | 0.04 ms | 1 |
| `findEnvironmentVariables` | 0.02 ms | 1 |
| **`findDependencies`** | **6.96 ms** | **833** |
| **`findUnresolved`** | **42.42 ms** | **5,292** |

The five questions that are about *this node* cost 0.77 ms combined — assembly is
essentially free. The other three are whole-collection queries because the Query Engine
offers no reverse lookup from a declaration: `findUnresolved` hydrates the source node of
all 5,291 unresolved references, and `findDependencies` hydrates all 1,358 `IMPORTS` edges,
after which this package discards all but a handful.

The reverse lookups needed already exist on the **Graph API** and cost 0.012–0.020 ms each
(`getIncoming(id, 'HANDLED_BY')`, `getOutgoing(id, 'READS')`,
`getOutgoing(fileId, 'IMPORTS')`). Only `getUnresolved` has no source filter. Narrow Query
Engine operations over those would take one explain from ~49 ms to about 1 ms. That is an
approval item rather than a change made here — see `docs/progress.md`.

Nothing about the result is wrong today; it is a cost, and it matters most for Impact
Analysis, which would call this per node.

## Edge cases

`explain` returns `null` — not a hollow result — for a file, a route, an external, an
environment variable, or an identifier the graph does not contain. A hollow result would
say "nothing is recorded about this" when the truth is "this is not a symbol".

A declaration nothing refers to returns empty lists and **still reports the general
limitations**, so an empty answer cannot be mistaken for a complete one.

A declaration appearing twice in one route chain yields two entries, one per occurrence,
because both are real and collapsing them would lose a position.

## Explainability

Every relationship carries its `GraphEdge`, so confidence, provenance and source location
survive. `enclosingDeclaration` carries the `DECLARES` edge rather than only the container,
so containment can be justified and not merely asserted. `unresolved` labels each entry
`declaration` or `file`: an unresolved import in the containing file may be why something
here did not bind, and a consumer should be able to tell that from an unbound call made
right here.

## Testing Notes

The unit suite runs against a **stub `ExplainSymbolQueries`** with no Query Engine, no graph
and no database anywhere in it. That is the point: if assembly works with nothing but nine
answers, it provably depends on the interface alone. The stub counts calls, so the query
budget is asserted rather than trusted.

`pipeline.test.ts` then runs scanner → host → IR → resolver → call graph → framework → graph
builder → SQLite → Graph API → Query Engine → explainer and asks the same questions, so a
passing unit test cannot be an artefact of the stub. It also asserts that no database path,
connection or `sqlite` string appears anywhere in a serialised result.

Everything below `@traceiq/query` is a **dev** dependency, used only to build that fixture.

## Known Limitations

- **`externalDependencies` is file-scoped.** `IMPORTS` is recorded at a file, never at a
  declaration, so these are the externals the containing file imports and not necessarily
  the ones used here. Narrowing them needs import-usage analysis that no stage performs.
- **One explain costs ~49 ms** for the reason measured above.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED` — see
  `@traceiq/call-graph`. Both are reported in `limitations`.
- **No transitive reach.** Incoming and outgoing calls are one step, the Query Engine being
  bounded by design.
- **Route prefixes are not composed**, so a reported path may sit under a mount.
- **The `File` node is not reachable**, a file not being a declaration, so `sourceFile`
  gives the identifier and path rather than the node.
- **A route's own `HANDLED_BY` edge also appears in `references`**, since it is an incoming
  edge that is not `DECLARES`. That is consistent rather than duplicated: a route does refer
  to its handler.
- **`ts-morph` is in the installed runtime closure** through `@traceiq/graph-api` →
  `@traceiq/ir`, for one type. Nothing here imports it.
