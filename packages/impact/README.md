# @traceiq/impact

## Purpose

Everything inside the repository a change to one declaration could affect.

`new ImpactAnalyzer(queryEngine).analyze(id)` → `ImpactAnalysisResult | null`.

Static repository intelligence over the existing graph. **Not AI, not prediction, not runtime
simulation.** Every reported relationship is an edge that already exists, carried with the edge
itself so it can be justified rather than believed.

## Traversal strategy

One **breadth-first walk outwards along incoming edges** — who depends on this — with
`findReferences` as the only primitive. `findReferences` returns every incoming edge except
`DECLARES`, so one call per node covers `CALLS`, `REFERENCES_TYPE`, `IMPORTS`, `EXPORTS`,
`EXTENDS`, `IMPLEMENTS` and `HANDLED_BY` at once.

The direction is the whole point. A **caller** breaks when the target changes; a **callee** does
not. So callees are reported at depth 1 and never expanded — following them would fill the
result with declarations a change to the target cannot reach.

```
                    ┌──────────────────────── expanded ────────────────────────┐
  routes ──▶ callers of callers ──▶ direct callers ──▶ TARGET ──▶ direct callees
             (INDIRECT)              (DIRECT)                      (DIRECT, not expanded)
```

Which node kinds are expanded:

| Kind | Expanded | Why |
|---|---|---|
| Declarations | yes | the ordinary case |
| `File` | yes | a module-level call is attributed to its file, so a file genuinely depends on what those calls reach; stopping there would lose every top-level invocation's impact |
| `Route` | no | nothing references a route, so expanding one always finds nothing — a route is reported in `routesAffected` instead |
| `External`, `EnvironmentVariable` | n/a | neither can be an edge source under the graph's endpoint matrix, so neither can arrive |

**Whole-collection queries are issued once each**, however large the closure grows, and then
scoped to it. `findRoutes` is issued only if the traversal actually walked past a `HANDLED_BY`
edge, so a declaration no route touches never pays for it.

## Why something appears in DIRECT

It is **one edge** from the target: a direct caller, a direct reference, a direct type
reference, a file importing or re-exporting it, a subclass extending it, a class implementing
it. `via` is that edge.

Direct **callees** are reported too, as an edge list rather than as affected nodes, because a
callee is not affected — it is what the target depends on. Keeping them in `callees` and out of
`directlyAffected` is what stops the two ideas being merged.

## Why something appears in INDIRECT

It is **two or more edges** from the target — a caller of a caller, a reference to a reference,
a subclass of a subclass — and `depth` says how many. Every route reaching anything in the
closure is also `INDIRECT`, **including a route whose chain names the target itself**: a route
is not a declaration, and the category vocabulary places every route reaching the declaration
there.

Depth is the **shortest** distance, because the walk is breadth-first.

## Why something appears in UNKNOWN

A relationship the pipeline could not resolve, recorded at a node in the closure. It does not
say something *is* affected — it says the graph could not settle a relationship at that point,
so the closure may be incomplete there.

`scope` matters more than it looks. A file joins the closure by importing the target, and then
contributes **every** unbound call in its top-level code — on a test-heavy repository, hundreds
of `expect(...)` calls with no bearing on the target. Those are labelled `file`; a relationship
recorded at an affected declaration is labelled `declaration`. Measured on this repository,
analysing `symbolId` yields 77 `UNKNOWN` entries of which **6 are `declaration`-scoped and 71
`file`-scoped**. Nothing is dropped and no judgement is applied, so a consumer filters on a fact
rather than trusting a heuristic.

**What UNKNOWN cannot contain.** An interface method call, a call through a variable and a call
on a runtime-chosen receiver produce **no edge at all** — not even an unresolved one in some
cases — so something reachable only that way appears nowhere in the result. That is reported as
the `no-interface-or-dynamic-dispatch` limitation, and it is the honest boundary of static
analysis here.

Separately, `closure-may-miss-hidden-dependents` carries the **repository-wide** unresolved
count: each of those could have been an edge into this closure had it bound. It cannot be
attributed to this target without guessing, so it is reported as a count rather than as entries.

## Cycle handling

A node joins `visited` the moment it is **discovered**, and the target is in `visited` before the
walk begins. So:

- **A self-call** (`function f() { f() }`) adds nothing — the target is already visited. The
  `CALLS` edge is still reported in `callers`, because recursion is a real fact about the code.
- **A cycle** (`a → b → a`) terminates: `a` at depth 1, `b` at depth 2, and `b`'s dependent `a`
  is already visited.
- **Module import cycles** terminate for the same reason.

Each node is dequeued at most once, so the walk performs exactly one `findReferences` per node
in the closure and cannot loop.

## Duplicate elimination

