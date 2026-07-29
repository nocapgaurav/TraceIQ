# Progress

Milestones are referred to by name rather than number, since the engineering
contract does not restate the roadmap.

## Explain Symbol

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
968 passing across 39 files (69 in this package).

### Completed Work

New `@traceiq/explain`: `new SymbolExplainer(queryEngine).explain(id)` →
`ExplainSymbolResult | null`. Every requested field is present — declaration, kind, source
file, source locations, enclosing declaration, incoming and outgoing `CALLS`, references,
type references, routes reaching the declaration, environment variables read, external
dependencies, confidence, provenance, unresolved relationships, known limitations.

**Query Engine gained one operation, approved in advance:** `findEnclosingDeclaration(id)`.
`findReferences` deliberately excludes `DECLARES`, so containment had no accessor at all. It
returns the container **with the `DECLARES` edge**, so containment can be justified rather
than asserted, and it costs one `getIncoming` plus one `getNode`.

**No other module changed.** `pnpm why better-sqlite3 --prod` against `@traceiq/explain`
returns nothing, so SQLite, the Graph Builder, the Graph Store and the Project Host are all
absent from the runtime closure. `ts-morph` **is** in it — `@traceiq/graph-api` takes
`SourceRange` from `@traceiq/ir` — which is stated rather than glossed: no file here imports
it, and the coupling predates this milestone. See approval item 4.

### Self Review

| Criterion | Finding |
|---|---|
| API simplicity | One class, one method. The consumed surface is an explicit nine-operation interface rather than the concrete `QueryEngine`. |
| Duplicate queries | None. `incomingCalls` and `typeReferences` are projections of one `findReferences` rather than calls to `findCallers`/`findTypeReferences`, which would re-read the same edges. Asserted by a call-counting stub. |
| Unnecessary traversal | `explainRoute` is asked only about a route that matched. Three whole-collection scans remain and are unavoidable through the current Query Engine — see performance. |
| Performance | **One explain costs ~49 ms, and 98% of it is two Query Engine operations.** Measured and itemised below. |
| Documentation | README covers purpose, non-goals, the interface decision, the limitation table, determinism, the query budget, the measured cost, edge cases and testing. |
| Edge cases | `null` for a file, route, external or unknown identifier; empty lists plus general limitations for a declaration nothing refers to; two entries when a declaration appears twice in one route chain. |
| Explainability | Every relationship carries its `GraphEdge`. `enclosingDeclaration` carries the `DECLARES` edge. `unresolved` labels each entry `declaration` or `file`. |

### Measured on this repository

Per-query cost of one explain, against real SQLite:

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

The five questions about *this node* cost 0.77 ms combined; assembly is essentially free.
`findUnresolved` hydrates the source node of all 5,291 unresolved references and
`findDependencies` all 1,358 `IMPORTS` edges, after which the explainer discards all but a
handful. The narrow reverse lookups already exist on the Graph API and cost 0.012–0.020 ms
each.

Determinism verified over 150 declarations explained twice each: 150 byte-identical.

### Files

Created: `packages/explain/` — `types.ts`, `limitations.ts`, `source-file.ts`,
`symbol-explainer.ts`, `index.ts`, `fake-queries.test-helper.ts`,
`symbol-explainer.test.ts`, `source-file.test.ts`, `pipeline.test.ts`, `package.json`,
`tsconfig.json`, `README.md`.

Modified: `packages/query/src/query-engine.ts`, `types.ts`, `index.ts` and its test;
`packages/query/README.md`; root `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| A new package | One capability, one package, as every prior milestone. It consumes the Query Engine's output, so it cannot live inside it. |
| It consumes `ExplainSymbolQueries`, not `QueryEngine` | Writing the consumed surface down makes it reviewable and countable, and no name in the interface could carry a database — storage leakage becomes inexpressible rather than merely absent. `QueryEngine` satisfies it structurally and is what production passes. |
| `incomingCalls` and `typeReferences` are projections of `findReferences` | Calling `findCallers` and `findTypeReferences` would re-read the same incoming edges. A projection also guarantees they are subsets of `references`, in the same order, instead of leaving a consumer to trust it. |
| `limitations` comes from a closed table with fixed wording | The requested output includes prose, and this milestone must not generate language. A limitation is *selected*, never composed; counts live in `affected` rather than being interpolated. So the field is deterministic and matchable on `code`. |
| `explain` returns `null` for a non-declaration | A hollow result would say "nothing is recorded about this" when the truth is "this is not a symbol". Consistent with `findDeclaration`. |
| Nothing is sorted | Every list keeps the Query Engine's order, which is itself defined. Re-ordering would be this layer inventing a presentation, and ranking is forbidden. |
| `externalDependencies` is file-scoped and says so | `IMPORTS` is recorded at a file. Claiming declaration scope would overstate what the graph knows; narrowing it needs import-usage analysis no stage performs. |
| Unresolved references are labelled by scope | A file-scoped unresolved import may be why something here did not bind, but it is not this declaration's own. Labelling lets a consumer decide instead of being told. |
| `explainRoute` is asked only about matching routes | The middleware/handler split is the Query Engine's rule. Re-deriving it here would let the two disagree, and the cost is one query per matching route — none for almost every declaration. |

### Known Limitations

- **One explain costs ~49 ms**, for the reason itemised above. Nothing is wrong in the
  result; it is a cost, and it matters most for Impact Analysis, which would call this per
  node.
- **`externalDependencies` is file-scoped**, not declaration-scoped.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED`; both are reported in
  `limitations` rather than left implicit.
- **No transitive reach** — one step each way, the Query Engine being bounded by design.
- **Route prefixes are not composed**, so a reported path may sit under a mount.
- **The `File` node is not reachable**, so `sourceFile` is an identifier and path.
- **A route's `HANDLED_BY` edge appears in `references` as well as in `routes`**, since it
  is an incoming edge that is not `DECLARES`. Consistent, not duplicated.

### Approvals Needed Before Impact Analysis

1. **Four narrow Query Engine operations, to take one explain from ~49 ms to about 1 ms.**
   `findRoutesFor(id)` over `getIncoming(id, 'HANDLED_BY')`,
   `findEnvironmentVariablesFor(id)` over `getOutgoing(id, 'READS')`,
   `findDependenciesFor(fileId)` over `getOutgoing(fileId, 'IMPORTS')` — all three already
   supported by the Graph API — and `findUnresolvedFor(id)`, which additionally needs an
   optional source filter on the Graph API's `getUnresolved()`. Impact Analysis will call
   these per node, so the cost multiplies there.
2. **Whether a batch node accessor belongs on the Graph API.** Edge hydration is one
   `getNode` per edge, which is what makes `findUnresolved` cost 5,291 reads. This is the
   same gap `@traceiq/query` already recorded.
3. **Whether `SourceRange` should move from `@traceiq/ir` to `@traceiq/types`.** Because
   `@traceiq/graph-api` takes that one type from the IR package, `ts-morph` is installed in
   the runtime closure of every graph reader, including this one. Moving it removes the
   coupling for all of them and touches three files.
4. Carried forward, still open from IR Expansion: a new `UNRESOLVED_CALL_REASONS` value for
   a multi-link `this` chain, and whether property-initializer constructions should be
   tracked.

### Next Milestone

Impact Analysis — not started, awaiting approval.

## IR Expansion

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
894 passing across 36 files.

### Completed Work

**IR — construction is an invocation.** `new Service()` is now a `CallSiteIR` carrying
`isConstruction: true`, not a separate collection. It has a callee, arguments, a position
and it invokes a constructor, so every field a call site already has means the same thing
for it, and a consumer that ignores the flag still sees the invocation. A construction is
no longer double-recorded as a member access either: `isOutermostAccess` excludes the
callee of a `new` the same way it excludes the callee of a call.

**IR — declaration traversal enters bodies.** New `nested-declaration-extractor.ts` decides
what a body contributes; `declaration-extractor.ts` gained `extractBody`, called after
recording a function, variable, constructor, method or accessor. Recorded:

| Nested form | Kind | Why |
|---|---|---|
| `function inner() {}` | `function` | invocable by name |
| `const f = () => {}`, `const f = function () {}` | `variable` | invocable by name |
| `const svc = new Service()` | `variable` | holds an instance whose methods are invocable |
| `const n = 5`, `class Local {}` | not recorded | no call site can address it |
| `() => {}` passed inline | not recorded | anonymous, so no chain can name it |

Nesting is unbounded — `outer.deeper.deepest` — and bodies inside methods, constructors,
accessors and module-level arrows are entered.

**Call Graph — two new rules and scope-aware lookup.** `CALL_KINDS` gained `construction`
and `instance-member`. `binding-index.ts` replaced the `topLevel` map with
`declarationByPath` keyed by dotted chain, plus `chainOf` and `fileOf`, and a `lookupScoped`
helper that walks outwards from the declaration containing the call. A pre-pass over the
constructions builds a variable-to-class map, which is what binds `svc.run()`.

**Resolver: no change required.** It consumes the expanded IR unmodified. More declarations
reach it, which is additive; nothing about how a reference resolves depends on nesting.

**Graph Builder, Graph API, Query Engine: no logic change.** One constraint had to widen —
see the decision table.

### Before and after, measured on this repository

Measured on one tree with the expansion reverted in the harness, so the comparison isolates
the change rather than the repository having grown:

