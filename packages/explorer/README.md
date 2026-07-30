# @traceiq/explorer

## Purpose

The read layer of TraceIQ.

Ten navigation operations over one repository graph. Every future interface — CLI, REST API, web UI,
AI assistant — consumes this package, and nothing else needs to know how the graph is stored.

**Everything returned already exists in the graph.** Nothing is predicted, ranked, scored or
generated, and no relationship is inferred beyond what the graph states. The one derivation is the
package unit, which is a documented projection of file paths and says so in every response that uses
it.

## Public API

```ts
class RepositoryExplorer {
  constructor(api: RepositoryGraphApi)

  overview():                     RepositoryOverview
  browseFile(id):                 FileView | null
  browseSymbol(id):               SymbolView | null
  browsePackages():               Listing<PackageSummary>
  browsePackage(name):            PackageView | null
  dependencies(id):               DependencyView | null
  architecture():                 ArchitectureView
  cycles():                       CycleReport
  hotspots():                     HotspotReport
  search(query):                  SearchResults

  profile(name, run):             Profiled<T>
}
```

`null` means "the identifier names nothing of that sort" — a file for `browseSymbol`, a declaration
for `browseFile`, an unknown identifier for either. A hollow result would say "nothing is recorded"
when the truth is "this is not that kind of thing".

`profile` wraps any operation and reports what it cost. Wrapping rather than instrumenting each
method keeps the ten operations free of profiling concerns.

## Architecture

Runtime dependencies are exactly the five allowed layers: `@traceiq/query`, `@traceiq/explain`,
`@traceiq/impact`, `@traceiq/health`, `@traceiq/graph-api` and `@traceiq/types`. `pnpm why
better-sqlite3 --prod` returns nothing, so SQLite, the Graph Builder, the Graph Store, the Project
Host and the Resolver are all absent from the runtime closure. There is no compiler and no parser.

**It reuses rather than reimplements.**

| Question | Answered by |
|---|---|
| Everything about one symbol | `SymbolExplainer.explain` — carried whole, not re-flattened |
| The dependents closure | `ImpactAnalyzer.analyze` |
| Whole-graph index, metrics, coupling, components | `@traceiq/health` — `buildGraphIndex`, `deriveFrom`, `stronglyConnectedComponents`, `connectedComponents` |
| Routes, references, callers, callees | `QueryEngine` |
| Route identity | `parseRouteId` from `@traceiq/query` |

The only traversal written here is `reachableFrom` — the **forward** closure, which no existing
capability performs: Impact Analysis walks dependents and deliberately does not follow the other
direction, and Health's `maxDepthFromRoots` returns a maximum rather than the members.

### One memoising graph adapter

Reuse would otherwise be expensive: Explain Symbol, Impact Analysis and Repository Health each read
the graph for themselves. `CachingGraph` wraps the Graph API and memoises every operation, and all
four capabilities are constructed over that one instance. Three capabilities reading the same node
cost one read.

Caching is sound rather than risky because every wrapped operation is a **pure read of one immutable
revision**: the graph holds a single revision and nothing in the read layer writes. An explorer
instance is therefore a snapshot — construct a new one to read a new revision.

### Shared indexes

`ExplorerContext` builds each shared value **at most once, lazily**: the health graph index, the
derived coupling and component data, the full health report, the package index, and any multi-type
adjacency. An operation that needs none of it pays for none of it; two operations that need the same
one share it. `search` and `architecture` never touch the graph again after the index exists.

## Navigation model

```
overview ─────────────────────────── the repository at a glance
  ├── browsePackages → browsePackage → files ─┐
  │                     dependencies ↔ dependents
  ├── architecture ── by role, by kind ───────┤
  ├── hotspots ─── most connected ────────────┤
  ├── cycles ───── import · call · reference · inheritance
  └── search ───── identifier · path · kind · role · route · env · external
                                              │
                          browseFile ─────────┤
                            declarations ─────┤
                          browseSymbol ───────┘
                            children · callers · callees · impact · health
                          dependencies
                            DIRECT   imports · exports · references · callees · callers
                            INDIRECT forward closure · reverse closure · cycles · component
```

Every node in a response carries its full `GraphNode`, so a caller can navigate from any result to
any other operation with the identifier it already holds. No operation requires a prior call.

**Every list is a `Listing`** — `entries`, `total`, `truncated`. A cap is never silent, and `total` is
always exact even when `entries` is capped at 100.

## The package unit

The graph records **no package boundary**: the specification deliberately omits both `Repository` and
`Directory` nodes, and the scanner's `packageJsonPath` never reaches the graph. So a package here is
the **first two segments of a file path**, or the first when there is only one:

```
packages/health/src/types.ts  →  packages/health
src/auth/user.service.ts      →  src/auth
index.ts                      →  index.ts
```

