# @traceiq/query

## Purpose

Repository-level queries over the graph.

Its runtime dependencies are `@traceiq/graph-api` and `@traceiq/types` — nothing else.
No SQL, no SQLite, no driver, no compiler, no graph internals. The constructor takes a
`RepositoryGraphApi` and everything follows from it.

## Responsibilities

```
findDeclaration(id)          the declaration, with its roles
findEnclosingDeclaration(id) the declaration containing it, with the DECLARES edge
findReferences(id)           everything referring to it
findTypeReferences(id)       references from a type position
findCallers(id)              what calls it, one step back
findCallees(id)              what it calls, one step forward
findRoutes()                 every route, handlers in order
explainRoute(routeId)        middleware, handler, and what could not be linked
findEnvironmentVariables()   each variable with every read of it
findDependencies()           externals with the files importing them
findByRole(role)             declarations carrying a role
findControllers()            ─┐
findServices()                ├─ named conveniences over findByRole
findRepositories()           ─┘
findUnresolved()             every reference that could not be resolved
```

## Non-goals

No natural language, AI, ranking, scoring, embeddings, prompt generation, fuzzy or
semantic search. Nothing here is probabilistic and nothing is ordered by relevance.

## Explainability

**Every result carries the graph node or edge it came from**, rather than flattening a
few fields out of it. Confidence, provenance and source locations live on those objects,
and copying selected fields is how explainability gets lost. A caller can always answer
"why does this result exist" without asking again.

`findReferences` excludes `DECLARES`: a class declaring a method is containment, not a
reference to it, and including it would make every member look referenced by its own
container. `findEnclosingDeclaration` is where containment is reported instead — one
incoming `DECLARES` edge, carried alongside the container so the containment can be
justified rather than merely asserted. A container that is a `File` yields `null`, a file
not being a declaration.

## Determinism and bounded traversal

The Graph API returns ordered lists and nothing here reorders except by ordinal, which is
a defined order too.

**No query walks further than two steps** from its starting point: a node, then its
edges, then the nodes at their far end. Nothing is recursive, so no query can loop or fan
out unpredictably. Tests assert the exact call counts — `findRoutes` over two routes with
three handlers issues one `getNodes`, two `getOutgoing` and three `getNode`, and nothing
else.

## Route path composition

Composition is performed **per query and never materialised**: a composed path is
derived, and storing it would freeze an answer its inputs can change.

**No prefix is currently recoverable, and every route says so.** A mount is written
`app.use('/api/auth', authRoutes)`. The IR records that call — the path is right there in
`callSites` — but the Framework Extractor keeps only the middleware it names and discards
the path. Nothing in the graph says which router was mounted where.

So `PathComposition` reports `composed: false` with an empty prefix list and an
`effectivePath` equal to the local path. That distinction matters: a caller must be able
to tell a complete path from one that may sit under a prefix. A route reported as
`/login` may really be `/api/auth/login`, and saying so is better than quietly implying
otherwise.

Making it work needs the Framework Extractor to emit mount annotations. See the approval
items in `docs/progress.md`.

## Performance

Most queries are one or two Graph API calls plus one `getNode` per edge. Two cost more:

- **`findByRole`** issues one `getRoles` per candidate node. It scans only `Class`,
  `Function` and `Variable` — the kinds the Framework Extractor annotates — so it is
  bounded by those rather than by the whole graph, but it is still the most expensive
  query here. A `getNodesWithRole` accessor on the Graph API would make it a single
  lookup.
- **Edge hydration** costs one `getNode` per edge, because the Graph API offers no batch
  accessor. `hydrate.ts` is the one place that would benefit if it gained one.

## Testing Notes

The unit suite runs against an **in-memory `RepositoryGraphApi`**. That is the point: if
the engine works with no database present anywhere, it provably depends on the interface
alone. The fake also counts calls, so bounded traversal is asserted rather than trusted.

`pipeline.test.ts` then runs the whole pipeline into SQLite and asks the same questions,
so a passing unit test cannot be an artefact of the fake. `@traceiq/graph` is a **dev**
dependency only, used to build that fixture; no source file outside a test imports it.

## Known Limitations

- **Route prefixes are not composed** — see above. This is the largest gap.
- **`findByRole` scans.** No role index exists on the Graph API.
- **No batch node accessor**, so edge hydration is one call per edge.
- **No reverse lookup from a declaration** to the routes handling it, the environment
  variables it reads, or the externals its file imports. `findRoutes`,
  `findEnvironmentVariables` and `findDependencies` return whole collections, and
  `findUnresolved` hydrates the source node of every unresolved reference in the repository.
  A consumer wanting one declaration's slice pays for all of them: on this repository that
  is 42 ms for `findUnresolved` alone. The Graph API already supports the narrow lookups
  (`getIncoming`/`getOutgoing` with a type), except that `getUnresolved` has no source
  filter. See `@traceiq/explain` for the measurement.
- **`findDependencies` returns every external**, including TypeScript built-ins and
  `ext:outside-analysis`. A caller wanting only npm packages filters on `externalKind`.
- **No revision parameter.** The graph stores one revision, so every query sees it.
- **`findReferences` does not distinguish a type-only import** from a value import; that
  distinction exists in the IR but is not carried on the graph edge.
- **No transitive queries.** `findCallers` and `findCallees` are each one step. "What
  eventually calls this" needs recursive traversal, which no query here performs — bounded
  depth is the property that makes these predictable, and unbounded reachability deserves
  its own design.
- **Call coverage is partial.** `CALLS` edges exist, but the call graph binds names rather
  than symbols. An instance method reached through a constructed variable now has an edge,
  as does a construction and a call to a nested function; a callee containing another call
  — `new Service().run()` — still has none. 32.3% of repository-addressable call sites bind.
  See `@traceiq/call-graph`.
