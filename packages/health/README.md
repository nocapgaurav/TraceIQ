# @traceiq/health

## Purpose

A structured architectural health report for an indexed repository.

`new RepositoryHealthAnalyzer(graphApi).analyze()` → `RepositoryHealthReport`. One method, no
arguments, no options.

**Not AI, not linting, not style checking.** Every number is a count, a ratio or a percentile over
nodes and edges that already exist in the Repository Graph. Nothing is predicted, scored, graded or
recommended — and there is deliberately **no overall health number**, which would be a judgement
dressed as a measurement.

## Architecture notes

Runtime dependencies are `@traceiq/graph-api`, `@traceiq/query` and `@traceiq/types`. `pnpm why
better-sqlite3 --prod` against this package returns nothing: SQLite, the Graph Builder, the Graph
Store and the Project Host are absent from the runtime closure. There is no compiler and no parser.

**It reads the Graph API, not the Query Engine.** Health is the one capability that must read the
*whole* graph — a count of classes, a fan-in distribution and a dependency cycle are statements
about every node and every edge — and no Query Engine operation enumerates. The Graph API is the
abstract read model, explicitly designed so that a reader depends on it without SQLite entering its
dependency tree, so that is what health consumes, through a four-operation `HealthGraph` interface:
`getNodes`, `getEdges`, `getRoles`, `getUnresolved`. `RepositoryGraphApi` satisfies it structurally.

`@traceiq/query` is used for exactly one thing: `parseRouteId`, so route method and path are read by
the same rule the Query Engine uses rather than by a second copy of it.

`ts-morph` **is** in the installed closure, because `@traceiq/graph-api` takes `SourceRange` from
`@traceiq/ir`. No file here imports it; the coupling predates this package and is an approval item
in `docs/progress.md`.

No new infrastructure package was introduced. `graph-algorithms.ts` is local because nothing else in
the workspace needs strongly connected components today; if a second capability ever does, that is
the moment to promote it.

## Analysis strategy

**One pass over the graph, then pure computation.**

```
buildGraphIndex   getNodes × 16 kinds, getEdges × 13 types, getRoles × declarations, getUnresolved × 1
      ↓
deriveFrom        coupling metrics, call components, module dependency graph, call depth
      ↓
sections          summary · architecture · dependency · call graph · routing · environment
findings          facts, grouped by code
metrics           distributions and ratios
```

`buildGraphIndex` is the only code that touches the graph. Everything after it is a function of the
index, so no section can accidentally re-traverse and every section sees one snapshot.

`deriveFrom` exists because more than one consumer wants the same derived value. Coupling metrics,
the call-graph components and the module dependency graph are each needed by both a report section
and a finding; computing them per consumer would traverse the same edges two and three times over.

**Containment is excluded from coupling.** `DECLARES` is counted in the relationship totals — it is a
real edge — but kept out of fan-in, fan-out and every reference-based finding, for the same reason
the Query Engine's `findReferences` excludes it: a class declaring a method is containment, not a
reference to it. Counting it would give every member an incoming edge from its own container, so
nothing would ever read as unreferenced, and would inflate every file's fan-out by the number of
declarations it holds.

**The module dependency graph is a projection.** `IMPORTS` targets a declaration far more often than
a file, so a file-level cycle is almost never a `File → File` edge. Each import is mapped through its
target's own `fileId`, which recovers the module dependency graph engineers mean. That is a
projection of existing edges, not a new relationship.

## Category descriptions

| Section | What it answers |
|---|---|
| `summary` | How big is this repository — files, declarations by kind, routes, environment variables, externals by kind, and graph totals including unresolved references |
| `architecture` | How is it organised — role counts and the declarations carrying each, every relationship count, and the dependency graph and call graph sized separately |
| `dependencyHealth` | What is coupled to what — most referenced, most depending, most coupled files, isolated declarations, declarations with no incoming or no outgoing reference, external usage |
| `callGraphHealth` | How does behaviour connect — call edges, unresolved calls and coverage, unresolved reasons, recursion, cycles, disconnected clusters, entry points, depth |
| `routing` | What is exposed — routes by method, routes with no handler, registrations made twice, handlers reused across routes, unlinked handlers, handlers per route |
| `environment` | What configuration is used — variables, reads per variable, variables never read, variables read repeatedly |
| `findings` | Individually reportable facts, each with affected nodes, category, structured evidence, confidence and provenance |
| `metrics` | Repository-level measurements and distributions |
| `limitations` | What this report cannot tell you |
| `statistics` | What the analysis cost |

**Finding categories** — `DEPENDENCY`, `CALL_GRAPH`, `ROUTING`, `ENVIRONMENT`, `ANALYSIS_QUALITY` —
are never merged. A finding carries no severity, no score and no recommendation: it says what is
measurably true and names the nodes and edges it is true of.

A finding that applies to many comparable nodes emits **one** entry carrying them all, because a
thousand separate "never referenced" findings would bury the rest of the report. A finding about a
specific occurrence — a cycle, a route, a coupled file — emits one entry per occurrence.

**"High" fan-in and fan-out are relative to this repository.** The threshold is the ninetieth
percentile of the repository's own file distribution, computed from the graph being analysed, so no
magic constant decides it and a uniformly connected repository produces none of these findings.
That is the only place a comparison is made, and it is a percentile of measured data, not a
judgement.

## Metric definitions

