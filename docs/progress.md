# Progress

Milestones are referred to by name rather than number, since the engineering
contract does not restate the roadmap.

## TraceIQ Web

**Status:** complete. `pnpm --filter @traceiq/web build` clean,
`pnpm --filter @traceiq/web typecheck` clean, `pnpm test` 1,645 backend + 170 web passing.

### Completed Work

New `apps/web`: Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui over Radix, TanStack Query,
Zustand, React Flow, Monaco. Seven pages — Dashboard, Explorer, Symbol, Impact, Architecture, Health,
Search — plus a command palette, dark mode, a responsive shell and error boundaries.

**The frontend imports no backend package.** There is no `@traceiq/*` dependency, no
`transpilePackages` entry and no path mapping into `packages/`; the only contract is the REST surface.
`src/types/api.ts` is a hand-written *projection* of the wire format, verified against a live API
response for every endpoint before being written down.

The layering is one direction only: page → hook → service → api-client → `fetch`. No component builds a
URL or calls `fetch`; no service holds state or renders. Graph drawing, the one place logic could have
leaked into a component, is a pure function in `src/lib/graph-models.ts` with its own unit tests.

### Defects Found and Fixed — all found by probing, none by a test suite

| Defect | Fix |
|---|---|
| **The browser blocked every request.** The API sends no `Access-Control-Allow-Origin`, so a cross-origin call from the app's origin fails with `net::ERR_FAILED` before it is sent. Nothing in the test suite could see this — the tests stub `fetch`, which has no CORS. | The backend is frozen, so the app calls `/api/…` same-origin and a Next rewrite forwards to the upstream. Only the host changes. Verified that `%23`, slashes and query strings survive the proxy. |
| **React Flow drew 59 edges as zero edges.** A custom node without `Handle` children silently drops every edge attached to it, so the impact graph rendered as a field of unconnected boxes while the count beside it read "59 edges". | Added a target and a source `Handle` to the node. A regression test asserts both are present, since nothing else in the suite would notice. |
| **`Most coupled files` was labelled wrongly and showed the wrong column.** `HotspotReport.mostCoupled` holds *declarations* ordered by fan-in plus fan-out; the page called them files and displayed fan-out, which was 0 for most rows. | One shared `MetricList` showing fan-in, fan-out and both edge counts. Displaying a single column silently claims that column was the ordering; showing all four states what was measured. |
| **A 22-node package graph drew as one unreadable vertical strip**, then `fitView` shrank it until nothing was legible — and gave no hint why there were no edges. | `place` wraps a layer past ten rows into sub-columns; `GraphCanvas` takes a `noEdgesNote` and the Architecture page explains that a pnpm sibling import resolves through built output, so no package-to-package edge exists. |
| **`pluralise(20, 'entry')` produced "20 entrys".** | `ListingNote` takes an optional plural. |
| **Root `pnpm test` would have swept the web `.test.ts` files into the Node suite**, running them with no DOM. | The backend config excludes `apps/web`, and the root `test` script runs both configs in turn. A `test.projects` delegation was tried first and rejected: it dropped the JSX transform, failing all nine `.tsx` files. |

### Build configuration — three forced deviations

Next 15.5 does not support TypeScript 7, which the rest of the repository uses.

1. `next.config.mjs` rather than `.ts` — the TS config loader fails with
   `Cannot read properties of undefined (reading 'fileExists')`.
2. `typescript@^6` pinned **in `apps/web` only**. Next refuses to build otherwise: *"The TypeScript 7
   native compiler does not provide the JavaScript compiler API that Next.js requires."* pnpm's isolation
   keeps this local; no backend package changed. The alternative was Next 16, which the milestone did not
   specify.
3. The `@/…` alias is declared in `next.config.mjs` as well as `tsconfig.json`, because Next reads
   `paths` through that same loader and the alias otherwise never reaches the bundler.

`typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds` are set for the same reason. Types are
still fully checked by `pnpm typecheck` under `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, as a separate script that must pass.

### Performance on TraceIQ — 228 files, 3,148 declarations, 12,911 edges

| Page | Requests | Payload | Slowest request |
|---|---|---|---|
| Search | 1 | 16 KB | 2 ms |
| Symbol | 1 | 197 KB | 6 ms |
| Explorer | 3 | 366 KB | 4 ms |
| Dashboard | 3 | 403 KB | 8 ms |
| Architecture | 2 | 443 KB | 27 ms |
| Health | 3 | 981 KB | 19 ms |
| Impact | 2 | 2,024 KB | 18 ms |

First-load JS 103 KB shared plus 2–14 KB per page. React Flow only on the two graph pages; Monaco loaded
on demand and in no initial bundle. `staleTime: Infinity` because a graph is one immutable revision until
the next scan; a 4xx is never retried.

### Files Created

`apps/web`: `package.json`, `next.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `vitest.config.ts`,
`README.md`; `src/app/` (layout, providers, globals.css, error, loading, not-found and seven pages);
`src/components/ui/` (button, card, badge, input, table, skeleton, separator, tabs, dialog, scroll-area,
resizable); `src/components/layout/` (app-shell, nav, theme-toggle, command-palette, error-boundary);
`src/components/domain/` (states, node-pill, stat, listing-note, limitations, charts, metric-list, trees,
graph-canvas, json-inspector); `src/hooks/` (queries, use-theme, use-debounced); `src/services/`
(api-client, repository-service); `src/store/ui-store.ts`; `src/lib/` (utils, format, routes, theme,
graph-layout, graph-models); `src/types/` (api, assets); `src/test/` (setup, fixtures, harness);
15 test files.

### Files Modified

- `vitest.config.ts` — excludes `apps/web` from the backend suite, which now has a name.
- `package.json` — `test` runs both suites; `test:backend`, `test:web`, `typecheck:web`, `build:web` added.
- `pnpm-workspace.yaml` — `esbuild` and `sharp` added to `allowBuilds`.
- `README.md` — `apps/web` marked implemented; TraceIQ Web added to the stack diagram.

**No backend package was modified.**

### Known Issues

- **No source code is displayed.** No REST endpoint returns file contents, so Monaco is a read-only
  payload inspector instead. This is the one place the specified stack and the available API disagree.
- **`GET /route` has no page.** It is wired in the service and hook layers, but TraceIQ registers no
  route, so there was nothing to build a page against. Routes are reached through the declarations that
  serve them.
- **`POST /scan` is not exposed.** It is a long write-shaped operation and the API offers no progress
  reporting; the UI shows the API's own hint to run `traceiq scan`.
- Graphs are capped at 60 nodes. The cap and the true total are always reported.
- No linter is configured, here as elsewhere in the repository.

### Next Milestone

Repository Chat / the AI layer. **Not started, and not to be started without approval.**

## Context Builder

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,645 passing across 55 files (79 in this package).

### Completed Work

New `packages/context`: `RepositoryContextBuilder.build(request)` → `RepositoryContext`, over all seven
request kinds — symbol, impact, file, package, route, repository, search.

**The package cannot reach anything.** The constructor takes the five capabilities; there is no
`RepositoryGraphApi`, no store, no compiler, no filesystem and no HTTP anywhere in its surface, so the
boundary is enforced by the type rather than by discipline. The unit suite builds every kind from
fabricated answers with no graph in the file at all.

One envelope for every kind, with `kind` saying which parts are populated. Every value is a capability
result carried unchanged; nothing is recomputed, reshaped, ranked, scored or written in words.

`RepositoryNavigator` is deliberately absent — not in the permitted reuse set, and not needed, since
`QueryEngine.explainRoute` already splits a route's chain.

### Divergence from the reserved design, worth recording

The placeholder README written at workspace setup described **ranking results** and **loading source to
fit a token budget**. This milestone excludes both explicitly. Selecting source text for a budget needs a
model's tokeniser and is a judgement, so it belongs above a package that must stay deterministic. The
README now states this rather than leaving the two descriptions to contradict each other.

### Self Review — probed before the tests were written

