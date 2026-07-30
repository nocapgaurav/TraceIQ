# @traceiq/web

The TraceIQ web application. Seven pages over the REST API.

```
TRACEIQ_DB=.traceiq/graph.db node apps/api/bin/traceiq-api.js   # the API, on :3000
pnpm --filter @traceiq/web dev                                  # the app, on :3001
```

| Page | Route | What it answers |
|---|---|---|
| Dashboard | `/` | what is in this repository, and how healthy is it |
| Explorer | `/explorer` | browse packages → files → declarations |
| Symbol | `/symbol?id=…` | everything the graph knows about one declaration |
| Impact | `/impact?id=…` | what a change to one declaration reaches |
| Architecture | `/architecture` | the package dependency graph and the trees behind it |
| Health | `/health` | metrics, findings, cycles, hotspots |
| Search | `/search?q=…` | exact and prefix search across the graph |

## Architecture

**The frontend is a REST client and nothing more.** It imports no `@traceiq/*` package, and there is no
alias, `transpilePackages` entry or path mapping that would let it: the only contract between the two
halves of the repository is the HTTP surface.

```
page  →  hook (TanStack Query)  →  service  →  api-client  →  fetch  →  /api/…  →  REST API
```

Each layer has exactly one job, and the boundaries are the point:

| Layer | Owns | Never does |
|---|---|---|
| `src/app/*/page.tsx` | which facts a page shows | build a URL, call `fetch`, decide when to refetch |
| `src/hooks/queries.ts` | caching, retries, query keys | know a path |
| `src/services/` | every URL in the application | hold state, cache, or render |
| `src/services/api-client.ts` | the envelope, the error shape, identifier encoding | know an endpoint |
| `src/store/ui-store.ts` | theme, selection, panel sizes | hold repository data |
| `src/lib/` | pure functions — formatting, links, graph layout | fetch anything |
| `src/types/api.ts` | the wire format, hand-written | import a backend type |

**No business logic in a component.** The one place that could have drifted is graph drawing, so it did
not: `src/lib/graph-models.ts` turns an API payload into a `Layout` as a pure function, and `GraphCanvas`
renders whatever it is handed. That is why the layout has unit tests and no test needs React Flow mounted.

### Why requests go to `/api`

The API sends no `Access-Control-Allow-Origin` header — reasonably, since it was built for the CLI and for
server-side consumers. A browser therefore refuses every cross-origin request to it *before sending one*,
and the whole app fails with `net::ERR_FAILED`. Since the API is frozen, the frontend calls `/api/…` on its
own origin and `next.config.mjs` rewrites that to the upstream host. Only the host changes: path, query
string and method pass through untouched, so the browser and the CLI see the same REST surface.

Set `TRACEIQ_API_URL` to point elsewhere. It is read **on the server at request time**, not inlined into
the bundle, so one build can be pointed at any host.

### Identifiers in URLs

A `sym:` identifier contains both `/` and `#`. As a path segment the `#` would be read as a fragment and
dropped before the server saw it, so an identifier travels as a **query parameter**
(`/symbol?id=sym%3A…%23…`) and is percent-encoded again on the way to the API as `%23`. Both halves have
tests, because a silent truncation here produces a 404 that looks like a missing symbol.

## Types

`src/types/api.ts` is hand-written and deliberately a **projection** of the wire format, not a mirror of
it: each interface declares the fields this UI reads and nothing more, so the API growing a field needs no
change here. It was checked against a live API response for every endpoint before being written down.

## What the UI refuses to do

The backend's discipline is the frontend's discipline. Every number on every page came from a payload
unchanged; nothing is computed, inferred, ranked or scored here.

- **A cap is never silent.** `Listing` carries an exact `total` alongside possibly-shortened `entries`, and
  every capped list in the UI shows what was left out.
- **Limitations are shown, not hidden.** Each page renders the capability's own limitation codes in the
  server's own words. A result that hides what the analysis could not see reads as more complete than it is.