| | Sites | Bound | Of repository-addressable |
|---|---|---|---|
| Before | 5,953 | 1,108 (18.6%) | 28.3% |
| After | 6,157 | **1,321 (21.5%)** | **32.3%** |

| Rule | Before | After |
|---|---|---|
| `local` | 531 | 533 |
| `imported` | 489 | 489 |
| `instance-member` | — | **112** |
| `construction` | — | **99** |
| `static-member` | 57 | 57 |
| `this-member` | 31 | 31 |

| Unresolved reason | Before | After |
|---|---|---|
| `root-is-external` | 2,034 | 2,066 |
| `callee-not-addressable` | 1,249 | 1,249 |
| `root-not-bound` | 926 | 939 |
| `root-type-unknown` | 525 | **471** |
| `member-not-found` | 111 | 111 |

The 213 new edges came from 54 sites previously `root-type-unknown`, 60 previously
`root-not-bound` (a nested variable was not a declaration at all, so its root could not
bind) and 99 constructions that were not call sites. Call sites attributed to a declaration
rather than a file rose from 1,339 to 1,469. Declarations rose from 1,041 to 1,087, of which
46 are nested inside a body. Binding takes about 5 ms; the whole pipeline still writes to
SQLite and answers `findCallers`/`findCallees`.

Against the figures recorded before this milestone (5,718 sites, 1,063 bound, 18.6%), the
denominator also changed because the repository gained this milestone's tests. The table
above is the like-for-like comparison.

### Files

Created: `packages/ir/src/nested-declaration-extractor.ts`, `packages/ir/src/nesting.test.ts`.

Modified: `packages/ir/src/types.ts`, `expression-extractor.ts`, `declaration-extractor.ts`,
`declarations.test.ts`; `packages/call-graph/src/types.ts`, `binding-index.ts`,
`call-graph-resolver.ts`, `call-graph-resolver.test.ts`; `packages/graph/src/constraints.ts`
and its test; `docs/04-graph-spec.md`; `packages/ir/README.md`,
`packages/call-graph/README.md`, `packages/graph/README.md`, `packages/query/README.md`.

Not modified: any Resolver source, `graph-builder.ts`, the Graph API, the Query Engine.

### Decisions

| Decision | Reason |
|---|---|
| Construction is a flag on `CallSiteIR`, not a new collection | Construction *is* a call: same callee, arguments, position, and it invokes a constructor. A separate collection would duplicate the shape and let a consumer miss half the invocations in the repository. |
| A nested declaration takes the **same** kind as its top-level equivalent | `const f = () => {}` is a `variable` wherever it is written. Kinding it `function` when nested would make the IR's own nesting an observable property of a declaration, and would have changed nothing for any consumer. |
| Only the invocable and the instance-holding are recorded | A body can contain a great deal that no call site can address. `const n = 5` and a local `class` stay out; recording every local would multiply the IR for no consumer's benefit. |
| An anonymous function is not recorded at all | `sym:<path>#<chain>` needs a name. Inventing one would create an identity that no second run could reproduce from the source alone. |
| A construction is attributed to the variable it initialises | That attribution is the entire mechanism for `instance-member`: it links `svc` to `Service` with no type checker. It follows from the existing "nearest recorded declaration" rule rather than being a special case. |
| A construction with no declared constructor points at the class | The construction happens either way. Naming the class says more than reporting nothing, and the evidence string states which case fired. |
| Bare-name lookup became scope-aware | With nested declarations, a top-level-only lookup would bind an inner call to an outer declaration of the same name. Walking outwards from the innermost scope is both more correct and what recovers calls to nested functions. |
| **`DECLARES` may now be sourced at `Function`, `Method`, `Constructor`, `Accessor` or `Variable`** | Strictly required by the new IR: the graph validator rejected the expanded IR outright, since a nested declaration's parent is a body. The derivation in spec §2.1 is unchanged — the same upward walk finds the new parents — so only the endpoint matrix in §2.3 widened. `Property`, `EnumMember` and `TypeAlias` stay excluded, having no body. **This edits the frozen specification and needs approval.** |
| Instances are keyed by declaration, not by assignment | Modelling the last write would need flow analysis. The map is a fact about which class a name was constructed from, and reassignment is recorded as a limitation instead of guessed at. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **The graph rejected the expanded IR.** `DECLARES may not be sourced at a Function` — found by running the full pipeline into SQLite, not by the unit suite, which had no nested-declaration fixture reaching the Graph Builder. | Widened the endpoint matrix in spec §2.3 and `constraints.ts`, and added a test asserting the kinds that stay excluded. |
| **Nested arrows were kinded `function` while identical top-level arrows were `variable`.** Caught by a test written against the top-level behaviour. The nested extractor had invented its own two-value vocabulary and mapped it back inconsistently. | `NESTED_KINDS` is now a subset of `DECLARATION_KINDS`, checked by `satisfies`, so the mapping cannot drift again. |

### Known Limitations

- **A callee containing a call is still unbindable** — `new Service().run()`,
  `chain.slice(0, -1).join('.')`. 1,249 sites, unchanged, and 1,216 of them contain a call
  in the callee. Binding them needs the type of an intermediate expression, which no
  name-based rule can supply. This is the largest remaining group and it is a type-checker
  problem, not a missing IR feature.
- **A `this` chain longer than one link is reported as `member-not-found`**, which blames
  the wrong thing. All 111 such entries are this shape and 110 are multi-link chains
  (`this.callGraph.calls.find`). Listed for approval below.
- **A construction in a property initializer is not tracked**, so `private svc = new
  Service()` does not make `this.svc.run()` bindable.
- **Reassignment is not tracked**: `let svc = new A(); svc = new B(); svc.run()` binds to
  `A`.
- **4,688 of 6,157 call sites still attribute to a file**, because test suites are built
  from anonymous callbacks and no anonymous function can be a declaration.
- No inheritance, no `super.method()`, no interface dispatch — all deliberate.
- Every `CALLS` edge remains `INFERRED`. Scope-aware lookup narrows shadowing but an
  unrecorded local or a parameter can still shadow a match.

### Approvals Needed Before Explain Symbol

1. **The frozen Graph Specification was edited** — §2.3 `DECLARES` sources widened, plus a
   sentence in §2.1 stating the derivation is unchanged. This was forced: without it the
   validator rejects the expanded IR. Please confirm the edit rather than the alternative,
   which would have been to reparent every nested declaration to its file and discard the
   containment the IR now knows.
2. **A new unresolved reason for a multi-link `this` chain.** `member-not-found` is the
   wrong label for `this.callGraph.calls.find()`. Fixing it adds one value to
   `UNRESOLVED_CALL_REASONS`; it changes no edge, only a reason. Not done, being outside
   this milestone.
3. **Whether property-initializer constructions should be tracked**, which together with
   item 2 would make `private svc = new Service(); this.svc.run()` bindable.

### Next Milestone

Explain Symbol.

## Call Graph

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
859 passing across 35 files (29 in this package).

### Completed Work

- New `@traceiq/call-graph`: `CallGraphResolver.resolve({ ir, resolved })` → `CallGraph`.
  Five binding rules — `local`, `imported`, `this-member`, `static-member`,
  `namespace-member` — each a constant-time lookup against indexes built in one pass.
- Every call site produces exactly one outcome: a relationship or an entry in `unresolved`
  with a reason. There is a test asserting `calls + unresolved === callSites`.
- Graph Builder accepts a fourth input and translates `CALLS` edges plus unbound calls;
  `CALLS` added to the endpoint matrix, with `File` as a legal source for a module-level
  call.
- Query Engine gains `findCallers` and `findCallees`, each one step.
- **Graph API needed no change**: `CALLS` was already in the frozen relationship
  vocabulary, so `getEdges('CALLS')` and the type-filtered accessors worked as they stood.
- Spec updated: `CALLS` moved from reserved to produced, endpoints added, the fourth input
  recorded.

### Measured on this repository

5,718 call sites, **1,063 bound** in ~2 ms (`local` 494, `imported` 482, `static-member`
56, `this-member` 31); 1,057 `CALLS` edges reached SQLite. Five self-calls, so recursion is
represented. `findCallees` on `GraphBuilder.build` returns exactly the functions it calls.

Of 4,655 unbound, **1,949 correctly leave the repository**. Of the 3,769 sites that could
point at repository code, 28% bind.

### Files

Created: `packages/call-graph/` (`types.ts`, `binding-index.ts`, `call-graph-resolver.ts`,
`index.ts`, fixture helper, test, package files, README);
`packages/graph/src/call-translator.ts`.

Modified: `packages/graph/src/graph-builder.ts`, `constraints.ts` and its test;
`packages/query/src/query-engine.ts`, `types.ts`, `index.ts` and its test;
`docs/04-graph-spec.md`; root `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`,
`README.md`; `packages/graph/README.md`, `packages/query/README.md`.

### Decisions