| Metric | Definition |
|---|---|
| `fanIn` / `fanOut` | Count of **distinct** neighbours across reference types. Containment excluded. |
| `incomingEdges` / `outgoingEdges` | Count of **relationships**, higher wherever a pair is related twice — two call sites in one caller. Both are reported because conflating them hides that difference. |
| `averageDeclarationsPerFile` | Declarations ÷ files |
| `averageReferencesPerDeclaration` | Reference edges arriving at declarations ÷ declarations |
| `graphDensity` | Edges ÷ *n*(*n*−1) — the share of all possible ordered pairs that are related. Tiny for any real codebase, which is the point: it says how far the graph is from everything referring to everything. |
| `callGraphCoverage` | `CALLS` edges ÷ (`CALLS` edges + unresolved calls). The share of call sites the pipeline could bind. |
| `referenceCoverage` | Edges ÷ (edges + unresolved references). The share of relationships that resolved. |
| `maxCallDepth` | The greatest **shortest** distance from any call-graph entry point. Longest-path is not computable in polynomial time on a graph with cycles, and a metric that cannot be computed exactly should not be reported as if it were; what this measures — how deep the call graph gets — is well defined. |
| `median` / `p90` | Nearest-rank on the sorted values, no interpolation, so every figure is a value that actually occurs. |
| `clusters` | Connected components of the call graph **ignoring direction**: two functions calling a common helper belong together even though neither calls the other. |
| `entryPoints` | Declarations taking part in a call with no incoming call. |

Every ratio is 0 rather than `NaN` when nothing was measured, so a report on an empty repository is
still readable.

## Cycle handling

Cycles are found with **Tarjan's strongly connected components, iterated rather than recursed** — a
deep call chain would otherwise overflow the stack, and a health analyser is exactly the thing that
meets the worst case. The suite runs it over a 50,000-node chain for that reason.

Two cycle questions are asked separately, because they are different questions: declaration cycles
over `CALLS`, and module cycles over the projected module dependency graph. Merging the adjacency
would make either unanswerable.

A **self-loop is a cycle**: recursion is real, and a size-one component is reported when the node
points at itself. Components have identifier-ordered members; the components themselves come out in
Tarjan's reverse topological order. Both are deterministic, and neither is re-sorted.

Every other traversal terminates the same way: a node joins the visited set on discovery, so
`connectedComponents` and `maxDepthFromRoots` cannot loop.

## Duplicate elimination

Coupling counts a pair **once** however many edges relate them, which is what makes `fanIn` mean
"distinct dependents". The edge counts alongside it keep every edge.

`recursive` is deduplicated by node, since a function calling itself twice is one recursive
declaration. `reusedHandlers` deduplicates routes per handler. Capped lists carry the true `count`
and set `truncated`, so a cap is never silent.

## Complexity

Let *V* be nodes, *E* edges and *U* unresolved references.

| Stage | Cost |
|---|---|
| `buildGraphIndex` | O(*V* + *E* + *U*), plus one `getRoles` per declaration |
| Coupling and per-type adjacency | O(*E*) |
| Tarjan, connected components, depth | O(*V* + *E*) each |
| Sections and findings | O(*V* + *E*) |
| Sorting for top-*N* and distributions | O(*V* log *V*) |

So the whole analysis is **O(*V* log *V* + *E* + *U*)**, and Graph API calls are `16 + 13 + 1 +
declarations` — fixed in the vocabularies and linear in declarations, never in edges or findings.

**Measured on TraceIQ itself:** 1,824 nodes, 6,953 edges, 6,203 unresolved references, in **~37 ms**
with 1,679 Graph API calls. Of those calls, 1,649 are `getRoles` — one per declaration, to find 139
annotations — because the Graph API has no role index. That is the single largest inefficiency and
removing it needs a `getNodesWithRole` accessor, which is a standing approval item rather than
something to work around here. The remaining 30 calls read the entire graph.

## Determinism

Both enumerating operations return identifier-ordered lists, and every ordering in the report is
either that order, a documented sort by a measured count with an identifier tiebreak, or Tarjan's
component order. No ranking, no scoring, no heuristics, no generated language.

`limitations` and finding provenance come from **closed tables with fixed wording**; a limitation is
*selected* when a fact makes it apply, and counts live in `affected` rather than being interpolated.

**`statistics` carries no timing.** Elapsed milliseconds differ between runs and the report must be
byte-identical for identical input, so timing is measured around `analyze` instead.

Verified: the report is byte-identical across runs on this repository and on every fixture.

## Testing Notes

The unit suites run against an in-memory `HealthGraph` with no database anywhere, and it counts
calls, so "one pass over the graph" is asserted rather than trusted. `graph-algorithms.test.ts`
covers each algorithm directly, including 50,000-node stress cases that a recursive implementation
would fail. The analyser suite covers an empty repository, a single-file repository, an
all-isolated repository, a repository that is nothing but a cycle, and a file with no declarations.

`pipeline.test.ts` runs the whole pipeline into SQLite over a deliberately unhealthy fixture — a
mutual import cycle, a mutual call cycle, a recursive function, an orphan module, an unread
environment variable, an unlinkable route handler and an unresolved import — and asserts the report
finds each one.

## Known Limitations

- **A reference absence is not proof of disuse.** A declaration with no incoming reference is
  unreferenced *in the graph*; dynamic access, a framework entry point and an unresolved reference
  all leave no edge.
- **No property or member-access relationship exists**, so a class or interface property can never
  appear referenced however heavily it is used. Property nodes therefore dominate any count of
  unreferenced declarations — 684 of them on this repository.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED`, so every call-graph figure is a
  lower bound.
- **No interface or dynamic dispatch**, so clusters and depth understate how the code connects.
- **Duplicate route identities collapse.** A route identity is method plus path, so two registrations
  of the same route become one node; a duplicate is visible only as two handler edges at one
  position, which is what `route-registered-twice` detects.
- **Module-level calls are attributed to files**, so files appear among callers.
- **Roles are judgements**, so the architecture counts inherit that.
- **No history.** The graph holds one revision, so no trend can be reported.
- **`getRoles` is called once per declaration**, for want of a role index on the Graph API.