- **DIRECT, INDIRECT and UNKNOWN stay apart.** UNKNOWN is displayed as its own figure, with the words
  "UNKNOWN is not the absence of impact".
- **No numeric confidence.** The graph holds a four-level vocabulary and no score, so none is shown.
  `CERTAIN` is left unlabelled; the other three are badged.
- **An unresolved edge stays visible.** Where the API returns a `null` source or target, the row is kept and
  labelled rather than dropped — hiding it would understate the true count.
- **A hotspot list shows all four figures.** Each list is ordered by its own criterion, so displaying one
  column would silently claim that column was the ordering. Fan-in, fan-out and both edge counts are shown.
- **No AI, no chat, no markdown, no prompts.** There is no text input that sends anything anywhere except
  the two search boxes, both of which call `GET /search`.

## Monaco

Monaco is in the approved stack, but **the REST API exposes no file contents** — no endpoint returns source
text, and the backend deliberately never serves it. Rather than add an endpoint to a frozen backend, Monaco
is used for what the API does support: a read-only inspector for the exact JSON payload a page was rendered
from, with folding, search and structural navigation. Every page with data has a **Payload** tab, which
makes the UI auditable against the response that produced it.

Monaco's assets are fetched at runtime by `@monaco-editor/react`. If they do not arrive within eight
seconds the panel falls back to plain text, so a payload is never unreachable because a large asset was
blocked.

## Dark mode

Every colour is a token in `globals.css`, redefined under `.dark`. A component names an intent (`bg-card`,
`text-muted-foreground`) and never a literal colour, so the theme is one class on `<html>` rather than a
`dark:` variant on every element. An inline script in the document head applies the stored theme before
first paint — without it a dark-mode user sees a white flash on every load.

## Keyboard

`⌘K` / `Ctrl+K` opens the command palette from anywhere: sections are always listed, typing searches the
repository, arrows move, `Enter` opens, `Escape` closes. Beyond it, a skip link is the first focusable
element on every page, every list row is a real button, every tab strip is a Radix `tablist` with arrow-key
movement, and the Explorer's dividers are resizable from the keyboard because `react-resizable-panels`
gives its handles a role and arrow handling.

## Responsive

The Explorer's three-pane split becomes three stacked cards below `lg`; the header's nav becomes a
disclosure panel below `md`. Both are the same component tree in a different arrangement, so there is no
second navigation to keep in step. Wide content — tables, graphs — scrolls inside its own container, so the
page body never scrolls sideways.

## Performance

Measured against a real graph of TraceIQ itself (228 files, 3,148 declarations, 12,911 edges), warm.

| Page | Requests | Payload | Slowest request |
|---|---|---|---|
| Search | 1 | 16 KB | 2 ms |
| Symbol | 1 | 197 KB | 6 ms |
| Explorer | 3 | 366 KB | 4 ms |
| Dashboard | 3 | 403 KB | 8 ms |
| Architecture | 2 | 443 KB | 27 ms |
| Health | 3 | 981 KB | 19 ms |
| Impact | 2 | 2,024 KB | 18 ms |

**A graph is one immutable revision until the next scan**, so `staleTime` is `Infinity` and
`refetchOnWindowFocus` is off. Nothing is ever refetched without a reason, and returning to a page is
instant. A 4xx is not retried either — the identifier is wrong, and asking again gives the same answer.

First-load JS is 103 KB shared plus 2–14 KB per page. React Flow (≈65 KB) is only on the two pages that
draw a graph; Monaco is loaded on demand and is in no page's initial bundle.

The **Impact** payload at 2 MB is the one number worth watching. It is the API's, not the UI's: the analysis
carries every affected node with its full `GraphNode`. The graph is capped at 60 nodes for legibility, and
the cap is reported.

## Build configuration

Three deviations from a default Next 15 app, each forced and each documented in `next.config.mjs`:

