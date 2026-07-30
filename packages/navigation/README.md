# @traceiq/navigation

## Purpose

The repository navigation layer — route explanation, architecture navigation and dependency
navigation in one coherent capability.

Every future interface (CLI, REST API, web UI, AI assistant) consumes this.

**Everything returned already exists in the graph.** Nothing is predicted, ranked, scored or
generated. A route is never reported under a path the graph does not state, and where prefix
composition is unsupported the response says so rather than guessing.

## Public API

```ts
class RepositoryNavigator {
  constructor(api: RepositoryGraphApi)

  explainRoute(route):      RouteExplanationView | null
  routes():                 Listing<RouteSummary>
  architecture():           ArchitectureNavigation
  dependencies(subject):    DependencyNavigation | null

  profile(name, run):       Profiled<T>
}
```

Four operations. `null` means the graph holds no such thing — not a hollow answer.

```ts
navigator.explainRoute({ method: 'GET', path: '/users/:id' });   // by method and path
navigator.explainRoute(id('route:GET:/users/:id'));              // or by identifier
navigator.dependencies({ package: 'packages/health' });          // a package by name
navigator.dependencies(id('sym:src/svc.ts#Service.run'));        // anything else by identifier
```

## Architecture

Runtime dependencies are only repository intelligence packages: `@traceiq/explorer`,
`@traceiq/explain`, `@traceiq/query`, `@traceiq/graph-api` and `@traceiq/types`. `pnpm why
better-sqlite3 --prod` returns nothing, so SQLite, the Graph Builder, the Graph Store, the Project
Host and the Resolver are absent from the runtime closure. No compiler, no parser.

**Impact Analysis and Repository Health are reused *through* Repository Explorer**, not imported
directly — which is why they are not direct dependencies. Impact Analysis powers the reverse closure
inside `explorer.dependencies`, and Repository Health powers the whole-graph index, coupling metrics
and condition summaries the explorer serves. Constructing either here would build a second cache and a
second index over the same revision, so navigation reaches through the layer rather than around it.

**One graph read for the whole layer.** `RepositoryExplorer` is constructed over navigation's own
`CachingGraph`, so the explorer's cache delegates here on a miss and the database is read once however
many capabilities run. Only the explorer builds a whole-graph index — navigation never builds a second
one, which is why it asks the explorer for structure rather than indexing itself. The suite asserts
`getNodes` is called 16 times and `getEdges` 13 times, not twice that.

| Question | Answered by |
|---|---|
| Middleware/handler split, unlinked handlers | `QueryEngine.explainRoute` |
| Everything about a handler | `RepositoryExplorer.browseSymbol` → the whole `ExplainSymbolResult` |
| What a declaration reaches, both ways | `RepositoryExplorer.dependencies` (which reuses Impact Analysis) |
| Roles, kinds, packages, files | `RepositoryExplorer.architecture` / `browsePackage` / `browseFile` |
| Repository condition | Repository Health, through the explorer |

The `QueryEngine` is here for exactly one thing the explorer does not expose: `explainRoute`.

## Route model

```
route:GET:/users/:id
  ├── chain          middleware… then the final handler, in running order
  │     └── each step: ordinal · declaration · ExplainSymbolResult · impact · health
  ├── controllers / services / repositories / middlewareRoles   reached, with depth
  ├── dependencies   everything the chain reaches, shortest depth first
  ├── environmentVariables · externalPackages
  ├── impact · callGraph · health          summaries across the chain
  ├── unresolvedHandlers                   handlers that could not be linked
  └── pathComposition                      whether the effective path is complete
```

A route is selected by method and path, composed into the frozen `route:<METHOD>:<path>` identity and
then **looked up** rather than trusted — an unregistered path yields `null`.

**Prefix composition is unsupported and always reported.** `app.use('/api', router)` means a route
written `/users/:id` really answers `/api/users/:id`, and nothing in the graph records that mount. So
`effectivePath` equals the written path, `composed` is `false`, and
`route-prefix-composition-unsupported` appears in `limitations`. The route is never reported under a
composed path.

**A role sits on a container; reach lands on a member.** `UserRepository` carries the Repository role
while the chain calls `UserRepository.load`. A role-bearing declaration therefore counts as reached
when any of its own members is, at that member's depth, read from the frozen `sym:<path>#<chain>`
identity. Reach itself follows **coupling** — calls, imports and type references together — so a
service imported but never called is still reported; `role-reach-follows-coupling` states this.

**Environment variables are reach-based**, for the same reason: a handler delegating to a service that
reads `JWT_SECRET` does depend on that variable.

## Architecture model

```
architecture()
  ├── packages          Repository Explorer's package summaries
  ├── architectureTree  roles first, then kinds, each with its members
  ├── packageTree       package → file → declaration
  ├── roleTree          role → package → declaration
  └── dependencyTree    package → packages it imports from / is imported by, with edge counts
```

Repository Explorer's flat `ArchitectureView` is **used to build these and not re-emitted**:
`architectureTree` already carries every role and kind group, so embedding the explorer's view
alongside would state the same declarations twice in one response — 420 KB of it on this repository.
A caller wanting a full `GraphNode` asks the explorer for it by identifier.