| Criterion | Finding |
|---|---|
| Duplicate assembly | **Found:** `references.references` was literally the `callers` array again for the impact kind. Fixed to the union of calls, type positions and imports. |
| Duplicate traversal | None. The builder performs none; a per-build call counter proves each capability is called once per part. |
| Duplicate queries | **Found:** `explain` was called on `File` nodes, which always return `null` — one wasted capability call per file among affected nodes. Now only declaration kinds are explained. |
| Hidden graph access | None possible: no graph type appears in the package. Asserted by a test that builds a whole context from fakes. |
| Ordering issues | Limitations are deduplicated and sorted by code; related nodes keep the capability's order, which is depth-major for impact and alphabetical for search. |
| Storage leakage | `better-sqlite3` absent from the runtime closure; no context contains a path, connection or the string `sqlite`. |
| Capability overlap | **Found and resolved by design:** `browseSymbol` runs the impact analyser internally, so a symbol context carries impact as counts rather than running it a second time. The `impact` kind exists for the whole analysis, and `impact-summary-only` says so on every symbol context. |

### Defects Found and Fixed

| Defect | Fix |
|---|---|
| **`references.references` duplicated `incomingCalls`** for the impact kind — the same array under two names. | The union of `callers`, `typeReferences` and `imports`, which is what Explain Symbol means by references. |
| **`explain` was called on nodes that cannot be explained.** An affected set contains files; `explain` returns `null` for one, so five explanations cost six calls and `explainedNodes` disagreed with the call count. | Only declaration kinds are explained. Call count and explained count now agree. |
| **A package context labelled its imports as `outgoingCalls`.** An import is not a call, and a package is a grouping with no calls of its own. | `references` is empty for the package kind; imports stay on the package view where they belong. |
| **An impact context was 3 MB**, of which 1.7 MB was twenty explanations at ~85 KB each. A context exists to be consumed whole. | `EXPLAIN_LIMIT` is five, with the reasoning and the measurement recorded. Every affected node is still listed by identifier. Context dropped to 2.1 MB. |

### Performance on TraceIQ — 202 files, 2,594 declarations, 2,822 nodes, 11,185 edges

| Kind | Cold | Warm | Payload |
|---|---|---|---|
| `search` | 46.4 ms | **0.3 ms** | 78 KB |
| `impact` | 19.2 ms | **1.4 ms** | 2.1 MB |
| `symbol` | 72.1 ms | **2.6 ms** | 198 KB |
| `package` | 51.9 ms | 4.8 ms | 808 KB |
| `file` | 55.5 ms | 7.4 ms | 249 KB |
| `repository` | 161.3 ms | 11.4 ms | 1.4 MB |

**`health.analyze` at 4.9 ms warm is the bottleneck**, and it explains the ranking exactly: every kind
that calls it is slower than every kind that does not. Next is `hotspots` 1.4 ms, `cycles` 0.9 ms,
`browseSymbol` 0.7 ms, `impact.analyze` 0.3 ms, `overview` 0.1 ms, `architecture` 0.0 ms.

**Cold is the shared index build**, ~45 ms, paid once by whichever kind builds first — `search` cold at
46.4 ms is essentially the index and nothing else.

**The `repository` kind computes health twice**: `explorer.overview` derives a summary internally while
`health.analyze` produces the report. About 4.9 ms of its 11.4 ms, or 43%, reported as
`repository-health-computed-independently` rather than hidden.

### Files

Created: `packages/context/src/` — `types.ts`, `capabilities.ts`, `limitations.ts`, `builders.ts`,
`repository-context-builder.ts`, `index.ts`, `fake-capabilities.test-helper.ts`,
`repository-context-builder.test.ts`, `pipeline.test.ts`; `package.json`, `tsconfig.json`.

Modified: `packages/context/README.md` (replacing the not-implemented placeholder), root `README.md`,
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`. **No completed package changed.**

### Decisions

| Decision | Reason |
|---|---|
| The constructor takes capabilities, never a graph | Makes traversal, storage and filesystem access unrepresentable rather than merely absent, and lets the unit suite hold no graph at all. |
| One envelope for every kind | A consumer renders one object. A part that does not apply is `null` or empty rather than absent, so no field has to be probed. |
| `references` mirrors edges that also live in `primary` | A kind-independent accessor is worth modest repetition; the alternative is every consumer learning where each kind keeps its edges. Stated in the type so it is not mistaken for extra data. |
| A symbol context carries impact as counts | `browseSymbol` already ran the analyser; asking again would run it twice for one request. |
| `provenance` names the capability and operation per part | The risk of a composition layer is that a consumer cannot tell where a fact came from. |
| Explanations capped at five | One explanation is ~85 KB. Twenty made a context 3 MB of mostly bulk. Every related node is still listed, so more is one request away. |
| `ContextNotFoundError` rather than an empty context | An empty context reads as "nothing is recorded", not "this does not exist". A search matching nothing is not an error. |
| The repository kind carries three results as its subject | It has no single subject, and the milestone names the overview, architecture and hotspots together. |
| Per-build call counting | Makes "no duplicated assembly" measurable rather than asserted. |

### Known Limitations

- **Payloads are large** — impact 2.1 MB, repository 1.4 MB — because capability results are carried
  whole. There is no field selection.
- **A package context embeds the whole health report**, ~517 KB of its 808 KB. Many package contexts pay
  for the same report each time.
- **The repository kind computes health twice.**
- **At most five related nodes are explained**, with the unexplained count reported.
- Everything inherited from below: uncomposed route prefixes, partial call coverage, `INFERRED` calls, no
  interface or dynamic dispatch, path-derived packages, cross-package imports outside the analysed set.

### Approval Items

1. **Whether the explorer should expose the health report it already computes.** It would remove the
   duplicate computation from the repository kind and take ~43% off its warm time. It is a one-accessor
   addition to a completed package, so it is not done unilaterally.
2. **Whether a context should support field selection**, so a consumer can ask for a symbol context
   without 2 MB of explanations, or a package context without the health report.
3. **A `getNodesWithRole(role)` accessor on the Graph API.** Still the reason `health.analyze` is the
   bottleneck of this package, the CLI and the API alike.
4. **Whether the CLI and REST API should adopt this package** for their multi-capability commands. Both
   compose capabilities themselves today; routing them through the builder would give one definition of
   what belongs together, at the cost of touching two completed applications.
5. Carried forward: scan out of process; incremental scanning; response caching headers; asynchronous
   scan; four narrow Query Engine operations; a batch node accessor; `SourceRange` to `@traceiq/types`; a
   property or member-access relationship; interface dispatch as a relationship; a multi-link `this`
   unresolved reason; property-initializer constructions; mount annotations for route prefixes; whether
   the scanner should read sibling workspace packages' sources.

### Next Milestone

Awaiting instruction. The frontend, AI and Repository Chat are all explicitly not started.

## TraceIQ REST API

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,566 passing across 53 files (70 in the API).

### Completed Work

New `apps/api` — the HTTP interface — with all seventeen endpoints plus a generated
`GET /openapi.json`. Express 5, which the milestone approved; no other dependency was added, and the
HTTP tests use Node's built-in `fetch` rather than an unapproved testing library.

**The API contains zero repository intelligence.** Each endpoint validates its parameters, calls one
capability and returns that capability's result unchanged.

`ENDPOINTS` is the single source of truth for routing, validation and the OpenAPI document, so the
document cannot drift from the server. Tests assert both directions: every documented path is routed,
and no routed path is undocumented.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | Plain array of endpoints, `createApp(options)` takes its dependencies. No decorators, no DI framework, no ORM. |
| Performance | Scan 1,385 ms; every warm read 0.7–23.7 ms. Graph opened once, cache shared across requests. |
| Validation | Eleven codes over five statuses. A missing graph is 409, not 404. |
| Error handling | One shape for everything, including a body Express itself rejected. |
| Code reuse | Every payload is a capability result; the API adds only the envelope. |
| Duplicate logic | None. The endpoint table drives routing, validation and documentation from one place. |
| API consistency | `success`/`data`/`meta` everywhere; wildcards for every slash-bearing parameter; `null`-free errors. |
| Documentation | README covers architecture, request lifecycle, endpoint reference, identifier encoding, examples, performance and limitations. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **`GET /symbol/{id}` returned 404 for every valid identifier.** A declaration id contains `#`, which starts a URL fragment — the client strips everything after it, so the server received a truncated id. Found by calling the endpoint against TraceIQ, not by a test. | The endpoint was correct; the *documentation* was wrong — it told clients to send it unencoded. Fixed the OpenAPI parameter descriptions and examples to require `%23`. |
| **A truncated identifier gave a puzzling 404.** `sym:x/y.ts` with no `#` names no declaration, yet was reported as "the graph holds nothing named that". | Added a validation step: a `sym:` identifier must carry a `#`. It now returns **400** with a hint naming `%23`, so the encoding trap is diagnosed rather than mistaken for a missing symbol. |
| **A request identifier and a duration in `meta` would have made every body vary.** | Both moved to headers — `x-request-id`, `x-response-time` — leaving `meta` deterministic. Asserted: repeated requests return byte-identical bodies while their identifiers differ. |