1. **`next.config.mjs`, not `.ts`** — Next loads a TypeScript config through the workspace's `typescript`
   package, and TypeScript 7's API is not one it understands. The `.ts` config failed with
   `Cannot read properties of undefined (reading 'fileExists')`.
2. **`typescript@^6` pinned in this package only** — Next 15.5 refuses to build against TypeScript 7 at
   all: *"The TypeScript 7 native compiler does not provide the JavaScript compiler API that Next.js
   requires."* The rest of the repository stays on TypeScript 7; pnpm's isolation makes this a local
   choice, and no backend package is affected. The alternative was Next 16, which the milestone did not
   specify.
3. **The `@/…` alias is declared in `next.config.mjs` as well as `tsconfig.json`** — Next reads `paths` out
   of the tsconfig using that same incompatible loader, so on TypeScript 7 the alias never reaches the
   bundler and every import fails to resolve. `tsc` and the editor still read the tsconfig copy.

`typescript: { ignoreBuildErrors: true }` and `eslint: { ignoreDuringBuilds: true }` are set because both
steps drive TypeScript through the loader above and cannot run here. **Types are still checked**, by
`pnpm typecheck` (`tsc --noEmit` under `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`), which is a separate script and must pass.

## Testing

```
pnpm --filter @traceiq/web test        # 170 tests
pnpm --filter @traceiq/web typecheck
pnpm --filter @traceiq/web build
pnpm test                              # backend, then web
```

**Only `fetch` is stubbed.** `src/test/harness.tsx` answers requests from a fixed table and everything
above it — client, services, hooks, components — is the production code path. That makes the page suites
integration tests: they prove a page reads the fields the API actually sends, which a component test with
hand-passed props cannot catch.

`src/test/fixtures.ts` is hand-built rather than recorded, so each test states its case — a truncated
listing, an unresolved edge, a node in a cycle. The shapes were verified against a live API first.

Assertions are on the **accessible tree** (`getByRole`, `aria-selected`, `aria-current`, `alert`, `status`)
rather than on class names, so they describe behaviour a user can observe and survive restyling.

React Flow cannot lay out in jsdom, which measures every element as zero-sized. The layout is therefore a
pure function with its own unit tests, and the canvas tests cover the contract around it. The pictures
themselves were verified in a real browser.

## Layout of the source

```
src/app/                one directory per route, plus layout, providers, error and not-found
src/components/ui/      shadcn/ui primitives, copy-in over Radix
src/components/layout/  shell, nav, theme toggle, command palette, error boundary
src/components/domain/  states, node pills, charts, trees, graph canvas, JSON inspector
src/hooks/              TanStack Query hooks, theme, debounce
src/services/           api-client and one function per endpoint
src/store/              the Zustand UI store
src/lib/                cn, formatting, routes, graph layout and models, theme
src/types/              the hand-written wire format
src/test/               setup, fixtures, harness
```

## Known limitations

- **No source code is displayed**, because the API serves none. Monaco shows payloads instead.
- **Package dependency edges are usually absent** in a pnpm workspace: a sibling import resolves through
  built output rather than a source file, so the scanner records it as an external package. The Architecture
  graph says so on the graph itself rather than drawing unexplained loose boxes.
- **No dedicated Route page.** TraceIQ itself registers no HTTP route, so the routing views are exercised
  only by fixtures and by an empty state. The Symbol and Impact pages render a declaration's routes when a
  repository has them, and the Health page reports routing metrics; `GET /route` is wired in the service
  and hook layers but no page consumes it yet.
- **`POST /scan` is not exposed in the UI.** Scanning is a long, write-shaped operation; the app tells you
  to run `traceiq scan` and shows the API's own hint. A scan button would need progress reporting the API
  does not offer.
- **Graphs are capped at 60 nodes.** Beyond that the picture stops being readable. The cap and the true
  total are always shown.
- **Search is exact or prefix only**, matching the API. No fuzzy matching and no ranking, by design.