One fixed rule, no directory names hardcoded, no configuration, so two callers always agree. It is
reported as a limitation on every response that uses it.

## Performance

Measured against TraceIQ itself — 2,180 nodes, 8,328 edges, 163 files, 1,993 declarations:

| Operation | Cold (first call on a new explorer) | Warm |
|---|---|---|
| `overview` | **40.4 ms** | 0.02 ms |
| `architecture` | 0.06 ms | 0.06 ms |
| `cycles` | 1.15 ms | — |
| `hotspots` | 1.24 ms | — |
| `browseSymbol` | 2.34 ms | — |
| `dependencies` | 1.84 ms | — |
| `browsePackage` | 0.17 ms | — |
| `browseFile` | 0.11 ms | — |
| `search` | 0.11 ms | — |

The first operation pays for the shared index and the health report — 2,078 Graph API calls, of which
about 1,900 are `getRoles`, one per declaration, for want of a role index on the Graph API. Every
operation after that is answered from shared state: the whole graph is read **once per explorer
instance**, never once per operation.

`browseSymbol` costs 38 graph reads on a warm instance even though it drives three capabilities,
because the cache absorbs the rest.

Largest responses on this repository: `architecture` 420 KB and `hotspots` 412 KB, both dominated by
capped node lists of 100 full `GraphNode` objects. `overview` is 4.6 KB.

## Examples

```ts
const explorer = new RepositoryExplorer(SqliteGraphApi.open('graph.db'));

explorer.overview().packages.entries;
// [{ name: 'packages/health', files: 14, declarations: 308, dependencies: 0, dependents: 0 }, …]

explorer.search({ path: 'packages/health', kind: 'Class' }).declarations.entries;
// alphabetical, exact or prefix, never ranked

explorer.browseSymbol(id).explain.incomingCalls;   // Explain Symbol, carried whole
explorer.browseSymbol(id).impact.indirectlyAffected;  // Impact Analysis, summarised

explorer.cycles().callCycles.entries;
// every cycle, with its members and the edges that form it

const { result, profile } = explorer.profile('hotspots', (e) => e.hotspots());
// profile.graphApiCalls, profile.cacheHits, profile.largestResult
```

## Determinism

Every ordering is either the Graph API's identifier order, a documented sort by a measured count with
an identifier tiebreak, depth-major for a closure, or Tarjan's component order. Search is alphabetical
throughout. No ranking, no scoring, no heuristics, no generated language.

`profile` carries **no timing**: elapsed milliseconds differ between runs and every response must be
byte-identical for identical input, so callers time the call themselves. Verified: every operation is
byte-identical across repeated calls and across two explorers over the same database.

## Limitations

The explorer's own limitations travel on the responses that have them, as fixed-text codes. A reused
capability's limitations travel with **its** result — `SymbolView.explain.limitations` carries Explain
Symbol's — so nothing is restated in two vocabularies.

- **The package boundary is derived from paths**, not recorded. A repository laid out differently
  groups differently.
- **Cross-package imports may resolve outside the analysed set.** In a workspace where packages import
  each other through built output, the import targets an external rather than a file, so no
  package-to-package dependency can be recovered from it. On TraceIQ every inter-package import
  resolves to `ext:outside-analysis`, which is why its package dependency counts are zero — that is
  the graph's answer, not a missing feature. The mechanism works wherever an import targets an
  in-repository declaration.
- **A call cycle may be false self-recursion.** The call graph binds a multi-link `this` chain to the
  last member name on the enclosing container, so a method delegating to a field of the same name is
  recorded as calling itself and appears as a one-node cycle.
- **The connected component can span the repository.** Coupling is undirected, so a codebase whose
  modules share a core reports one component covering most of it — 1,662 of 2,180 nodes here. It says
  what is reachable, not what is cohesive.
- **A file rarely has incoming relationships.** `IMPORTS` targets a declaration, so an edge arrives at
  the declaration and not at the file holding it. Module-level dependency is a projection through each
  target's own file.
- **Lists cap at 100 entries**, with the true total alongside.
- **Everything inherited from below**: call coverage is partial, every `CALLS` edge is `INFERRED`, no
  interface or dynamic dispatch is recorded, and no property or member access is a relationship.

## Testing Notes

The unit suites run against an in-memory `RepositoryGraphApi` with no database anywhere, and it counts
calls — so "the whole graph is read once per instance" and "three capabilities share one read" are
asserted rather than trusted. Coverage includes an empty repository, a single-file repository, a
repository that is nothing but a cycle, a 1,800-declaration wide repository and a 5,000-deep call
chain.

`pipeline.test.ts` runs the whole pipeline into SQLite over a two-package fixture containing a mutual
import cycle, a mutual call cycle, recursion, an orphan module, a route chain, an environment variable
and an external package, and asserts every operation finds them. It also asserts that no database
path, connection or `sqlite` string appears in any response.