### Real Repository Validation — every endpoint over HTTP

202 files, 2,594 declarations, 2,822 nodes, 11,185 edges, 2,906 call edges.

| Endpoint | Cold | Warm | Payload |
|---|---|---|---|
| `POST /scan` | **1,385 ms** | — | 372 B |
| `/ping` · `/version` · `/routes` | 1.3–2.2 ms | 0.7–1.7 ms | 107–163 B |
| `/overview` | 2.0 ms | 1.9 ms | 5 KB |
| `/packages` | 1.8 ms | 1.6 ms | 1.9 KB |
| `/files/{path}` | 1.9 ms | 1.8 ms | 82 KB |
| `/search?q=` | 2.0 ms | 1.7 ms | 15 KB |
| `/packages/{name}` | 2.5 ms | 2.3 ms | 276 KB |
| `/cycles` | 3.1 ms | 2.7 ms | 36 KB |
| `/impact/{id}` | 3.3 ms | 4.1 ms | **871 KB** |
| `/hotspots` | 4.0 ms | 3.7 ms | 398 KB |
| `/symbol/{id}` | 6.1 ms | 2.9 ms | 84 KB |
| `/health` | 9.2 ms | 7.9 ms | 517 KB |
| `/architecture` | 24.8 ms | 9.6 ms | 363 KB |
| `/dependencies/{id}` | 28.4 ms | 23.7 ms | 276 KB |

Largest response **871 KB** (`/impact`). Memory **165 MB before a scan, 502 MB after, 570 MB** after
every endpoint — the jump is the in-process scan retaining the compiler's program.

### Files

Created: `apps/api/src/` — `errors.ts`, `graph-holder.ts`, `respond.ts`, `endpoints.ts`, `app.ts`,
`openapi.ts`, `server.ts`, `index.ts`, `api.test.ts`, `http.test.ts`; `apps/api/bin/traceiq-api.js`;
`apps/api/package.json`, `tsconfig.json`.

Modified: `apps/api/README.md` (replacing the not-implemented placeholder from workspace setup), root
`README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`. **No analysis package
changed.**

### Decisions

| Decision | Reason |
|---|---|
| Observability in headers, determinism in the body | A request identifier and an elapsed time vary between identical requests, and a body that varies cannot be compared, cached or snapshot-tested. |
| One endpoint table for routing, validation and OpenAPI | Three uses of one declaration cannot drift; a hand-written spec would be the thing that rots. |
| Wildcards rather than `%2F` for slash-bearing parameters | A percent-encoded slash is mangled by proxies, and a path is what a client actually holds. |
| `#` must be `%23`, enforced with a 400 | It is a URL fragment delimiter. Diagnosing it beats a 404 that looks like a missing symbol. |
| 409 for a missing graph | The request was fine; the server has nothing to answer from yet. A client can tell "scan first" from "not there". |
| No locking around the graph | Every read capability is synchronous, so a request never yields while holding it; a scan swaps in one synchronous step. Stated in code rather than assumed. |
| `GraphHolder` on the app instance, not at module scope | Two apps in one process — as two tests are — must not see each other's graph. |
| A capability result is returned unchanged | Reshaping it would invent information and create a second definition of a payload. |
| OpenAPI describes payloads as objects | The shapes are defined by each capability's published types; copying them here would make the copy the stale one. |
| Fixed revision timestamp for a scan | Two scans of one repository write identical databases. |
| No HTTP testing library | Node's `fetch` against a real ephemeral-port server exercises more and adds no unapproved dependency. |

### Known Limitations

- **A scan is a full rebuild, in-process**: ~1.4 s blocking, ~320 MB retained afterwards.
- **One repository per server.**
- **Large payloads** — `/impact` 871 KB, `/health` 517 KB. No field selection, no pagination.
- **No authentication**, as specified.
- **No caching headers**; `etag` is explicitly disabled.
- **`GET /health` is the report, not a liveness probe** — `/ping` is.
- Everything inherited from below, each present in the payload's own `limitations` field.

### Approvals Needed Before the Frontend

1. **Whether a scan should run out of process.** It blocks the event loop for ~1.4 s and leaves ~320 MB
   of compiler state resident. A worker or subprocess would fix both, and matters as soon as anything
   re-scans while serving.
2. **Whether the API should support field selection or pagination.** A frontend rendering a tree does
   not need 871 KB, and `/impact`, `/health`, `/hotspots` and `/architecture` are all over 350 KB.
3. **Whether responses should carry `ETag` and `Cache-Control`.** Bodies are already byte-identical per
   revision, so conditional requests would be nearly free — but caching correctness across a rescan
   needs a revision identifier a client can see.
4. **Whether `/scan` should be asynchronous**, returning a job identifier a client polls, rather than
   holding the connection for the whole build.
5. **A `getNodesWithRole(role)` accessor on the Graph API.** Still ~2,300 of the first read's reads.
6. **Whether the scanner should read sibling workspace packages' sources**, so package dependencies stop
   being empty on every monorepo.
7. Carried forward: incremental scanning; four narrow Query Engine operations; a batch node accessor;
   `SourceRange` to `@traceiq/types`; a property or member-access relationship; interface dispatch as a
   relationship; a multi-link `this` unresolved reason; property-initializer constructions; mount
   annotations for route prefix composition.

### Next Milestone

Context Builder.

## TraceIQ CLI

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,496 passing across 51 files (74 in the CLI).

### Completed Work

New `apps/cli` — the `traceiq` command — with all fifteen subcommands, and new `@traceiq/pipeline`,
which owns the write path.

**The CLI contains zero analysis logic.** It parses a command line, opens a graph, calls one
capability and renders the result. Every number it prints was computed below it.

### The conflict this milestone opened with, and how it was resolved

`traceiq scan` must build and store the graph, which needs the scanner, project host, IR, resolver,
framework extractor, call graph, graph builder and store — all of which the CLI was forbidden to
import. Worse, **every read command** needs to open the stored graph, and the only
`RepositoryGraphApi` implementation lives in `@traceiq/graph`, also forbidden. The conflict covered all
fifteen commands, not just one.

Resolved by asking, and by the answer chosen: a new `@traceiq/pipeline` package owns `scan` and `open`
and hands back an abstract `RepositoryGraphApi`. It clears the two-future-consumer bar — the REST API
and the AI Context Builder both need exactly this, and neither should re-wire nine packages either.

### Self Review

| Criterion | Finding |
|---|---|
| API design | `run(argv, io)` is a function returning an exit status. No `process.exit`, no globals, so the whole CLI is testable by calling it. |
| Code reuse | Every command delegates. The CLI's only contribution is rendering. |
| Performance | Cold scan 1.45 s; every read command 0.13–0.24 s, one graph read per invocation. |
| Error handling | Eight codes, three exit statuses, fixed wording, stderr only. A usage error opens no graph. |
| Output consistency | One `Listing` shape renders one way everywhere; every cap prints its true total; every result's limitations are printed. |
| Documentation | README covers architecture, a command reference, examples, output rules, errors, performance and limitations. |
| Boundary violations | None in code. `better-sqlite3` and `ts-morph` are in the installed closure through the pipeline and must be — stated rather than glossed. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **The profile reported a meaningless `cache hits: 0`.** Each capability keeps its own cache under the CLI's shared one, so repeats are absorbed a level down and never reach the outer counter. A zero read as "the cache is not working". | Report distinct database reads only, and say in the code why a hit rate cannot be measured at that layer. |
| **The reuse test asserted an unobservable property** — that hits exceed reads. | Replaced with one that is observable and meaningful: `symbol` drives three capabilities and costs fewer reads than running them as separate commands. |

### Real Repository Validation — every command against TraceIQ

190 files, 2,448 declarations, 2,662 nodes, 10,492 edges, 2,674 call edges.