| Decision | Reason |
|---|---|
| A separate package, after the Resolver | It consumes the Resolver's *output*, so it cannot live inside it. |
| Every relationship is `INFERRED` | The stage binds names, not symbols: it has no `ProjectContext`. A local of the same name could shadow the declaration matched, and nothing here can rule that out. |
| A module-level call is attributed to its file | Top-level invocation is real. Dropping it because there is no enclosing declaration would lose it entirely. |
| A member lookup requires a container kind | `svc.run()` on a variable is reported as needing a type, not as a missing member. Blaming the member would point at the wrong thing. |
| `root-is-external` is a distinct reason | Conflating "the call leaves the repository" with "we could not bind it" blames the analysis for something it got right. Worth 1,949 call sites here. |
| External roots detected by two signals | A bare or `node:` specifier is external by syntax, which holds even when the package is not installed and the Resolver bound nothing; a resolved external target catches the rest. |
| One rule fires per call site | The rules are disjoint on the shape of the callee, so no site produces competing candidates and no deduplication is needed. |
| A self-call is bound like any other | Recursion is a fact about the code. Nothing traverses, so there is no loop to guard. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`svc.run()` reported `member-not-found`**, blaming a missing member when the real problem was an undeterminable type. Found by reading the probe output rather than the tests. | Member lookup now requires a container kind; a value root reports `root-type-unknown`. |
| **Calls leaving the repository were reported as unbound names.** 1,949 sites on this repository — including every `expect` and `it` — read as analysis failures. | Added `root-is-external`. |
| **The first external-root implementation relied only on the Resolver**, so it failed in a fixture with no `node_modules`, where the binding resolves to nothing. Caught by a test written against a fixture that has none. | Added the syntactic signal alongside it. |

### Known Limitations

- **No type checker**, so every edge is `INFERRED`.
- **`new C()` is invisible to the IR**, which blocks the most common object-oriented shape
  and accounts for most of `callee-not-addressable` (1,203) and `root-type-unknown` (498).
  *Addressed by IR Expansion.*
- No inheritance, no `super.method()`, no interface dispatch — all deliberate.
- **Local functions are unbindable**: the IR records no declaration for a function nested
  inside another. *Addressed by IR Expansion.*
- A call inside an arrow at module level attributes to its file, which is why test-file
  calls attribute to files.
- `findCallers`/`findCallees` are one step; there are no transitive queries.

The figures in this section are those measured at the end of the Call Graph milestone and
are left as recorded. The IR Expansion section supersedes them.

### Next Milestone

IR Expansion.

## Query Engine

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
820 passing across 34 files (68 in this package).

### Graph API additions applied first

| Approved addition | Applied |
|---|---|
| `getRoles(nodeId)` | Per-node roles, ordered by role name, each with its confidence and evidence. |
| `getUnresolved()` | Every unresolved reference, ordered by identifier. |
| Optional `relationshipType` on `getIncoming` / `getOutgoing` | Served by a **separate prepared statement** rather than a nullable predicate, so each stays a plain indexed lookup SQLite plans once. |

Eight operations now, still each a direct lookup. No predicate, range or ordering option
was added.

### Completed Work

- `QueryEngine`, constructed from a `RepositoryGraphApi` and nothing else. Runtime
  dependencies are `@traceiq/graph-api` and `@traceiq/types` — verified, no SQLite.
- All eleven listed operations, plus `findByRole` as the general form the three named
  role queries delegate to.
- Every result carries the graph node or edge it came from, so confidence, provenance and
  locations are never flattened away.
- Route path composition performed per query and never materialised.
- Verified against both an in-memory Graph API and a real SQLite graph built by the full
  pipeline, answering the same way.

### Files

Created: `packages/query/` (`types.ts`, `query-engine.ts`, `route-identity.ts`,
`hydrate.ts`, `index.ts`, `fake-graph.test-helper.ts`, `query-engine.test.ts`,
`pipeline.test.ts`, package files, README).

Modified: `packages/graph-api/src/graph-api.ts` and README;
`packages/graph/src/sqlite-graph-api.ts` and its test; root `tsconfig.json`,
`tsconfig.tests.json`, `vitest.config.ts`, `README.md`.

### Decisions

| Decision | Reason |
|---|---|
| Results carry the node or edge, not selected fields | Confidence, provenance and locations live on those objects. Copying a few fields out is precisely how explainability is lost. |
| `findReferences` excludes `DECLARES` | Containment is not a reference. Including it would make every member look referenced by its own container. |
| `findByRole` is the real operation; the three named queries delegate | One implementation instead of three near-duplicates, and roles beyond the three requested stay reachable. |
| Only `Class`, `Function` and `Variable` are scanned for roles | Those are the kinds the Framework Extractor annotates, so the scan is complete and much cheaper than every declaration kind. |
| Route identity is parsed on the first two colons | A path keeps its parameter colons: `route:GET:/users/:id` has three. |
| Composition reports `composed: false` rather than returning a bare path | A caller must be able to tell a complete path from one that may sit under a prefix. Silence would imply the former. |
| Unit tests run against an in-memory Graph API | If the engine works with no database present, it provably depends on the interface alone. The fake also counts calls, so bounded traversal is asserted rather than trusted. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`@traceiq/ir` was declared as a runtime dependency of the Query Engine and never imported by any source.** An unused runtime dependency in the one package whose dependency set is the milestone's main constraint. | Removed from `dependencies`. `typecheck:tests` then failed with `TS2307` because the pipeline test does import it, so it was declared as a **dev** dependency — the infrastructure fix catching exactly what it was built for. |
| **Stale documentation** in `graph-api`'s README, which still said roles and unresolved references were not exposed and that no edge filtering existed. | Corrected. |

### Known Limitations

- **Route prefixes are not composed, and this is the largest gap.** `app.use('/api/auth',
  authRoutes)` puts the mount path in the IR's `callSites`, but the Framework Extractor
  keeps only the middleware it names and discards the path, so nothing in the graph
  records where a router is mounted. A route reported as `/login` may really be
  `/api/auth/login`. Every route says so explicitly rather than implying completeness.
- `findByRole` scans, there being no role index on the Graph API.
- Edge hydration is one `getNode` per edge, there being no batch accessor.
- `findDependencies` returns every external, including TypeScript built-ins and
  `ext:outside-analysis`; callers filter on `externalKind`.
- No transitive queries: "what eventually calls this" needs recursion and `CALLS` edges,
  and neither exists.
- `findReferences` does not distinguish a type-only import from a value import; the IR
  knows, the graph edge does not carry it.
- One revision only, so no revision parameter.

### Next Milestone

Context Builder.