**Per node, not per edge.** Two call sites in the same caller are two edges but one affected
node, recorded at its shortest depth with the first edge that reached it. A node reached by
three different paths appears once.

The **edge-level** fields (`callers`, `callees`, `typeReferences`, `imports`) keep every edge,
because "where are the call sites" needs all of them. So `callers` can be longer than the number
of distinct callers, and that is deliberate rather than inconsistent.

`via.targetId` is the already-affected node each entry was reached through, so a path back to the
target can be walked without any path being stored.

## Determinism

Breadth-first with a FIFO queue and **no sorting anywhere**. Ordering is depth-major, and within
a depth it follows the Query Engine's edge order, which is itself defined. No ranking, no
scoring, no heuristics, no generated language.

Verified on this repository: 100 declarations analysed twice each produced byte-identical output.

The `limitations` field comes from a **closed table with fixed wording**; a limitation is
*selected* when a fact makes it apply, and counts live in `affected` rather than being
interpolated into the sentence. It is deliberately its own vocabulary rather than shared with
`@traceiq/explain` — one table serving both would grow codes that only ever apply to one.

## Performance

**About 43 ms per analysis on this repository, of which the traversal is under 1 ms.** The rest
is two Query Engine operations that hydrate the whole repository before this package scopes them:

| Cost | Value |
|---|---|
| Total per `analyze` | ~43 ms |
| Graph API calls | ~6,220 |
| `findUnresolved` share | 5,291 `getNode` calls, ~42 ms |
| `findDependencies` share | ~833 calls, ~7 ms |
| Closure traversal | 1 `findReferences` per node — a median of 3 |

Closure sizes over 200 declarations: **min 1, median 3, max 30**. Depth reaches 3 on real
chains. So the analysis itself is cheap and the fixed cost dominates completely.

This is the same finding `@traceiq/explain` recorded, and it bites harder here because impact
analysis is the natural thing to run over many declarations. No Query Engine operation was added
for it: the analysis is correct and one call is tolerable, and the fix belongs in a narrow
Query Engine addition rather than in a workaround here. See `docs/progress.md`.

## Architecture

Runtime dependencies are `@traceiq/query`, `@traceiq/graph-api` and `@traceiq/types` — nothing
else. `pnpm why better-sqlite3 --prod` against this package returns nothing, so SQLite, the
Graph Builder, the Graph Store and the Project Host are absent from the runtime closure. There
is no compiler and no parser.

`ts-morph` **is** in the installed closure, because `@traceiq/graph-api` takes `SourceRange` from
`@traceiq/ir`. No file here imports it; the coupling predates this package and is an approval
item in `docs/progress.md`.

`ImpactAnalyzer` takes `ImpactQueries`, not a `QueryEngine`. Declaring the interface writes the
consumed surface down — seven questions — makes the query budget countable in tests, and leaves
no name that could carry a database.

## Testing Notes

The unit suite runs against an in-memory `ImpactQueries` that is **graph-shaped**: traversal is
what is under test, so `findReferences` really does return the incoming edges of whatever node it
is asked about, ordered by identifier as the real implementation does. There is no database and
no Query Engine in it, and it records every node it was asked about, so "one query per node" and
"a callee is never expanded" are asserted rather than trusted.

The fixture has a known closure — five nodes at depth 1, three at depth 2, one at depth 3 —
plus a self-call, a two-node cycle, a duplicated call site, a route, inheritance, a re-export,
and a callee whose own callee must never appear.

`pipeline.test.ts` runs the whole pipeline into SQLite and asks the same questions of a real
graph, over a deliberate three-deep chain, so a passing unit test cannot be an artefact of the
fake. It also asserts that every reported `via` edge really exists in the database, and that no
connection, path or `sqlite` string appears in a serialised result.

## Known Limitations

- **~43 ms per analysis**, for the reason measured above.
- **No interface or dynamic dispatch.** An interface method with three implementations yields no
  edge to any of them, so a change to the interface method does not report them. This is the
  largest correctness boundary and no traversal can fix it.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED` — see `@traceiq/call-graph`.
  A callee containing another call produces no edge, so the closure can be narrower than the
  code.
- **Containment is not followed.** Changing a method does not report its class as affected: a
  class does not depend on its own member. A consumer wanting the container asks
  `findEnclosingDeclaration`.
- **Files appear among affected nodes**, which is honest but coarse — a file is affected as a
  whole even when only one of its top-level statements depends on the target.
- **`externalDependencies` is file-scoped**, so an external belongs to a file in the closure and
  is not necessarily used by the affected declarations.
- **No signature awareness.** Every dependent is reported for any change; the graph records no
  parameter or return type, so "this change is source-compatible" cannot be expressed.
- **No transitive callee direction.** By design — see the traversal strategy.
- **Route prefixes are not composed**, so a reported path may sit under a mount.