| Command | Wall clock | Reads | Result |
|---|---|---|---|
| `scan` | **1.45 s** | — | 190 files, 2,448 declarations, 9,608 unbound calls |
| `overview` | 0.20 s | 2,484 | coverage 0.2177, max depth 4, 685 isolated declarations |
| `architecture` | 0.20 s | 2,868 | Class 47, Interface 196, Function 367, Method 264, Variable 428 |
| `packages` | 0.18 s | 2,484 | **19 packages**, largest `packages/explorer` at 363 declarations |
| `package` | 0.22 s | 2,484 | `packages/health`: 14 files, 308 declarations |
| `file` | 0.20 s | 2,487 | per-file declarations, imports, externals |
| `symbol` | 0.24 s | 3,357 | `format.ts#table`: 23 callers, 2 callees, 27 references |
| `impact` | 0.18 s | 886 | `format.ts#heading`: 27 direct, 3 indirect, 136 unknown |
| `routes` | **0.13 s** | **1** | 0 — TraceIQ registers no Express routes |
| `route` | — | — | covered by the pipeline fixture, which has a real chain |
| `health` | 0.20 s | 2,484 | full metrics and findings |
| `search` | 0.21 s | 2,484 | `render` → 21 declarations |
| `dependencies` | 0.25 s | 2,588 | `packages/explorer`: closure 80, component 100 |
| `cycles` | 0.19 s | 2,484 | 17 call cycles, largest 2 |
| `hotspots` | 0.20 s | 2,484 | largest fan-in 63 — `explorer/src/types.ts#Listing` |

Largest output: `health` at 7.2 KB. Every read command is a fresh process paying its own start-up.

### Files

Created: `packages/pipeline/` — `types.ts`, `repository-pipeline.ts`, `index.ts`, `package.json`,
`tsconfig.json`. `apps/cli/` — `types.ts`, `errors.ts`, `format.ts`, `render.ts`, `session.ts`,
`commands.ts`, `cli.ts`, `index.ts`, `bin/traceiq.js`, `cli.test.ts`, `pipeline.test.ts`,
`package.json`, `tsconfig.json`, `README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`. **No analysis
package changed.**

### Decisions

| Decision | Reason |
|---|---|
| `@traceiq/pipeline` owns scan and open | The only way the CLI can build and read a graph without importing nine forbidden packages. Reused by the REST API and the context builder next. |
| `run(argv, io)` returns a status | A function, not a script: nothing exits the process, nothing is global, and the whole CLI is testable by calling it. |
| One `CachingGraph` per invocation, capabilities built lazily | A command driving three capabilities reads the database once; a command needing none of them reads nothing. |
| A fixed revision timestamp | Two scans of one repository produce identical databases. Nothing reads it back, so reproducibility costs nothing. |
| Three exit statuses, not one | A script can tell "I typed it wrong" from "it is not there". |
| Hand-written argument parsing | The grammar is two options and a verb; a dependency for that would be a larger surface than the thing it parses. |
| Profile reports reads, not a hit rate | The inner caches make a hit rate unmeasurable at this layer; reporting one would mislead. |
| No timing in any output | Output must be byte-identical for identical input. |

### Known Limitations

- **A scan is a full rebuild**; there is no incremental update.
- **One repository per database**, selected with `--db`.
- **Terminal lists cap at 20 rows** with the true total shown; the CLI does not page.
- **`better-sqlite3` and `ts-morph` are in the installed closure** through the pipeline, and must be.
  No SQLite or compiler concept reaches CLI code.
- Everything inherited from below — uncomposed route prefixes, partial call coverage, `INFERRED`
  calls, no interface dispatch, path-derived packages, cross-package imports outside the analysed set
  — each printed in the `Limitations` section of the command it affects.

### Approvals Needed Before the REST API

1. **Whether `@traceiq/pipeline` should gain incremental scanning.** A full rebuild is 1.45 s here and
   will not stay that way; an HTTP surface will want to re-scan without blocking.
2. **Whether the scanner should read sibling workspace packages' sources**, so package dependencies
   stop being empty on every monorepo. Carried forward and now visible in `traceiq packages`.
3. **A `getNodesWithRole(role)` accessor on the Graph API.** About 2,300 of every command's 2,484
   baseline reads are `getRoles`.
4. **Whether the CLI should gain `--json`.** An HTTP surface will need the same results as data, and
   the capability results are already plain JSON-safe objects — but it doubles the output surface, so
   it is not added unilaterally.
5. **Whether the Framework Extractor should emit mount annotations**, the only route to composed paths.
6. Carried forward: four narrow Query Engine operations; a batch node accessor; `SourceRange` to
   `@traceiq/types`; a property or member-access relationship; interface dispatch as a relationship; a
   multi-link `this` unresolved reason; property-initializer constructions.

### Next Milestone

TraceIQ REST API.

## Repository Navigation

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,422 passing across 49 files (101 in this package).

### Completed Work

New `@traceiq/navigation`: `RepositoryNavigator` with four operations — `explainRoute`, `routes`,
`architecture`, `dependencies` — plus `profile`. It combines Explain Route, Architecture Explorer and
Dependency Explorer into one layer that every future interface consumes.

**Explain Route** takes a method and path — `{ method: 'GET', path: '/users/:id' }` — or an identifier,
composes the frozen `route:<METHOD>:<path>` identity and **looks it up** rather than trusting it. It
returns the chain in running order with the whole `ExplainSymbolResult` per handler, the controller,
service and repository reached with their depths, dependencies, environment variables, external
packages, impact, call-graph and health summaries, the handlers that could not be linked, and the path
composition state.

**Architecture navigation** adds four trees: `architectureTree` (roles then kinds), `packageTree`
(package → file → declaration), `roleTree` (role → package → declaration) and `dependencyTree`
(package → package with edge counts).

**Dependency navigation** accepts a package, a file, a declaration or a route, adds the three
relationship graphs separated by type, and merges per-node answers rather than re-walking.

### Architecture decision requiring note

**One graph read for the whole layer.** `RepositoryExplorer` is constructed over navigation's own
`CachingGraph`, so the explorer's cache delegates here on a miss and only the explorer builds a
whole-graph index. Navigation never builds a second one — asserted: `getNodes` is called 16 times and
`getEdges` 13 times, not twice that.

**Impact Analysis and Repository Health are reused through Repository Explorer, not directly**, which
is why they are not direct dependencies. Constructing either here would build a second cache and a
second index over the same revision.

No new infrastructure package was introduced, and no frozen package changed.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | Four operations, five runtime dependencies, all repository intelligence packages. |
| Reuse | Verified by test: a repeated operation reads **nothing** from the database, and the index is built once. |
| Performance | 72 ms cold for the first operation, 5.45 ms warm; every other operation 0.04–22.9 ms. |
| API consistency | Every list is a `Listing` with `total` and `truncated`; `null` for a subject the graph lacks; identifier-or-name selectors throughout. |
| Duplicate traversals | None. Navigation performs no traversal of its own — it asks the explorer, which owns the closures. |
| Duplicate assembly | **Found and fixed:** the architecture response embedded the explorer's `ArchitectureView` *and* restated it as `architectureTree`. |
| Documentation | README covers the public API, architecture, route model, architecture model, dependency model, performance, examples and limitations. |
| Edge cases | Empty repository, no routes at all, a route whose whole chain is unlinked, a single-package repository — all covered. |
| Large repositories | A 12-package monorepo with a dependency ring and a 400-symbol file for cap behaviour. |
| Monorepos | The package unit is path-derived; cross-package edges are recovered wherever an import targets an in-repository declaration, and reported as a limitation where it cannot be. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **A role sat on a container while reach landed on its members**, so `repositories` was empty for a route that plainly calls `UserRepository.load` — the role is on the class, the reach on the method. Found by a failing test asserting the obvious. | A role-bearing declaration counts as reached when any of its own members is, at that member's depth, read from the frozen `sym:<path>#<chain>` identity. |
| **Wrapping an already-capped explorer list lost its true total.** The architecture tree reported 100 functions for a 400-function repository, and the role tree reported 100 tests where the repository has 177. | Added `mapListing`, which transforms entries while keeping `total` and `truncated`. Both trees now report true totals. |
| **The architecture response duplicated itself** — the explorer's `ArchitectureView` embedded alongside `architectureTree`, which carries the same declarations. 766 KB on this repository. | The explorer's grouping is used to build the trees and not re-emitted. Response dropped to **343 KB**. |
| **A route's environment variables covered only the immediate handlers**, so a handler delegating to a service reading `JWT_SECRET` reported none — inconsistent with `services` and `repositories` being reach-based. | Environment variables are now reach-based too. |
| **The same role→nodes mapping was written three times** across the route explanation, the architecture tree and the role tree. | One `roleGroupsOf` helper, written as a literal so a new role in the vocabulary is a compile error rather than a silently missing group. |
| **`@traceiq/health` and `@traceiq/impact` were declared as runtime dependencies but never imported.** | Removed. They are reused through the explorer, which is the correct direction. |