## Graph API

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
742 passing across 32 files (36 in `graph-api`'s consumer, `graph`, which now holds 156).

### Contract update applied first

| Approved decision | Applied |
|---|---|
| `FrameworkAnnotations` contains roles, routes, environmentVariables | The Graph Builder now consumes the **producer's own type** from `@traceiq/framework`, so writer and producer cannot drift. Its private duplicate was deleted. `environmentUsages` renamed to `environmentVariables` throughout. |
| Graph Builder consumes the complete annotation model | `Route` and `EnvironmentVariable` nodes, `HANDLED_BY` and `READS` edges, and `node_roles` rows are all produced. |
| Freeze `env:<NAME>` | `environmentVariableId()` added to `@traceiq/shared`; `env` and the previously-approved `ext` added to `NODE_ID_KINDS`, closing a gap where `ext:` was in use but never in the vocabulary. |
| No route prefix composition | Paths are stored as written. Recorded as a Query Engine responsibility in the spec. |

Spec amendments: §1.1/§1.3, §2.1–2.3, §4 (`ordinal` no longer reserved), §5.1
(`env:<NAME>` frozen, route-merge semantics), §6.2, §8.8, §10 (the Graph API layer),
§11.5.

### Completed Work

- New `@traceiq/graph-api`: the `RepositoryGraphApi` interface and the graph read model,
  depending on **no database at all**. This is what lets the Query Engine depend on an
  abstraction rather than on SQLite.
- The read model moved there from `@traceiq/graph`, which now imports it — one definition
  for reader and writer rather than two that can drift.
- `SqliteGraphApi` in `@traceiq/graph`: all six operations, prepared once, opened
  `readonly` so a read bug cannot corrupt a graph.
- `annotation-translator.ts`: routes, environment variables and roles into rows.
- Verified end to end: a fixture Express app produced `route:GET:/health`,
  `route:POST:/login` with ordinals 0 and 1 preserving middleware order, `env:PORT`
  merged from two reads, and `route:GET:/` correctly merged across two files with a null
  `file_id`.

### Files

Created: `packages/graph-api/` (`types.ts`, `graph-api.ts`, `index.ts`, `package.json`,
`tsconfig.json`, `README.md`); `packages/graph/src/annotation-translator.ts`,
`identity.ts`, `sqlite-graph-api.ts`, `sqlite-graph-api.test.ts`.

Modified: `packages/types/src/node-id.ts` and its vocabulary test;
`packages/shared/src/node-id.ts`, `index.ts` and its test; `packages/framework/src/`
(rename); `packages/graph/src/types.ts`, `graph-builder.ts`, `constraints.ts`,
`index.ts`, `graph-fixture.test-helper.ts` and three test files;
`docs/04-graph-spec.md`; root `tsconfig.json`, `tsconfig.tests.json`,
`vitest.config.ts`, `README.md`; `packages/graph/README.md`, `packages/ir/README.md`.

### Decisions

| Decision | Reason |
|---|---|
| The interface and read model live in a package with no driver | The stated reason for this milestone is that the Query Engine must never depend directly on SQLite. Putting the interface beside the implementation would have left the driver in its dependency tree. |
| The implementation stays in `@traceiq/graph`, beside the store | Every SQL statement in the system is then in one of two files, which makes "no SQL outside the Graph API" checkable rather than aspirational. |
| Exactly six operations, no filters | A type filter or depth limit is the beginning of a query language, and that is the Query Engine's. Adding one later is easy; removing it would not be. |
| The API opens the database `readonly` | A reader that cannot write is a stronger guarantee than a reader that merely does not. |
| The Graph Builder imports the producer's annotation type | A private duplicate would drift. Depending on `@traceiq/framework` for a type does not teach the graph what Express is. |
| A route identity carries no file, so registrations merge | The identity is frozen as `route:<METHOD>:<path>`. Merging is what that identity means; the alternative would be failing on `GET /` in two routers. |
| `getNodes` fetches locations in one query | Two statements regardless of how many nodes match, rather than one per node. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`ext:` was in use since the Graph Builder but never in `NODE_ID_KINDS`** — the vocabulary and the code disagreed. | Both `ext` and `env` added, with a conformance test. |
| **`edgeIdentity` and `strongerConfidence` would have been duplicated** into the annotation translator. | Extracted into `identity.ts` before the second use existed. |
| **The same declaration listed twice as a route handler** would have produced one edge identity twice and failed the build. | Deduplicated per route, keeping the first position. |
| **An environment name the frozen identity cannot carry** — `process.env['MY-VAR']` — would have thrown mid-build. | Recorded as an unresolved reference instead, visible and never mangled. |
| **Stale documentation**: the graph README claimed it "creates no Route nodes" and that `Route` was "still to come". | Corrected. |

### Known Limitations

- No accessor exposes roles or unresolved references; both are stored and neither is in
  the six operations.
- `getOutgoing`/`getIncoming` take no type filter, so a caller filters in memory.
- No batch accessor: fetching many nodes by identifier means one call each.
- A route merged across files has a `null` `file_id`, and paths are local — both
  consequences of prefix composition being deferred.
- `DatabaseTable` identities are still undefined, so that node type is not produced.
- Still one revision, `revision_id = 1`, hashes `NULL`.

### Next Milestone

Query Engine — traversal on top of the Graph API. Route prefix composition is now
explicitly its responsibility.

## Framework Extractor

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
689 passing across 31 files (78 in this package, plus 24 new IR tests).

### Blocking conflict found before implementation

The milestone named `RepositoryIR` and `ResolvedRepository` as the only inputs, but two
of the four extraction responsibilities were **unachievable** from them. Verified
empirically before writing code: on an Express fixture, `/login` and `process` appeared
nowhere in either structure. Route registration is a call expression and `process.env.X`
is a member access, and the IR recorded neither.

Options were put to you rather than guessed at. **Approved: extend the IR first**, so the
Framework Extractor stays a pure IR consumer with no compiler. The rejected alternative —
giving this package a `ProjectContext` — would have put ts-morph inside a framework
package and created a second AST traversal whose rules could drift from the IR's.

### IR extension (approved reopening of a completed milestone)

`RepositoryIR` gains two collections. Additive, so no consumer needed changing beyond
synthetic test constructors.

| Added | Contents |
|---|---|
| `callSites[]` | fileId, enclosingDeclarationId, calleeText, calleeRootName, calleeMemberName, arguments, location |
| `memberAccesses[]` | fileId, enclosingDeclarationId, text, rootName, path, location |

- A string-literal argument (or a template literal with no substitution) carries its
  **value**, which is what lets a consumer read a route path without parsing text.
- `memberAccesses` records only **outermost** identifier-rooted chains, never a callee —
  measured: this cut 1,958 records to 890 by removing prefixes and duplicates of call
  sites.
- **Expression traversal enters function bodies**; declaration traversal still does not.
  A local `class` is still not a declaration, while a call inside it is still a call site.
- Attribution uses declaration **node identity**, so it never restates which nodes the IR
  chose to record.
- Cost on this repository: 4,351 call sites and 1,067 member accesses across 86 files.

### Completed Work

- `FrameworkExtractor.extract({ ir, resolved })` → `FrameworkAnnotations`.
- Express detection anchored on the import, with the Resolver confirming the specifier
  resolved to the express *package* rather than a local module of that name.
- Router variables traced through a complete syntactic chain: express binding → call →
  variable.
- Routes for all eight HTTP methods, with literal and template-literal paths, ordered
  handler chains, and handler-to-declaration linking where the IR establishes it.
- Middleware attributed from **use-site evidence** — a non-final handler in a chain, or a
  `use` mount — in preference to any naming convention.
- Roles for Controller, Service, Repository, Middleware, Model and Test, by name suffix or
  directory segment, on top-level classes, functions and variables only.
- `process.env` reads including string-literal element access, attributed to the enclosing
  declaration.
- Verified on this repository: 60 roles, 0 routes, 0 env reads in ~1 ms — correct, since
  TraceIQ uses no Express.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | The annotation contract |
| `src/framework-extractor.ts` | Orchestration |
| `src/express-detection.ts` | Express anchoring and router tracing |
| `src/route-extractor.ts` | Routes and mounted middleware, in one pass |
| `src/role-extractor.ts` | Role conventions and use-site evidence |
| `src/environment-extractor.ts` | `process.env` reads |
| `src/index.ts` | Public surface |
| `src/framework-fixture.test-helper.ts` | Real pipeline fixtures |
| `src/routes.test.ts`, `src/roles.test.ts`, `src/environment.test.ts` | 78 tests |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Added to `@traceiq/ir`: `src/access-chain.ts`, `src/expression-extractor.ts`,
`src/expressions.test.ts`. Modified: `packages/ir/src/types.ts`,
`declaration-extractor.ts`, `ir-builder.ts`, `index.ts`, `README.md`; synthetic IR
constructors in `packages/resolver/src/declaration-index.test.ts` and
`packages/graph/src/graph-fixture.test-helper.ts`; root `tsconfig.json`,
`tsconfig.tests.json`, `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Extend the IR rather than give this package a compiler | Keeps one AST walk and one set of rules, keeps ts-morph out of a framework package, and is the prerequisite for `CALLS` edges. |
| Every annotation is `INFERRED` | Express has no base class, decorator or interface. Every claim rests on a convention or on a chain a reassignment could break. `CERTAIN` would overstate; `RESOLVED` is unavailable without a resolver. Strength lives in the evidence text. |
| A route requires a *traced* router variable | Without it every `foo.get(...)` in the repository looks like a route. It costs recall, which is recorded as the largest limitation. |
| Use-site evidence beats naming for Middleware | `router.get('/x', authGuard, handle)` makes `authGuard` middleware whatever it is called — a fact about the code, not a guess about its name. |
| `use` produces no route | It carries no HTTP method. Its path composes a prefix onto routes elsewhere, which this milestone does not resolve. |
| Roles attach only to top-level classes, functions and variables | A method plays no architectural role; its class does. |
| No framework abstraction | One framework cannot show what a second would need. A plugin seam invented now would be a guess. |
| The `ResolvedRepository` is genuinely used | Confirming the express *package* rather than the specifier text. An unused parameter satisfying a contract would have been dead weight. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`readExpressFacts` was O(files × callSites)** — it re-scanned every call site once per express-importing file. | Call sites grouped by file once and shared by every annotator. |
| **Route and `use` extraction each rebuilt the same declaration index and repeated the same router check.** | Merged into one pass over each file's call sites. |
| **`ResolvedRepository` was accepted and never used**, a dead parameter dressed as a contract. | Now supplies express package confirmation, which appears in every route's provenance. |
| **The IR's own file header claimed it recorded "no call sites"** after the extension made that false. | Header corrected; the IR is now described as purely *syntactic* rather than *structural*. |
| **An unused import in the route extractor** passed Vitest and failed the build. | Removed — caught by `pnpm build`, with `typecheck:tests` covering the test files. |

### Pending Tasks

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. Confirm `ext:outside-analysis`.
5. Per-package tsconfig in a monorepo.
6. Job orchestration — still unowned.
7. Incremental indexing and content hashes.
8. **Route prefix composition** — `app.use('/api', router)` is unresolved, so reported
   paths are as written locally. *(New.)*
9. **Whether the Graph Builder should consume these annotations now** — it accepts a
   `FrameworkAnnotations` input with a `roles` field only, and this package produces a
   richer type including routes. They need reconciling before routes reach the graph.
   *(New.)*
10. Evaluation strategy — still nothing measures accuracy, and this is the milestone
    where it would bite hardest: role and route detection are heuristic by nature.
11. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Two packages and both apps remain documentation only.
- No linter or formatter is configured.
- A router arriving by import is not traced, so its routes are missed.
- Convention-based roles fire on any repository: on this one, `mountedMiddleware` is
  annotated `Middleware` purely by name.
- `Test` is broad — every top-level declaration in a test file receives it.
- `CALLS` edges still do not exist; the IR records call sites but nothing binds them.

### Next Milestone

Query Engine — the only read path to the graph. Item 9 above should be settled first: the
Graph Builder's annotation input and this package's output type are not yet the same
shape, so routes cannot reach the graph until they are.

## Graph Builder

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
585 passing across 27 files (118 of them in this package).

### Approved decisions applied to the specification

`docs/04-graph-spec.md` was amended before implementation, and the amendments are the
contract now:

| Decision | Applied |
|---|---|
| External identities `ext:npm:` / `ext:node:` / `ext:builtin:`, versions never in identities | §5.2 rewritten |
| Keep the revision schema; `revision_id = 1`, hashes `NULL` | §8.3; both hash columns made nullable, `file_revisions` now has a writer |
| `better-sqlite3` | §11.6 |
| Unresolved references stay in their own table | §11.4 |
| `EnvironmentVariable` / `DatabaseTable` deferred | §11.5 |

### Completed Work

- `GraphBuilder.build({ ir, resolved, annotations })` → `RepositoryGraph`, a pure
  translation with no filesystem, compiler or database.
- `GraphStore.open(path)` / `write(graph, createdAt)` / `close()`, owning the schema,
  pragmas and transactions as the single writer.
- 14 node kinds, 6 edge types, the full legal endpoint matrix, and the `DECLARES`
  derivation with its upward walk.
- External nodes in all four identity forms, with the permitted confidence maximum.
- Every table populated, including `file_revisions` with null hashes.
- Validation in the builder *and* in SQLite: foreign keys plus `CHECK` constraints.
- Verified on this repository: 659 nodes, 1930 edges, 3 unresolved, 22 external nodes;
  translation ~2 ms, write ~30 ms; `integrity_check` ok and `foreign_key_check` empty.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | Graph data contract, node kinds, `FrameworkAnnotations` |
| `src/graph-builder.ts` | The pure translation |
| `src/graph-store.ts` | SQLite ownership, transactions, prepared statements |
| `src/schema.ts` | DDL, `CHECK` constraints, delete order |
| `src/constraints.ts` | Legal endpoint matrix and pre-write validation |
| `src/declares.ts` | The `DECLARES` derivation |
| `src/external-identity.ts` | The approved `ext:` scheme |
| `src/index.ts` | Public surface |
| `src/graph-fixture.test-helper.ts` | Synthetic IR and resolved inputs |
| `src/graph-builder.test.ts` | Nodes, edges, enrichment, determinism, constraints |
| `src/graph-store.test.ts` | Schema, rows, integrity, transactions, determinism |
| `src/declares.test.ts` | The keystone derivation, including the dotted-namespace case |
| `src/constraints.test.ts` | Endpoint matrix conformance |
| `src/external-identity.test.ts` | All four identity forms |
| `src/pipeline.test.ts` | Real TypeScript through all five stages into SQLite |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `docs/04-graph-spec.md`, `pnpm-workspace.yaml` (native build approval), root
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Builder and Store are separate modules | The builder is pure and testable without SQLite; the store owns schema and transactions. Neither leaks into the other. |
| `createdAt` is supplied by the caller | The graph is deterministic; a clock read inside the store would make identical writes differ. The one time-dependent value belongs to the caller. |
| Validation in the builder *and* in SQLite | The builder's check names the edge and the rule; SQLite is the backstop that stops a defect reaching disk. |
| `edges.type` constrained, `nodes.kind` not | The relationship vocabulary is frozen so a `CHECK` is free; node kinds are open, so a `CHECK` would force a migration. |
| `nodes` emptied in two statements | `nodes.file_id` is self-referential, so declarations must be deleted before the `File` rows they reference. Avoids deferring enforcement. |
| Store sorts files first rather than trusting builder order | Removes an implicit coupling; the store does not depend on how the builder ordered its output. |
| A declaration with no location fails the build | The IR guarantees one. Substituting a placeholder would persist a fiction. |
| No read API on the store | A shortcut here would let features bypass the Query Engine and freeze the storage decision. |
| Native build script approved explicitly in `pnpm-workspace.yaml` | pnpm blocks build scripts by default; `better-sqlite3` ships a native addon and needs it. Recorded rather than silently enabled. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **Deleting all nodes in one statement could violate a foreign key.** `nodes.file_id` is self-referential, so a `File` row could be deleted while declarations still referenced it — depending on row order. | Two statements: non-`File` nodes first. |
| **The store invented a timestamp**, which broke determinism between otherwise identical writes and contradicted the spec's "supplied by the caller". | `write` takes `createdAt`. |
| **A defensive location fallback would have persisted a fabricated 1:1 position** for a declaration with no site. | Fails fast instead. |
| **Test files had four type errors and an unused import**, passing at runtime while being type-broken. | Caught by `pnpm typecheck:tests` — the infrastructure fix from this milestone finding a real defect in its own milestone. |

### Pending Tasks

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. **Confirm `ext:outside-analysis`** — the fourth identity form the approved scheme
   does not name. *(New.)*
5. Per-package tsconfig in a monorepo — still caps cross-package edges.
6. Job orchestration — still unowned.
7. Incremental indexing and content hashes — the columns exist and are null.
8. `EXPOSES_ROUTE` and `Route` identities — due at the Framework Extractor.
9. Evaluation strategy — still nothing measures accuracy.
10. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Three packages and both apps remain documentation only.
- No linter or formatter is configured.
- No migrations: a database with a different `schema_version` is refused.
- A write replaces the previous graph; there is no history.
- `DEPENDS_ON` is not producible — no `Repository` node, and the dependency list is
  not an input.

### Next Milestone

Query Engine — the only read path to the graph. Items 4 and 7 are worth settling
first: item 4 affects 14% of external references, and item 7 decides whether queries
must filter by revision.

## Resolver

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
467 passing across 21 files (108 of them in this package).

### Infrastructure Fix — test typechecking

Requested before this milestone, and the reason it was requested: the IR audit found
an undeclared dependency that survived because test files were never typechecked.

`tsconfig.tests.json` at the workspace root now owns every test file and nothing
else. It **references** the package projects rather than including their sources, so
a source file is still compiled exactly once by its own project and is consumed here
through declaration output — no duplicate compilation. Emit is off; the only product
is the typecheck. Strict mode is inherited unchanged from `tsconfig.base.json`.

Module resolution still starts from each test file's own directory, so pnpm's strict
isolation continues to apply and an undeclared dependency still fails.

Verified by introducing both faults deliberately: an import of a non-existent package
(`TS2307`) and a type error (`TS2322`) were both caught, while `pnpm build` still
passed with them present — which proves the two projects are disjoint. `vitest.config.ts`
is included too, since it was also unchecked.

Run as `pnpm typecheck:tests`, wired into CI between `build` and `test`.

### Completed Work

- `Resolver.resolve({ ir, context })` returning a `ResolvedRepository` of echoed
  metadata, enriched declarations, resolved relationships and unresolved references.
- Five sub-resolvers: declarations, imports, exports, heritage, type references.
- Import resolution at two granularities — the statement's module, and each binding —
  with aliases followed to the declaring symbol.
- Export resolution covering inline modifiers (CERTAIN), export specifiers,
  re-exports, star and named-star re-exports, and `export =`.
- `extends` and `implements`, plus heritage type arguments.
- Type references in property, variable, parameter, return and type-alias positions,
  including nested type arguments.
- Every relationship carries source identifier, target, confidence, provenance with
  human-readable evidence, and source location.
- Verified end to end on this repository: 434 declarations, 1164 relationships, 3
  unresolved, in ~50 ms. Every relationship source and declaration target is one the
  IR recorded, and the result survives a JSON round trip.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | The output contract. No ts-morph type appears in it |
| `src/resolver.ts` | `Resolver`, the single-pass orchestration |
| `src/declaration-index.ts` | Position-based correlation back to IR declarations |
| `src/symbol-target.ts` | Symbol to target, alias following, candidate collection |
| `src/resolution-collector.ts` | Accumulation and ambiguous-candidate expansion |
| `src/import-resolver.ts` | Modules and bindings |
| `src/export-resolver.ts` | Inline exports, specifiers, stars, `export =` |
| `src/heritage-resolver.ts` | `extends` and `implements` |
| `src/type-reference-resolver.ts` | Named types in declaration signatures |
| `src/declaration-enricher.ts` | Checker-confirmed facts per declaration |
| `src/external-classification.ts` | Package, builtin and lib classification |
| `src/source-position.ts` | Node position to IR range |
| `src/index.ts` | Public surface |
| `src/resolver-fixture.test-helper.ts` | Whole-pipeline fixtures |
| `src/resolver.test.ts` | Integration across every resolution path |
| `src/resolution-collector.test.ts` | Ambiguity expansion and collection |
| `src/declaration-index.test.ts` | Correlation keystone, on plain data |
| `src/external-classification.test.ts` | Specifier and path classification |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: root `package.json` (script), `.github/workflows/ci.yml`, root
`tsconfig.json`, `tsconfig.tests.json` (new), `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Unresolved references live in their own collection, not as a null target | They have no target and therefore no honest confidence. The four levels describe how much a resolution is trusted; stretching one to mean "failed" would make the vocabulary useless. Nothing is dropped. |
| Relationship types are an `Extract` of the frozen vocabulary | A name outside the contract fails to compile instead of quietly inventing vocabulary. |
| No `ALIASES` relationship | Following an alias is how an `IMPORTS`/`EXPORTS` target is reached, not a separate fact. The provenance records the hop. |
| Correlation by source position, not by recomputing identifiers | The IR already decided which declarations exist and which names it could address. Re-deriving that would duplicate the rules and let them drift. |
| Position match plus a declaration-kind guard | An `export` keyword shares its start position with the declaration it modifies, so position alone matches the wrong node. |
| `source-position.ts` duplicated rather than shared | Exporting it from `@traceiq/ir` would put a ts-morph type in that package's public API. Correlation tests are the canary against divergence. |
| Walk every descendant per file | Costs one traversal and restates none of the IR's traversal rules; correctness comes from the position match rather than two modules agreeing where to look. |
| `external` is a successful resolution | Knowing `express` comes from a package is what a consumer needs. Only genuine failures are unresolved. |
| `typescript-lib` carries no name | `Promise` is declared across five lib files; naming the file made one type look like five ambiguous candidates. |
| `node:` specifiers are CERTAIN node-builtins | The prefix is reserved, so the text alone identifies a builtin. TypeScript never resolves one to a file, so this is the only path that sees them. Distinguished from an inferred uninstalled package. |
| Star re-exports resolve to the module, not expanded | The forwarded set is derived rather than written; materialising it is closer to organising than enriching. |
| Declarations carry provenance but no confidence | They are observations, not resolutions of a reference. |
| Candidate groups derived from the reference site | Deterministic, so repeated runs are comparable. |

### Defects Discovered and Fixed

All found by probing the implementation before writing tests, or during self-review.

| Defect | Fix |
|---|---|
| **False ambiguity on every TypeScript built-in.** `Promise` produced five AMBIGUOUS candidates, one per `lib.*.d.ts` declaring it. Genuine ambiguity would have been buried in the noise. | `typescript-lib` targets carry no file name, so they collapse to one. |
| **Heritage type arguments were silently lost.** The `Repo` in `extends Base<Repo>` resolved nowhere, and the heritage resolver's comment claimed the type reference resolver covered it — it did not. | Heritage type arguments are now collected as type references, and the comment is true. |
| **Type parameters reported as `declaration-not-in-ir`**, which reads like an IR defect when a type parameter simply is not an IR declaration. | Added the distinct `type-parameter` reason. |
| **`node:` specifiers reported as npm packages.** All 26 in this repository were labelled `origin: 'package'` with names like `node:path`. | Added the `node-builtin` origin, classified as CERTAIN. |
| **Namespace imports recorded as resolution failures.** `import * as ns` binds the module, which is a legitimate target. | The namespace binding is recorded against the module target. |
| **Vacuous ambiguity tests.** The fixture asserted over an empty set: two same-named interfaces in separate modules do not merge, so no AMBIGUOUS relationship was ever produced. | Replaced with direct unit tests of the collector, plus an explicit assertion that this fixture produces none, and the limitation documented. |
| Duplicated bare-specifier handling between the import and export resolvers. | Factored into `classifyUnresolvedSpecifier`. |
| Dead logic in `moduleExportNameOf` — an unreachable branch and a meaningless guard. | Reduced to declaration-node identity, which is what actually settles it. |

### Pending Tasks

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. ~~Test files are never typechecked.~~ **Resolved** by the infrastructure fix above.
5. **Per-package tsconfig in a monorepo.** Now has a measured cost: 169 of 1164
   relationships on this repository resolve to `outside-analysis` because a
   workspace sibling resolves to its `dist` declaration output rather than its
   source. Cross-package edges therefore do not reach declarations. Deliberately
   not addressed, per instruction.
6. Job orchestration — still unowned.
7. Revision handling and incremental refresh — due at the Knowledge Graph.
8. `EXPOSES_ROUTE` — due at the Framework Extractor.
9. Evaluation strategy — still nothing measures accuracy.
10. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Four packages and both apps remain documentation only.
- No linter or formatter is configured.
- `AMBIGUOUS` is currently unreachable; see the package README for why.
- Star re-exports are not expanded to the symbols they forward.
- Type parameter constraints are not examined.
- A bare Node builtin without the `node:` prefix is classified as a package.

### Next Milestone

Graph Builder — turn resolved facts into nodes and relationships in SQLite. Items 5,
7 and 9 above matter most before it: item 7 shapes the schema and is expensive to
retrofit, and item 5 caps how much of a monorepo the graph can connect.

## IR Builder

**Status:** complete. `pnpm build` clean, `pnpm test` 364 passing across 17 files
(141 of them in this package).

### Completed Work

- `IrBuilder.build(context)` returning a `RepositoryIR` of repository, files,
  declarations, imports and exports.
- Twelve declaration kinds, each with a stable `sym:` identifier, source locations,
  visibility where applicable, and six syntactic modifiers.
- Identifier folding for sites that legitimately share a symbol path: overload
  signatures, getter/setter pairs, merged interfaces.
- Import statements with default, named and namespace bindings, and type-only flags
  at both statement and specifier level.
- Export statements — named, re-export, star, star-as, default, equals — plus
  exports written as a declaration modifier, linked to their declaration.
- Verified against this repository: 53 files, 294 declarations, 131 imports, 139
  exports in ~450 ms, identifiers unique, and the whole IR survives a JSON round
  trip. The 7 ECMAScript private fields in TraceIQ's own code are addressed
  correctly.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | The IR contract. No TypeScript or ts-morph type appears in it |
| `src/ir-builder.ts` | `IrBuilder`, `IrBuildError` |
| `src/declaration-extractor.ts` | Syntax-tree walk over structural declarations |
| `src/declaration-collector.ts` | Identifier-keyed accumulation and site folding |
| `src/import-extractor.ts` | Import statements and bindings |
| `src/export-extractor.ts` | Export statements |
| `src/modifiers.ts` | Modifier defaults and scope-to-visibility mapping |
| `src/addressable-name.ts` | Which names the identifier format admits |
| `src/source-range.ts` | Node position to IR range |
| `src/index.ts` | Public surface |
| `src/ir-fixture.test-helper.ts` | Temporary repositories loaded through the Project Host |
| `src/declarations.test.ts` | Kinds, identity, locations, visibility, modifiers, folding, boundaries |
| `src/imports-exports.test.ts` | Every import and export form |
| `src/ir-builder.test.ts` | Metadata, files, determinism, language independence, failures |
| `src/declaration-collector.test.ts` | Folding and merge semantics in isolation |
| `src/addressable-name.test.ts` | Addressable and unaddressable names |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `packages/shared/src/node-id.ts` and its tests (defect fix, below), root
`tsconfig.json`, `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| The identifier is the unit; sites sharing one are folded into a declaration with several `locations` | The contract's format is a symbol path, so overloads, getter/setter pairs and merged interfaces genuinely share one. Emitting duplicate identifiers would collide the moment the graph keyed a node on one. **Needs approval — this shapes the contract every later module reads.** |
| The type checker is never consulted | Everything recorded is visible in the syntax tree, which keeps the IR cheap and makes it safe to treat as stable. A file that does not type-check yields the same IR. |
| No type information at all | Annotation text, signatures and parameters are absent. Type references are the Resolver's work, and storing annotation text would invite consumers to parse strings. |
| No references and no call sites | The milestone specifies declarations, imports and exports. Both are the natural next addition and disturb nothing here. |
| Flat collections carrying `fileId` | Matches the specified IR shape, and the common case — iterating every declaration — needs no traversal. |
| Function bodies are not entered | A declaration local to a function is not repository structure. Consistent with the scanner's decision not to persist locals. |
| Only `namespace` module declarations are entered | An ambient `declare module 'x'` or `declare global` describes external or global shape, and its quoted, dot-containing name is not a valid chain segment. |
| Unaddressable names are skipped | Destructuring patterns, computed members and string-literal members have no stable representation in the identifier format. Skipping is silent; recording a count would change the IR's specified shape. |
| A dotted namespace becomes nested segments | `namespace A.B {}` means exactly that. Its export names `A`, with no `declarationId`, because the source declares no `A`. |
| Anonymous default exports are named `default` | They still need a stable path, and TypeScript calls the symbol `default`. |
| Inline exports are emitted once, on first collection | Emitting per site exported an overload set three times. TypeScript requires merged declarations to agree on `export`. |
| `declarationId` only for an inline `export` modifier | For `export { local }`, matching the name needs scope analysis, which is resolution. |
| `@traceiq/scanner` is a dev dependency | The test helper needs `RepositoryInventory` to construct one. No source file imports it. |

### Defects Discovered and Fixed

| Defect | Where | Fix |
|---|---|---|
| **`symbolId` rejected every ECMAScript private field.** `#` was forbidden anywhere in a chain segment, so `#secret` threw and TraceIQ could not represent private state at all. | `@traceiq/shared` (approved milestone) | Allow `#` as a leading private-name marker; still reject `.` and any interior or trailing `#`. Parsing splits on the first `#`, which always ends the path, so later ones are unambiguous. Three tests added. **Genuine defect in a completed milestone.** |
| **Duplicate export entries.** A merged interface appeared twice in `exports` and a three-signature overload set three times, because an inline export was pushed per syntactic site. | `declaration-extractor.ts` | `DeclarationCollector.add` now reports `isNew`; the export is recorded only on first collection. |
| **Exported namespaces produced no export entry.** `export namespace Outer {}` was missing from `exports` entirely, because namespace extraction bypassed the path that records inline exports. | `declaration-extractor.ts` | Namespace extraction routes through the same recording path, which takes multiple name segments. |
| **A dotted namespace exported the wrong name.** `export namespace Deep.Nested {}` reported `Nested`; the module exports `Deep`. | `declaration-extractor.ts` | The exported name is the first chain segment, and `declarationId` is null when there is more than one. |
| **Undeclared dependency.** The test helper imported `@traceiq/scanner`, which pnpm never linked. It resolved only through the vitest alias and was never typechecked. | `packages/ir/package.json` | Declared as a dev dependency. |

Found during self-review and removed: `groupByFile`, a helper exported for a future
milestone with no current consumer.

### Pending Tasks

Carried forward, unchanged except where noted:

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. **Test files are never typechecked.** *(New.)* Every package excludes
   `**/*.test.ts` from `tsc`, and Vitest only transpiles, so test code can contain
   type errors indefinitely — which is how the undeclared dependency above survived.
   The IR's tests were verified clean with a throwaway config, but the structural
   fix touches all five completed packages and is therefore not applied.
5. Per-package tsconfig in a monorepo — still open, and now due: the Resolver's
   accuracy depends on module resolution using the repository's real options.
6. Job orchestration — still unowned.
7. Representation of `AMBIGUOUS` — due at the Resolver.
8. Revision handling and incremental refresh — due at the Knowledge Graph.
9. `EXPOSES_ROUTE` — due at the Framework Extractor.
10. Evaluation strategy — still nothing measures accuracy. The IR is the first
    output a fixture repository could be labelled against precisely.
11. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Five packages and both apps remain documentation only.
- No linter or formatter is configured.
- Declarations whose names the identifier format cannot address are skipped
  silently.
- The identifier cannot distinguish a static from an instance member of the same
  name.
- `import x = require('y')` is not captured.
- The repository name comes from the root directory, not package.json.

### Next Milestone

Resolver — bind the references the IR records to the declarations they reach. Items
5 and 7 above should be settled first, and item 10 matters most here: resolution
accuracy caps every downstream feature and nothing currently measures it.

## Project Host

**Status:** complete. `pnpm build` clean, `pnpm test` 221 passing across 12 files.

### Completed Work

- `ProjectHost.load(inventory)` returning a `ProjectContext`.
- One ts-morph `Project` per context, created from the inventory's file set.
- Compiler options read from the repository's `tsconfig.json`, with documented
  defaults when it has none.
- `Program` created eagerly; `TypeChecker`, `sourceFiles` and `compilerOptions`
  exposed, plus lookup by repository-relative path.
- Explicit lifecycle: `dispose()` releases every reference, and all accessors then
  throw `ProjectContextDisposedError`.
- Verified end to end against this repository through the real scanner: 37 source
  files, 34 ms to load, ~180 MB heap, and the checker resolved a method's return
  type across a package boundary to the actual `RepositoryInventory` declaration.
- Verified that a symbol imported from a hand-built `node_modules` package resolves
  to its real type while its declaration file stays out of `sourceFiles`.

### Files Created

| File | Purpose |
|---|---|
| `src/project-host.ts` | `ProjectHost`, `ProjectHostError` |
| `src/project-context.ts` | `ProjectContext`, `ProjectContextDisposedError` |
| `src/compiler-options.ts` | `DEFAULT_COMPILER_OPTIONS`, frozen-copy helper |
| `src/index.ts` | Public surface |
| `src/project-fixture.test-helper.ts` | Temporary projects and hand-built inventories |
| `src/project-host.test.ts` | Loading, options, checker, scope, lifecycle, failures |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `packages/scanner/tsconfig.json` and `packages/scanner/package.json`
(see the `@types/node` decision below), root `tsconfig.json`, `vitest.config.ts`,
root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| `types: ["node"]` and an explicit `@types/node` devDependency per package that uses Node builtins | Automatic `@types` acquisition does not reach leaf packages under pnpm's isolated layout, so `node:path` had no ambient declaration. **This also fixed a latent bug in the approved scanner:** it compiled only because `fast-glob`'s declarations import from `'fs'` and `'stream'`, which dragged `@types/node` into its program by accident. Removing fast-glob would have broken it. Explicit is also what the contract asks for over magic. |
| The inventory decides scope; tsconfig supplies options only | `include`/`exclude` answer "what to compile", not "what to analyse". Letting them decide would let the analysed set disagree with the inventory that produced it. `skipAddingFilesFromTsConfig` is set. |
| `load` is synchronous | Creating the `Program` is CPU-bound and cannot yield. A promise would imply otherwise. Progress and cancellation belong to a layer above, which does not exist by decision. |
| One `Project` per context, not per process | A process-wide singleton would be global state, which the architecture forbids. The two constraints together only resolve this way. The host is stateless. |
| Emission prevented by API shape, not by forcing `noEmit` | The `Project` is never exposed, so nothing can call `emit`. Overriding options would risk conflicting with a repository's own settings — `composite` and `noEmit` interact — for no added guarantee. |
| Compiler options leave as a frozen copy | The compiler's options object is mutable and shared with the `Program`; handing it out would let a consumer change how the checker behaves. |
| Files added individually, not by batch glob | The batch call takes globs, so a path containing glob syntax would be misinterpreted and a failure would name the batch rather than the file. |
| A stale inventory fails the load | Silently skipping a missing file would make the analysed set differ from the inventory with nothing saying so. |
| Contexts are immutable snapshots | A checker that could be invalidated underneath a consumer mid-analysis would be unusable. |
| Explicit `dispose` with throwing accessors | The context holds the compiler's memory for a whole repository. A stale context should fail loudly rather than serve results from a program meant to be released. |
| `SourceFile` and `TypeChecker` re-exported | Lets a consumer type what it receives without declaring its own ts-morph dependency. |
| No diagnostics exposed | Nothing downstream consumes them yet. Adding them later is a one-line change. |

### Pending Tasks

Carried forward, unchanged except where noted:

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach, which modified the
   already-approved scanner package. *(New.)*
4. **Per-package tsconfig in a monorepo.** *(New, and the most consequential.)* A
   root solution tsconfig — `files: []` plus `references` — carries no real
   compiler options, so analysis runs under compiler defaults instead of the
   repository's actual settings, losing `paths` mappings among others. This
   repository is itself such a case. Honouring per-package configuration requires
   more than one `Project`, which is an architectural decision. Due before the
   Resolver, whose accuracy depends directly on module resolution being correct.
5. Job orchestration — deliberately excluded from this milestone. Still unowned.
6. Representation of `AMBIGUOUS` — due at the Resolver.
7. Revision handling and incremental refresh — due at the Knowledge Graph.
8. `EXPOSES_ROUTE` — due at the Framework Extractor.
9. Evaluation strategy — still nothing measures accuracy.
10. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Six packages and both apps remain documentation only.
- No linter or formatter is configured.
- Memory is proportional to the whole program rather than the analysed set: 37
  files here cost ~180 MB, because every declaration file reached through
  resolution is part of the program.
- `dispose` releases references only; reclamation depends on the garbage collector.
- Whether a repository type-checks is not reported.

### Next Milestone

IR Builder — convert TypeScript syntax into the language-independent
representation. Item 4 above is worth settling first: the IR records references
that the Resolver must later bind, and binding accuracy depends on the compiler
options being the repository's real ones.

## Repository Scanner

**Status:** complete. `pnpm build` clean, `pnpm test` 190 passing across 11 files.
*(Total is now 221 across 12 files, including the Project Host.)*

### Completed Work

- `RepositoryScanner.scan(path)` returning a `RepositoryInventory` with every
  field the milestone specifies.
- Source discovery via `fast-glob` for `.ts`, `.tsx`, `.mts`, `.cts`, ignoring the
  seven specified directories at any depth.
- Directory partitioning via an explicit pruning walk, so an ignored directory can
  be reported without being entered.
- Language, framework and package manager detection, each in its own module.
- `package.json` interpretation: name, dependency names across all four sections,
  and entry targets from `main`, `module`, `bin` and `exports` including nested
  condition maps and fallback arrays.
- Entry point resolution against discovered sources, recording whether each entry
  was declared or guessed.
- Error handling for a missing path, a file, an unreadable root and a malformed
  manifest.
- Verified against this repository: 31 sources, 21 directories, and all seven
  ignored directories located at depth including each package's `dist` and
  `node_modules`, without descending into any of them.

### Files Created

| File | Purpose |
|---|---|
| `src/repository-scanner.ts` | `RepositoryScanner`, `RepositoryScanError` |
| `src/types.ts` | `RepositoryInventory` and its supporting types |
| `src/ignore.ts` | Ignored directory names, glob patterns, membership test |
| `src/directory-walk.ts` | Pruning walk partitioning directories |
| `src/manifest.ts` | `package.json` reading, `MalformedManifestError` |
| `src/detect-language.ts` | Language detection |
| `src/detect-framework.ts` | Framework detection |
| `src/detect-package-manager.ts` | Lockfile precedence and selection |
| `src/entry-points.ts` | Entry point resolution |
| `src/index.ts` | Public surface |
| `src/repository-fixture.test-helper.ts` | Temporary repositories for tests |
| `src/repository-scanner.test.ts` | End-to-end scans against real directories |
| `src/directory-walk.test.ts` | Partitioning, pruning, symlink safety |
| `src/manifest.test.ts` | Manifest parsing and failure modes |
| `src/entry-points.test.ts` | Resolution, ordering, deduplication |
| `src/ignore.test.ts` | Ignore vocabulary conformance |
| `src/detect-language.test.ts`, `src/detect-framework.test.ts`, `src/detect-package-manager.test.ts` | Detection rules |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `tsconfig.base.json` (added `esModuleInterop`), `tsconfig.json` and
`vitest.config.ts` (registered the package), root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Directory partitioning uses `fs.readdir`, not glob ignores | `**/name/**` also matches the bare `name` entry, because the trailing `/**` matches zero segments. Glob ignores therefore cannot express "report the directory but do not enter it", which `ignoredPaths` requires. Found by a failing test, not by inspection. `fast-glob` still performs source discovery. |
| `esModuleInterop: true` added to `tsconfig.base.json` | `fast-glob` is published as CommonJS with `export =`, so it cannot otherwise be default-imported. Standard for a Node TypeScript project, but it changes shared config. **Flagged for confirmation.** |
| Scanner-local types, not `@traceiq/types` | The contract does not enumerate languages, frameworks or package managers as domain vocabulary. Promoting them would be an architectural decision. |
| Symlinks are never followed | Keeps the walk inside the repository and immune to cycles. A symlinked file or directory appears in no list. |
| Sources include `.d.ts` | The Project Host needs declaration files for resolution. Deciding what to do with one is a downstream concern, not a discovery one. |
| Entry points carry an `origin` | A declared entry and a conventional guess have different trustworthiness, and every inference must be explainable. |
| Declared targets pointing at build output are dropped | Build output is ignored and therefore never discovered. Mapping `dist/index.js` back to its source requires reading `tsconfig.json`, which belongs to the Project Host. |
| Malformed `package.json` throws; missing does not | Degrading would report language and framework as unknown for a repository that declares both, and the failure would be invisible. A repository with no manifest is still scannable. |
| Lockfile precedence rather than reporting ambiguity | Repositories accumulate lockfiles after migrations. `lockfile.path` records which file produced the answer. |
| Inventories are sorted | Walk order is not guaranteed; an unstable inventory would destabilise everything downstream. |
| Tests use real temporary directories | The scanner's job is to observe a filesystem; a mock would only prove it matches our model of one. |
| Sequential walk | Pruned at every ignored directory, so it covers the source tree only. Concurrency would trade a real file-descriptor risk for an unmeasured gain. |

### Pending Tasks

Carried forward from Workspace Setup, unchanged except where noted:

1. ~~Confirm the milestone sequence.~~ **Resolved** — milestones are named, not
   numbered.
2. Confirm the `shared` / `types` boundary.
3. Confirm `esModuleInterop` in the shared base config. *(New.)*
4. Job orchestration — still unowned; due at the Project Host milestone.
5. Representation of `AMBIGUOUS` — due at the Resolver.
6. Revision handling and incremental refresh — due at the Knowledge Graph.
7. `EXPOSES_ROUTE` — due at the Framework Extractor.
8. Evaluation strategy — nothing yet measures graph accuracy. The scanner is the
   first module producing output a fixture repository could be labelled against.
9. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Seven packages and both apps remain documentation only.
- No linter or formatter is configured.
- A source file whose name contains `#` is discovered but cannot become a symbol
  identifier. The scan is not failed over it; `@traceiq/shared` rejects it later.
- Only root-level `tsconfig.json` is located. A monorepo whose packages each carry
  one reports `tsconfigPath: null`.
- Conventional entry points are reported even when the file is a barrel that
  re-exports everything. `origin` marks the guess; nothing judges significance.

### Next Milestone

Project Host — construct and own the ts-morph `Project` from an inventory. Item 4
above should be settled first: the whole-program type checker makes analysis a
long-running single-threaded job, and run state, progress and cancellation
currently have no owner.

## Milestone 0 — Workspace Setup

**Status:** complete. `pnpm build` clean, `pnpm test` 50 passing across 3 files.

### Completed Work

- pnpm workspace over `apps/*` and `packages/*`.
- Strict TypeScript base configuration, with `tsc -b` project references so
  packages build in dependency order and typechecking is the build.
- Vitest at the workspace root, aliased to package sources so tests never depend
  on a prior build.
- `@traceiq/types` — the domain vocabulary from the engineering contract:
  confidence levels, roles, relationship types, the `NodeId` type and its
  prefixes. Conformance tests assert the exact contents of each closed set.
- `@traceiq/shared` — repository path normalisation and the `file:`, `sym:` and
  `route:` identifier builders, with validation that refuses input which cannot
  produce a stable identifier.
- Documentation for every package in the architecture, including the eight not
  yet implemented, so module boundaries are recorded before code exists.
- CI running install, build and test.

### Files Created

**Workspace root**

| File | Purpose |
|---|---|
| `package.json` | Workspace root, scripts, dev dependencies |
| `pnpm-workspace.yaml` | Workspace globs |
| `tsconfig.base.json` | Shared strict compiler options |
| `tsconfig.json` | Solution file referencing built packages |
| `vitest.config.ts` | Test discovery and package source aliases |
| `.npmrc` | `engine-strict=true` |
| `.gitignore` | Excludes build output and generated `.db` graphs |
| `README.md` | Project overview, layout, commands |
| `.github/workflows/ci.yml` | Install, build, test |
| `docs/progress.md` | This file |

**`packages/types`**

| File | Purpose |
|---|---|
| `src/confidence.ts` | The four confidence levels |
| `src/roles.ts` | The six architectural roles |
| `src/relationships.ts` | The thirteen relationship types |
| `src/node-id.ts` | Branded `NodeId`, permitted prefixes |
| `src/index.ts` | Public surface |
| `src/vocabulary.test.ts` | Contract conformance tests |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

**`packages/shared`**

| File | Purpose |
|---|---|
| `src/repo-path.ts` | Canonical repository path normalisation |
| `src/node-id.ts` | `fileId`, `symbolId`, `routeId` |
| `src/index.ts` | Public surface |
| `src/repo-path.test.ts` | Normalisation and rejection cases |
| `src/node-id.test.ts` | Identifier construction and rejection cases |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

**Documentation-only placeholders**

`packages/scanner`, `packages/project-host`, `packages/ir`,
`packages/resolver`, `packages/framework`, `packages/graph`,
`packages/query`, `packages/context`, `apps/api`, `apps/web` — each a
`README.md` recording purpose, responsibilities and non-responsibilities.

### Architecture Decisions

Decisions taken during this milestone, all approved before implementation except
where noted.

| Decision | Reason |
|---|---|
| pnpm workspaces | Strict dependency isolation: a package cannot import what it did not declare, so boundary violations fail at build time rather than at review. |
| Vitest | Runs TypeScript directly, so tests need no build step. |
| `tsc -b` project references | Correct build ordering across packages, and one command that is both build and typecheck. |
| Graph Builder inside `packages/graph` | The architecture names two stages, the package structure names one package. They are separate internal modules, Builder depending on Store. Open for revision when the schema exists. |
| `types` holds vocabulary, `shared` holds behaviour | `types` depends on nothing and contains no logic; `shared` depends on `types`. Declaration-only vocabularies would have no runtime representation and would be restated by every consumer that needs to validate one. **Not explicitly approved — flagged for confirmation.** |
| Only `types` and `shared` initialised | Both are fully specified by the contract. Initialising the other eight would be implementing future milestones early; documenting them keeps the boundaries recorded. |
| Express not installed | No endpoint exists to serve. Will be requested when `apps/api` is built. |
| `NodeId` is a branded string | Prevents an arbitrary string being used where an identifier is expected, at no runtime cost. |
| CI created | `.github/` is in the specified structure and this is the obvious reason for it. Runs install, build, test only. **Not explicitly approved — flagged for confirmation.** |

Resolved dependency versions: TypeScript 7.0.2, Vitest 4.1.10, `@types/node`
26.1.2. Local toolchain Node 26.4.0, pnpm 11.15.0. CI pins Node 22 to keep the
declared `engines` floor honest.

### Pending Tasks

Ordered by the milestone that needs each answer.

1. **Confirm the milestone sequence.** The engineering contract does not restate
   the roadmap, so no milestone numbering has been assumed anywhere in this
   repository.
2. **Confirm the `shared` / `types` boundary** described above.
3. **Job orchestration** — deferred by decision to the Project Host milestone,
   when analysis first becomes slow. Run state, progress reporting and
   cancellation currently have no owner, and `apps/api` cannot own them without
   violating the rule that business logic must not depend on Express.
4. **Representation of `AMBIGUOUS`** — the confidence level exists but the shape
   for storing several candidate targets does not. Needed by the Resolver.
5. **Revision handling and incremental refresh** — whether nodes and
   relationships carry revision ranges, how content hashes drive invalidation,
   and whether a relationship records the files it was derived from. All three
   shape the graph schema and are expensive to retrofit. Needed by the Knowledge
   Graph milestone.
6. **`EXPOSES_ROUTE`** — absent from the contract's relationship list. Without
   it, a `Route` has no relationship to the file that registered it. Needed by
   the Framework Extractor.
7. **Evaluation strategy** — nothing currently measures graph accuracy, which
   caps the quality of every feature. Unit tests cannot answer whether resolution
   improved or regressed. Needs fixture repositories with hand-labelled expected
   relationships, reporting precision and recall per extractor.
8. **UI milestone** — `apps/web` is reserved and empty because the roadmap
   contains no phase in which anything becomes visible.

### Known Issues

- Eight packages and both apps are documentation only. They have no
  `package.json` and are absent from the build, so `pnpm build` covers two
  packages. *(Superseded by the Repository Scanner milestone: seven packages
  remain documentation only.)*
- No linter or formatter is configured. Style is currently maintained by hand.
- The identifier scheme is derived from location, so a rename or file move reads
  as a delete plus a create. Accepted for Version 1; rename detection is out of
  scope.
- CI pins pnpm to major version 11 and Node to 22 without a lockfile-verified
  toolchain pin.

### Next Milestone

Repository Scanner — repository walk, inventory, project type, framework and
package manager detection, ignore rules. Blocked on nothing above; item 1 should
be confirmed first so this file can name milestones consistently.