Trees carry a `TreeRef` — `id`, `name`, `kind` — because a tree is a navigation index rather than a
reading surface. All three fields come straight from the node.

Roles come before kinds because a role is what an engineer navigates by; a kind is how the language
spells it. A group with no members is omitted rather than reported empty.

## Dependency model

A subject is a **package**, a **file**, a **declaration** or a **route**, and what it covers differs:

| Subject | Covers |
|---|---|
| `package` | its files — a package is a derived grouping, not a node |
| `file` | itself |
| `declaration` | itself |
| `route` | its linked handlers — a route has no dependencies of its own; what it depends on is what its chain depends on |

```
dependencies(subject)
  ├── directDependencies / reverseDependencies
  ├── importGraph / referenceGraph / callGraph      edges of one type, both directions
  ├── closure / reverseClosure                      transitive, shortest depth first
  ├── cycles                                        every cycle the subject takes part in, once each
  ├── connectedComponent
  └── impact · health
```

Repository Explorer already answers this for **one node**. Navigation adds accepting a subject that is
not a single node, and separating the three relationship graphs — and it **merges** per-node answers
rather than re-walking: shortest depth wins where two files reach the same node, and a cycle two
subjects share is reported once.

## Performance

Measured against TraceIQ — 2,180 nodes, 8,328 edges, 17 derived packages, 1,993 declarations:

| Operation | Cold | Warm |
|---|---|---|
| `architecture` | **72.1 ms** (2,703 graph reads, 215 explorer calls) | 5.45 ms |
| `routes` | 0.04 ms | 0.04 ms |
| `dependencies` (declaration) | 7.67 ms (35 reads) | — |
| `dependencies` (file) | 1.87 ms (6 reads) | — |
| `dependencies` (package, 14 files) | 22.9 ms (78 reads, 29 explorer calls) | — |

The first operation pays for the explorer's whole-graph index and health report; everything after is
answered from shared state. A repeated operation reads **nothing** from the database — asserted, not
claimed.

Largest response: `architecture` at 343 KB, of which `packageTree` is 268 KB — inherent to a tree over
1,993 declarations. `dependencies` on a package is 303 KB; on a declaration, 79 KB.

## Examples

```ts
const navigator = new RepositoryNavigator(SqliteGraphApi.open('graph.db'));

const route = navigator.explainRoute({ method: 'GET', path: '/users/:id' });
route.chain.map((step) => step.declaration?.name);       // ['requireAuth', 'getUser']
route.services.map((entry) => entry.ref.name);           // ['UserService']
route.environmentVariables.entries;                      // read through the service
route.pathComposition.composed;                          // false — mount not recorded

navigator.architecture().packageTree.entries;            // package → file → declaration
navigator.architecture().roleTree.entries;               // role → package → declaration

navigator.dependencies({ package: 'packages/health' }).closure;
navigator.dependencies(id('route:GET:/users/:id')).callGraph.outgoing;

const { profile } = navigator.profile('architecture', (n) => n.architecture());
profile.graphApiCalls;  profile.cacheHits;  profile.explorerCalls;
```

## Determinism

Every ordering is the Graph API's identifier order, depth-major for a closure, or a documented sort
with an identifier tiebreak. Nothing is ranked or scored, and `limitations` come from a closed table
with fixed text. `profile` carries **no timing** — responses must be byte-identical for identical
input, so callers time the call themselves. Verified across repeated calls and across two navigators
over one database.

## Limitations

Navigation's own limitations travel on the responses that have them. A reused capability's travel with
**its** result — a handler's on `HandlerStep.explain.limitations` — so nothing is restated twice.

- **Route prefix composition is unsupported.** Always reported; the effective path is never guessed.
- **A handler written as a member expression cannot be linked**, so a chain can be shorter than the
  code registers. The unlinked handlers are listed rather than omitted.
- **Role reach follows coupling**, not calls alone.
- **Roles are judgements**, so every role grouping inherits that confidence.
- **Call coverage is partial** and no interface or dynamic dispatch is recorded, so a chain, a closure
  and a cycle are all lower bounds.
- **The package boundary is derived from paths** — the first two segments — since the graph records
  none.
- **Cross-package imports may resolve outside the analysed set.** On TraceIQ every inter-package import
  resolves through built output the scanner does not read, so `dependencyTree` reports zero
  cross-package edges. That is the graph's answer, not a missing feature; the mechanism works wherever
  an import targets an in-repository declaration, which the fixture suite proves.
- **Lists cap at 100 entries**, always with the true total alongside.

## Testing Notes

The unit suite runs against an in-memory `RepositoryGraphApi` with no database anywhere, and it counts
calls — so one-graph-read reuse and single index construction are asserted rather than trusted.
Coverage includes an empty repository, a repository with no routes, a route whose whole chain is
unlinked, a single-package repository, a 12-package monorepo with a dependency ring, and a 400-symbol
file for cap behaviour.

`pipeline.test.ts` runs the whole pipeline into SQLite over a real Express fixture — a mounted router,
a middleware-plus-handler chain, a member-expression handler that cannot be linked, an environment
variable read in the service rather than the handler, a mutual import cycle and an external package —
and asserts every operation finds them.