### Real Repository Validation — TraceIQ itself

| | Value |
|---|---|
| Largest package | `packages/explorer` — 13 files, **363 declarations** |
| Largest dependency graph | 518 nodes, 2,291 `IMPORTS`/`EXPORTS` edges |
| Largest route chain | **0** — TraceIQ registers no Express routes; the pipeline fixture covers a real 2-link chain |
| Largest middleware chain | 0, same reason |
| Largest architecture group | `Variable` — **414** declarations; then `Function` 321, `Method` 249, `Interface` 186, `Test` 177 |
| Largest dependency closure | `packages/explorer` — **112** nodes |
| Largest navigation tree | `packageTree` — 268 KB over 17 packages |
| Largest response | `architecture` — **343 KB** (was 766 KB before the duplication fix) |
| Cold `architecture` | **72.1 ms**, 2,703 graph reads, 215 explorer calls |
| Warm `architecture` | **5.45 ms** |
| `dependencies` | declaration 7.67 ms · file 1.87 ms · package 22.9 ms |
| Cross-package edges | **0** — every inter-package import resolves outside the analysed set |
| Determinism | byte-identical across calls and across instances |

### Files

Created: `packages/navigation/` — `types.ts`, `limitations.ts`, `navigation-context.ts`,
`route-explanation.ts`, `trees.ts`, `dependency-navigation.ts`, `repository-navigator.ts`,
`index.ts`, `fake-graph.test-helper.ts`, `repository-navigator.test.ts`, `pipeline.test.ts`,
`package.json`, `tsconfig.json`, `README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| One `CachingGraph`, with the explorer built over it | The database is read once for the whole layer and only one whole-graph index exists. |
| Impact Analysis and Repository Health reached through the explorer | Constructing them here would duplicate the cache and the index over one immutable revision. |
| A route is looked up, never trusted | Composing an identity is not evidence a route exists. An unregistered path yields `null` rather than an invented answer. |
| Prefix composition reported, never guessed | `effectivePath` equals the written path and `composed` is `false`, with a limitation naming it. |
| A role counts as reached through its members | Roles annotate containers; reach lands on whichever member is called. Requiring the container itself made the field silently empty. |
| Role reach follows coupling, not calls alone | A dependency wired by construction rather than an immediate call would otherwise be missed, and call coverage is itself partial. Stated as a limitation. |
| Trees carry `TreeRef`, not whole nodes | A tree is a navigation index; carrying every field would multiply a repository-wide tree into hundreds of kilobytes the caller has not asked for. |
| The explorer's grouping builds the trees and is not re-emitted | Embedding it would state the same declarations twice in one response. |
| A route subject covers its handlers | A route has no dependencies of its own — what it depends on is what its chain depends on. |
| A package subject covers its files | A package is a derived grouping rather than a node. |
| Merging, not re-walking | Shortest depth wins where two files reach the same node, and a shared cycle is reported once. |
| No timing in any response | Responses must be byte-identical for identical input. |

### Known Limitations

- **Route prefix composition is unsupported**, always reported.
- **A member-expression handler cannot be linked**, so a chain can be shorter than the code registers;
  the unlinked handlers are listed rather than omitted.
- **Role reach follows coupling**, and **roles are judgements**.
- **Call coverage is partial** with no interface or dynamic dispatch, so chains, closures and cycles are
  lower bounds.
- **The package boundary is derived from paths.**
- **Cross-package imports resolve outside the analysed set** on this repository, so `dependencyTree`
  reports zero cross-package edges.
- **Lists cap at 100**, with true totals alongside.
- **`architecture` is 343 KB**, dominated by `packageTree` over 1,993 declarations.

### Approvals Needed Before the Next Milestone

1. **Whether the scanner should read sibling workspace packages' sources**, or the Resolver map a
   workspace specifier to the in-repository package. Without one, `dependencyTree` and package
   dependencies are empty on every monorepo — now the most visible gap, since it is a headline field of
   this milestone.
2. **A `getNodesWithRole(role)` accessor on the Graph API.** Still the dominant cold-start cost.
3. **Whether the Framework Extractor should emit mount annotations**, which is the only way route prefix
   composition can ever work. Until then every route path is reported local.
4. **Whether a response-shape option belongs on the read layer** — identifiers instead of full nodes —
   to bring the largest responses down.
5. Carried forward and still open: four narrow Query Engine operations; a batch node accessor; moving
   `SourceRange` to `@traceiq/types`; a property or member-access relationship; interface dispatch as a
   relationship; a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this` chain; property-initializer
   construction tracking.

### Next Milestone

TraceIQ CLI.

## Repository Explorer

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,321 passing across 47 files (142 in this package).

### Completed Work

New `@traceiq/explorer`: `RepositoryExplorer` with ten navigation operations — `overview`,
`browseFile`, `browseSymbol`, `browsePackages`, `browsePackage`, `dependencies`, `architecture`,
`cycles`, `hotspots`, `search` — plus `profile` for measurement. This is the read layer every future
interface consumes.

**It reuses rather than reimplements.** Explain Symbol assembles a symbol and is carried **whole** on
`SymbolView.explain` rather than re-flattened. Impact Analysis supplies the dependents closure.
Repository Health supplies the whole-graph index, coupling metrics, components and algorithms. The
Query Engine supplies routes, references, callers and callees, and `parseRouteId` reads route
identity. The only traversal written here is the **forward** closure, which no existing capability
performs.

**One memoising graph adapter.** `CachingGraph` wraps the Graph API, and all four reused capabilities
are constructed over that one instance — so three capabilities reading the same node cost one read.
Caching is sound because every wrapped operation is a pure read of one immutable revision.

### Architectural decision requiring note

**The package unit is derived, and every response that uses it says so.** The graph records no package
boundary — the specification omits `Repository` and `Directory`, and `packageJsonPath` never reaches
the graph — so a package is the first two segments of a file path, one fixed rule with no hardcoded
directory names and no configuration. Chosen in answer to a question put before implementation.

No new infrastructure package was introduced, and no frozen package's responsibilities moved.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | Ten operations, one class, six runtime dependencies — exactly the allowed layers. |
| Correctness | **A NUL byte in a composite key silently broke package dependency detection.** See below. |
| Duplication | `mostCoupled` and `mostConnectedDeclarations` computed the **same measure**; they now count distinct neighbours and total relationships respectively. Dead code — `void` placeholders, unused re-exports and needlessly nested functions — removed from `views.ts`. |
| Performance | 40 ms cold for the first operation, then 0.06–2.34 ms. The whole graph is read once per instance, never once per operation. |
| Determinism | Byte-identical across repeated calls and across two explorers over one database. No timing in any response. |
| Documentation | README covers purpose, public API, architecture, navigation model, package unit, performance, examples, determinism, limitations and testing. |
| API consistency | Every list is a `Listing` with `total` and `truncated`; every "not that kind of thing" is `null`; every node carries its full `GraphNode` so any result navigates to any operation. |
| Code reuse | Verified by test: `browseSymbol` drives three capabilities and a second call adds zero graph reads. |
| Dead code | Removed as above. |
| Boundary violations | None. `better-sqlite3` absent from the runtime closure; no Project Host, Resolver or Graph Builder import. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **A literal NUL byte in five source lines**, from my own authoring. In `explorer-context.ts` the package key was built as `` `${from}\0${to}` `` and split on `' '`, so **every package dependency and dependent silently read zero**. The other four were opaque cache keys where NUL is harmless — but a NUL makes the file binary to `grep`, which is how it stayed invisible. | The composite string key is gone: `crossingEdges` is now a nested `from → to → edges` map, so there is nothing to encode or split. The remaining separators are written as the `\u0000` escape, keeping the files text while retaining a separator that cannot occur in a path. Verified no source file in the workspace contains a NUL. |
| **Two hotspot measures were identical.** `mostCoupled` and `mostConnectedDeclarations` both ordered by `fanIn + fanOut`. | `mostCoupled` counts distinct neighbours; `mostConnected*` counts total relationships. They now give genuinely different answers — the second surfaces files with many repeated relationships. |
| **Dead code in `views.ts`** — `void` placeholders, an unused re-export line, and section builders needlessly nested inside `overviewOf`. | Removed; the four summary builders are now top-level functions taking the health report. |
| **Package dependency zeros looked like a bug.** On TraceIQ every inter-package import resolves to `ext:outside-analysis`, because sibling packages resolve through `dist/` which the scanner excludes. | Added `cross-package-imports-resolve-outside-analysis` as a reported limitation carrying the count, so a zero reads as an explained fact. A fixture test proves the mechanism works when an import targets an in-repository declaration. |

### Real Repository Validation — TraceIQ itself

| | Value |
|---|---|
| Overview | 163 files, 1,993 declarations, 2,180 nodes, 8,328 edges |
| Packages | **16** derived, largest `packages/health` and `packages/explorer` at 308 and 320 declarations |
| Largest dependency graph | 518 nodes, 2,291 `IMPORTS`/`EXPORTS` edges |
| Largest call graph | 464 nodes, 1,808 `CALLS` edges, coverage 21.5% |
| Largest SCC | **2** nodes — the repository has no large tangle |
| Cycles | 16 call cycles (14 of them one-node), 0 import, 0 reference, 0 inheritance |
| Largest fan-in | **63** — `explorer/src/types.ts#Listing` |
| Largest fan-out | **13** — `explorer/src/search.ts#searchOf` |
| Most connected file | `graph/src/graph-builder.test.ts`, 25 relationships |
| Largest file | `health/src/graph-index.ts`, 43 declarations |
| Largest declaration | `health/src/graph-index.ts#GraphIndex`, fan-in 29 |
| Largest search result | `role: 'Test'` → 164 declarations; `path: 'packages/health'` → 308 |
| Largest explorer response | `architecture` 420 KB, `hotspots` 412 KB; `overview` 4.6 KB |
| Cold first operation | 40.4 ms, 2,078 Graph API calls |
| Every later operation | 0.06–2.34 ms |
| Determinism | byte-identical across calls and across instances |

### Files

Created: `packages/explorer/` — `types.ts`, `caching-graph.ts`, `explorer-context.ts`, `listing.ts`,
`views.ts`, `search.ts`, `limitations.ts`, `repository-explorer.ts`, `index.ts`,
`fake-graph.test-helper.ts`, `repository-explorer.test.ts`, `search.test.ts`, `pipeline.test.ts`,
`package.json`, `tsconfig.json`, `README.md`.

Modified: `packages/health/src/graph-index.ts` (two literal NUL bytes replaced by the `\u0000`
escape — no behaviour change, and a frozen package left textually greppable); root `README.md`,
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| One memoising Graph API adapter shared by every reused capability | Reuse would otherwise cost one full graph read per capability. Sound because every wrapped operation is a pure read of one immutable revision. |
| Reuse Repository Health's index and algorithms rather than writing a second copy | The alternative is duplicated traversal logic, which the milestone forbids and which would drift. |
| `SymbolView` carries the whole `ExplainSymbolResult` | Re-flattening it would duplicate assembly and let the two answers diverge. The explorer adds only what Explain Symbol does not: children, impact and health summaries, and the package. |
| Shared state is lazy and per-instance | An operation that needs no index pays for none; an instance is a snapshot of one revision, so repeated calls are identical by construction. |
| A composite key is a nested map, never an encoded string | The one encoded key in this package silently returned zeros for a whole section. Nested maps cannot be mis-split. |
| Every list is a `Listing` with `total` and `truncated` | A cap must never be silent, and one shape across every operation makes the API predictable. |
| `null` for the wrong kind of identifier | A hollow response would claim nothing is recorded when the truth is that this is not that kind of thing. |
| `profile` wraps rather than instruments | Keeps ten operations free of profiling concerns, and measures what reached the graph after caching rather than what was asked for. |
| No timing in any response | Elapsed time differs between runs; responses must be byte-identical. |
| Search is case-sensitive | Case folding is a second rule to get wrong, and the milestone asks for exact and prefix only. |
| An empty query matches nothing | Returning the whole repository for `{}` would be an accident, not a search. |

### Known Limitations

- **The package boundary is derived from paths**, not recorded.
- **Cross-package imports may resolve outside the analysed set**, so package dependency counts are
  zero on TraceIQ. Reported as a limitation with its count.
- **A call cycle may be false self-recursion** — the multi-link `this` chain defect, carried forward.
- **The connected component can span the repository**: 1,662 of 2,180 nodes here. It says what is
  reachable, not what is cohesive.
- **A file rarely has incoming relationships**, since `IMPORTS` targets declarations.
- **Lists cap at 100**, with the true total alongside.
- **`architecture` and `hotspots` responses are ~420 KB**, dominated by capped lists of full nodes.
- Everything inherited from below: partial call coverage, `INFERRED` calls, no interface or dynamic
  dispatch, no property or member-access relationship.

### Approvals Needed Before the Next Milestone

1. **A `getNodesWithRole(role)` accessor on the Graph API.** About 1,900 of the explorer's 2,078
   cold-start calls are `getRoles`, one per declaration. This is now the dominant cost of the read
   layer as well as of Repository Health.
2. **Whether the scanner should read sibling workspace packages' sources**, or the Resolver should map
   a workspace specifier to the in-repository package. Without one of these, no monorepo can report
   package-to-package dependencies — the single largest gap in the explorer's output.
3. **Whether a response-shape option belongs on the explorer** — for example returning identifiers
   instead of full nodes — to bring `architecture` and `hotspots` below ~420 KB. It would make the API
   larger, so it is not done unilaterally.
4. **Four narrow Query Engine operations**, carried forward and still open.
5. **A batch node accessor on the Graph API**, carried forward.
6. **Moving `SourceRange` to `@traceiq/types`**, carried forward — `ts-morph` remains in the runtime
   closure of every graph reader, including this one.
7. **A property or member-access relationship**, carried forward.
8. **Interface dispatch as a graph relationship**, carried forward.
9. Carried forward: a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this` chain — which is what
   produces the false self-recursion above — and whether property-initializer constructions should be
   tracked.

### Next Milestone

Repository Navigation.

## Repository Health

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,179 passing across 44 files (131 in this package).

### Completed Work

New `@traceiq/health`: `new RepositoryHealthAnalyzer(graphApi).analyze()` →
`RepositoryHealthReport`. One method, no arguments. Ten sections — summary, architecture,
dependency health, call graph health, routing, environment, findings, metrics, limitations and
analysis statistics — every one derived from the graph as it stands.

**One pass over the graph.** `buildGraphIndex` is the only code that touches it: `getNodes` per node
kind, `getEdges` per relationship type, `getRoles` per declaration, `getUnresolved` once. Everything
after is a function of that index plus a `Derived` bundle of shared values, so no section can
re-traverse. Graph API calls are `16 + 13 + 1 + declarations` — fixed in the vocabularies and linear
in declarations, never in edges or findings.

**No Query Engine operation was added, and no existing module changed.**

### Architectural decision requiring note

**Health reads the Graph API, not the Query Engine.** It is the one capability that must read the
*whole* graph — a count of classes, a fan-in distribution and a dependency cycle are statements about
every node and every edge — and no Query Engine operation enumerates. The Graph API is the abstract
read model, explicitly designed so a reader depends on it without SQLite entering its dependency
tree, and it is not in the milestone's forbidden list. Consumed through a four-operation
`HealthGraph` interface. `@traceiq/query` is used for exactly one thing: `parseRouteId`.

No new infrastructure package was introduced. `graph-algorithms.ts` stays local because nothing else
in the workspace needs strongly connected components today.

### Self Review

| Criterion | Finding |
|---|---|
| Correctness | **Two defects found by running against TraceIQ itself** — see below. |
| Architecture | One package, one class, one method; four-operation consumed interface. |
| Determinism | Identifier-ordered reads, documented sorts with identifier tiebreaks, no timing in the report. Byte-identical across runs. |
| Duplicate work | `Derived` exists for this: call components, coupling metrics, module dependency graph and call depth each had two consumers and were being computed twice. Fixed during implementation. |
| Repeated traversals | None after the index. Asserted by a call-counting fake. |
| API simplicity | `analyze()`. No options, no thresholds to configure. |
| Unnecessary abstractions | `metricOf` was duplicated between `sections.ts` and `derived.ts`; removed. |
| Documentation | README covers architecture notes, analysis strategy, category descriptions, metric definitions, cycle handling, duplicate elimination, complexity and limitations. |
| Naming | `REFERENCE_TYPES` names the containment exclusion rather than hiding it in a filter. |
| Test quality | 131 tests: algorithms directly, sections against a known-shape graph, stress, determinism, five unusual repositories, and a pipeline test over a deliberately unhealthy fixture. |
| Edge cases | Empty repository, single file, all-isolated, pure cycle, file with no declarations — all covered, all returning zeroes rather than `NaN`. |
| Cycle handling | Iterative Tarjan; 50,000-node stress tests. |
| Performance | ~37 ms on this repository. The one inefficiency is `getRoles` — see below. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **Containment counted as a reference.** `DECLARES` was in the coupling index, so every member had an incoming edge from its own container: `isolated` was 0, `withoutIncoming` was 0 and `fanIn.min` was 1 across the entire repository — nothing could ever read as unreferenced. Every file's fan-out was also inflated by its declaration count. Found by running against TraceIQ and disbelieving the numbers, not by a test. | Added `REFERENCE_TYPES`, excluding `DECLARES` from coupling and from every reference-based finding while keeping it in the relationship totals. `isolated` went 0 → 464, `fanIn.min` 1 → 0, `fanOut.max` 22 → 13. |
| **Findings carried uncapped node lists**, making the report 1.5 MB — one finding held 1,058 nodes. | Capped at `SAMPLE_LIMIT` with `nodeCount` and `truncated` alongside, so the cap is never silent. Report is now 438 KB. |
| **Unreferenced counts were misleading without a caveat.** 1,079 of 1,685 declarations have no incoming reference, dominated by the 689 `Property` nodes — no relationship records a property or member access, so a property can *never* appear referenced. | Added the `property-references-not-recorded` limitation, carrying the count of unreferenced properties. |
| **`metricOf` and the SCC computation were duplicated** across `sections.ts` and `findings.ts`. | Consolidated into `derived.ts`, computed once. |

### Real Repository Validation — TraceIQ itself

| | Value |
|---|---|
| Execution time | **~37 ms** |
| Graph API calls | 1,715 — of which 1,685 are `getRoles`, one per declaration |
| Graph size | 1,864 nodes, 7,254 edges, 6,969 unresolved references |
| Files / declarations | 155 / 1,685 |
| Declaration kinds | 689 Property, 335 Variable, 231 Function, 182 Method, 135 Interface, 46 TypeAlias, 37 Class, 24 Constructor, 6 Accessor |
| Relationships | `CALLS` 1,808, `IMPORTS` 1,704, `DECLARES` 1,685, `REFERENCES_TYPE` 1,454, `EXPORTS` 587, `EXTENDS` 11, `IMPLEMENTS` 5 |
| Call graph | 464 nodes, 1,808 edges, **coverage 20.6%**, 115 entry points, max depth 4 |
| Call clusters | 41 components, largest 65, 2 singletons |
| Cycles | 6 — four self-recursive functions and two mutual pairs, 8 declarations in total |
| Largest fan-in | 29 — `health/src/graph-index.ts#GraphIndex` |
| Largest fan-out | 13 — `RepositoryHealthAnalyzer.analyze` and a test fixture |
| Most coupled file | `health/src/index.ts`, fan-out 45 |
| Isolated declarations | 464 |
| No incoming reference | 1,079 — dominated by 689 properties, which cannot be referenced in this model |
| Metrics | 10.87 declarations per file, 2.00 references per declaration, density 0.0021, reference coverage 51% |
| Externals | 7 npm, 12 TypeScript built-ins, 4 Node builtins; `vitest` imported by 45 files |
| Determinism | byte-identical across runs; report 438 KB |

The largest connected call cluster covering 65 of 464 call-graph nodes, against 41 components,
matches a workspace of independent packages joined by a shared core.

### Files

Created: `packages/health/` — `types.ts`, `graph-index.ts`, `graph-algorithms.ts`, `derived.ts`,
`sections.ts`, `findings.ts`, `limitations.ts`, `statistics.ts`, `repository-health-analyzer.ts`,
`index.ts`, `fake-graph.test-helper.ts`, `graph-algorithms.test.ts`,
`repository-health-analyzer.test.ts`, `pipeline.test.ts`, `package.json`, `tsconfig.json`,
`README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| Reads the Graph API rather than the Query Engine | No Query Engine operation enumerates nodes or edges, and health is a statement about all of them. The Graph API is the read abstraction and carries no storage concept. |
| One index, then pure computation | Makes re-traversal impossible rather than merely discouraged, and gives every section one consistent snapshot. |
| Containment excluded from coupling | A class declaring a method is not a reference to it. Including it made every declaration look referenced. |
| No overall health score | A single number would be a judgement dressed as a measurement, and the milestone forbids scoring. |
| "High" fan-in is the repository's own p90 | A fixed threshold would be a guess. A percentile of the measured distribution is a fact, and a uniformly connected repository correctly produces no such findings. |
| `maxCallDepth` is shortest-from-a-root, maximised | Longest path is not polynomial on a cyclic graph. A metric that cannot be computed exactly should not be reported as if it were. |
| Percentiles use nearest-rank | Every reported figure is a value that actually occurs, rather than an interpolation between two. |
| Module dependency graph is projected through `fileId` | `IMPORTS` targets declarations, so file cycles are almost never `File → File` edges. The projection recovers the graph engineers mean without inventing a relationship. |
| A finding's confidence is the weakest observed among the relationship types it rests on | A finding about calls can be no stronger than the call graph. Nothing is aggregated per edge, which the graph specification forbids. |
| Aggregated findings for many comparable nodes, per-occurrence for specific ones | A thousand "never referenced" findings would bury the report; one cycle per finding is exactly right. |
| `statistics` carries no timing | Elapsed time differs between runs and the report must be byte-identical. Timing is measured around `analyze`. |
| Iterative Tarjan | A health analyser meets the worst case; recursion would overflow on a deep chain. Stress-tested at 50,000 nodes. |

### Known Limitations

- **A reference absence is not proof of disuse** — dynamic access, framework entry points and
  unresolved references all leave no edge.
- **No property or member-access relationship exists**, so a property can never appear referenced.
  689 property nodes dominate any unreferenced count on this repository.
- **Call coverage is 20.6%** and every `CALLS` edge is `INFERRED`, so every call-graph figure is a
  lower bound; clusters and depth understate how the code connects.
- **Duplicate route identities collapse**; a duplicate is visible only as two handler edges at one
  position.
- **Module-level calls are attributed to files**, so files appear among callers.
- **No history**, so no trend can be reported.
- **`getRoles` is called once per declaration** — 1,685 of 1,715 Graph API calls — for want of a role
  index.

### Approvals Needed Before the Next Milestone

1. **A `getNodesWithRole(role)` accessor on the Graph API.** 1,685 of 1,715 calls in a health run are
   `getRoles`, to find 150 annotations. This is now the dominant cost of two capabilities — health
   and the Query Engine's `findByRole` — and is the clearest remaining performance item.
2. **Four narrow Query Engine operations**, carried forward and still open: `findRoutesFor(id)`,
   `findEnvironmentVariablesFor(id)`, `findDependenciesFor(fileId)` and `findUnresolvedFor(id)`, the
   last needing an optional source filter on `getUnresolved()`. Worth ~48 ms per Explain Symbol and
   per Impact Analysis call.
3. **Whether a batch node accessor belongs on the Graph API.**
4. **Whether `SourceRange` should move from `@traceiq/ir` to `@traceiq/types`**, removing `ts-morph`
   from the runtime closure of every graph reader.
5. **Whether a property or member-access relationship should be recorded.** Without one, 689 of this
   repository's declarations can never appear referenced, which limits health, impact and explain
   alike. The IR already records `memberAccesses`; nothing turns them into edges.
6. **Whether interface dispatch should become a graph relationship**, carried forward.
7. Carried forward: a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this` chain, and whether
   property-initializer constructions should be tracked.

### Next Milestone

Repository Explorer.

## Impact Analysis

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,048 passing across 41 files (80 in this package).

### Completed Work

New `@traceiq/impact`: `new ImpactAnalyzer(queryEngine).analyze(id)` →
`ImpactAnalysisResult | null`. Every requested field is present — target, directly and
indirectly affected, callers, callees, type references, imports, routes affected, environment
variables, external dependencies, unresolved relationships, confidence, provenance, known
limitations — plus `statistics`, so a caller can see the shape and cost of the closure it got.

**No Query Engine operation was added.** The traversal is one breadth-first walk along incoming
edges using `findReferences` as the only primitive, which covers `CALLS`, `REFERENCES_TYPE`,
`IMPORTS`, `EXPORTS`, `EXTENDS`, `IMPLEMENTS` and `HANDLED_BY` in one call per node. The four
whole-collection queries are issued **once each** however large the closure grows, and
`findRoutes` only when the walk actually passed a `HANDLED_BY` edge.

**Direction.** The closure follows dependents. Callees are reported at depth 1 and never
expanded: a callee does not break when the target changes, so its own callees are not affected.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | One package, one class, one method. Runtime deps are `query`, `graph-api`, `types`. |
| Traversal correctness | Asserted against a fixture with a known closure — five nodes at depth 1, three at depth 2, one at depth 3. Inheritance and re-export propagation were **missing from the tests and were added** during review. |
| Duplicate paths | Eliminated per node at shortest depth; edge-level fields keep every edge. Asserted. |
| Cycle handling | Self-call, two-node cycle and import cycle all terminate; a node joins `visited` on discovery. Asserted. |
| Deterministic ordering | Breadth-first FIFO, nothing sorted. 100 declarations analysed twice: 100 byte-identical. |
| Explainability | Every affected node carries the edge that reached it, and `via.targetId` walks the path back to the target without storing paths. |
| Performance | ~43 ms per analysis, of which the traversal is under 1 ms. Itemised below. |
| API simplicity | `analyze(id)`. The consumed surface is an explicit seven-operation interface. |
| Documentation | README covers traversal strategy, why DIRECT, why INDIRECT, why UNKNOWN, cycle handling and duplicate elimination, as specified. |
| Missing tests | Inheritance (`EXTENDS`/`IMPLEMENTS`) and re-export (`EXPORTS`) propagation were absent. Added, four tests. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **`UNKNOWN` was dominated by irrelevant noise.** Analysing `QueryEngine` produced 522 unresolved entries against a 7-node closure: a file joins the closure by importing the target and then contributes every unbound top-level call in it, which on a test-heavy repository is hundreds of `expect(...)` calls. Found by measuring against the real repository, not by the tests. | Added `scope: 'declaration' \| 'file'` to every entry, so the 6 that matter are separable from the 71 that do not, and a `file-level-unresolved-dominates` limitation that fires when files outnumber declarations. Nothing is dropped and no heuristic is applied. |
| **The genuinely important `UNKNOWN` fact was missing entirely.** Unresolved references *elsewhere* in the repository could each have been an edge into the closure had they bound — that is what makes the affected set possibly incomplete — and nothing reported it. | Added `closure-may-miss-hidden-dependents`, carrying the repository-wide count. It cannot be attributed to a target without guessing, so it is a count rather than entries. |
| **`filesOf` was computed twice** and the file set was rebuilt inside `#externalDependencies`. | Computed once in `analyze` and passed to both consumers. |

### Measured on this repository

| | Value |
|---|---|
| Per `analyze` | ~43 ms, ~6,220 Graph API calls |
| `findUnresolved` share | 5,291 `getNode` calls, ~42 ms |
| `findDependencies` share | ~833 calls, ~7 ms |
| Closure traversal | 1 `findReferences` per node; under 1 ms |
| Closure size over 200 declarations | min 1, median 3, max 19–30 |
| Determinism | 100 analysed twice, 100 identical |

Example — `AuthService.verify` three deep: DIRECT 10, INDIRECT 5, depths {1: 10, 2: 4, 3: 1}.

### Files

Created: `packages/impact/` — `types.ts`, `limitations.ts`, `dependents-closure.ts`,
`impact-analyzer.ts`, `index.ts`, `fake-queries.test-helper.ts`, `impact-analyzer.test.ts`,
`pipeline.test.ts`, `package.json`, `tsconfig.json`, `README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

**No existing module changed.** No Query Engine operation was added, and no completed milestone
was touched.

### Decisions

| Decision | Reason |
|---|---|
| The closure follows dependents only | A caller breaks when the target changes; a callee does not. Expanding callees would fill the result with declarations a change cannot reach. Callees are still reported at depth 1, as an edge list rather than as affected nodes, so the two ideas are not merged. |
| `findReferences` is the only traversal primitive | It returns every incoming edge except `DECLARES`, so one call per node covers all seven propagating relationship types. Asking per-type would multiply queries for the same rows. |
| A `File` is expanded like a declaration | A module-level call is attributed to its file, so a file really does depend on what those calls reach. Stopping at files would silently lose every top-level invocation's impact. Reported as the `file-level-attribution` limitation, since it is coarse. |
| A `Route` is diverted, never expanded | Nothing references a route, so expanding one always finds nothing, and the category vocabulary puts every route reaching the declaration in `INDIRECT`. Keeping routes out of the affected-declaration lists is what stops the categories merging. |
| `DECLARES` is not traversed | A class does not depend on its own member, so changing a method should not report its class as affected. Containment is a different question, answered by `findEnclosingDeclaration`. |
| Depth is the shortest distance | Breadth-first gives it for free, and it is the only non-arbitrary choice when several paths reach a node. |
| Duplicates eliminated per node, kept per edge | One affected node with the first edge that reached it; but "where are the call sites" needs every edge, so the edge-level fields keep them all. |
| No confidence is aggregated along a path | The graph specification forbids recomputing confidence. Each edge carries its own, and the result carries the target's — combining them would invent a fact. |
| `via` instead of a stored path | `via.targetId` is the node it was reached through, so a path back to the target is walkable at zero storage cost and with no risk of a stale copy. |
| Its own limitation vocabulary, not shared with `@traceiq/explain` | The two report different things. One table serving both would grow codes that only ever apply to one, and coupling two capabilities to make nine strings shared is the wrong trade. |
| No Query Engine operation added | The traversal needs none: `findReferences` suffices, and the whole-collection queries are reused rather than repeated. The 43 ms is inside the Query Engine, not in repeated traversal. |

### Known Limitations

- **No interface or dynamic dispatch.** An interface method with three implementations yields no
  edge to any of them, so changing the interface method does not report them. The largest
  correctness boundary, and no traversal can fix it — reported as a limitation on every result.
- **~43 ms per analysis**, dominated by two Query Engine operations that hydrate the whole
  repository before this package scopes them.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED`, so the closure can be
  narrower than the code.
- **No signature awareness.** Every dependent is reported for any change; the graph records no
  parameter or return type, so "this change is source-compatible" cannot be expressed.
- **Files are affected as a whole**, even when one top-level statement depends on the target.
- **`externalDependencies` is file-scoped.**
- **Containment is not followed**, deliberately.
- **Route prefixes are not composed.**

### Approvals Needed Before the Next Milestone

1. **Four narrow Query Engine operations** — re-raised, and now the more pressing of the two
   capabilities, since impact analysis is the natural thing to run over many declarations.
   `findRoutesFor(id)`, `findEnvironmentVariablesFor(id)`, `findDependenciesFor(fileId)` — all
   already supported by the Graph API — and `findUnresolvedFor(id)`, which additionally needs an
   optional source filter on `getUnresolved()`. Takes one analysis from ~43 ms to about 1 ms.
2. **Whether a batch node accessor belongs on the Graph API.** One `getNode` per edge is what
   makes `findUnresolved` cost 5,291 reads.
3. **Whether `SourceRange` should move from `@traceiq/ir` to `@traceiq/types`**, removing
   `ts-morph` from the runtime closure of every graph reader.
4. **Whether interface dispatch should become a graph relationship.** Today an interface method
   call produces no edge, so impact analysis cannot report implementations. Recording candidate
   implementations — as an `AMBIGUOUS` candidate group, which the vocabulary already supports —
   would be the single largest improvement to impact accuracy. It is a Resolver change and well
   outside this milestone.
5. Carried forward, still open: a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this`
   chain, and whether property-initializer constructions should be tracked.

### Next Milestone

Repository Health.

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

Impact Analysis.

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
