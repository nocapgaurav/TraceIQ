# @traceiq/api

The HTTP interface to TraceIQ. Scan a repository, then query it over REST.

```
POST /scan   { "repository": "/path/to/repo" }
GET  /overview
GET  /symbol/sym:src/auth/user.service.ts%23UserService.login
```

## Architecture

**The API contains zero repository intelligence.** Each endpoint validates its parameters, calls one
capability and returns that capability's result **unchanged**. Nothing here traverses, resolves,
assembles or interprets, and no endpoint reshapes a payload — doing so would be inventing information.

```
HTTP → middleware → endpoint table → capability → graph
```

```
apps/api
  → @traceiq/pipeline      scan (build + store) · open → RepositoryGraphApi
  → @traceiq/navigation    routes · architecture trees · dependency navigation
  → @traceiq/explorer      overview · packages · files · symbols · search · cycles · hotspots
  → @traceiq/impact        full impact analysis
  → @traceiq/health        full health report
  → express
```

It never imports the scanner, project host, IR, resolver, framework extractor, graph builder, graph
store, SQLite or ts-morph. To be precise rather than to overclaim: `better-sqlite3` and `ts-morph` are
installed transitively through `@traceiq/pipeline` and must be — something has to read the source and
open the database. What holds is that no SQLite or compiler concept reaches API code: it names no
connection, statement, driver or compiler type.

**No decorators, no dependency injection framework, no ORM.** The endpoint table is a plain array; the
app is a function that takes its dependencies as arguments.

### One table, three uses

`ENDPOINTS` is the single source of truth for routing, validation and the OpenAPI document. Adding an
endpoint there registers the route, documents it and declares which errors it can return — so the
document cannot drift from the server.

### The graph, and why no locking is needed

`GraphHolder` owns the one piece of mutable state: which graph is open. It lives on the instance
`createApp` returns, never at module scope, so two apps in one process cannot see each other's graph.

Every read capability is **synchronous**, so a request never yields between taking the graph and
finishing with it — no `await` sits between the two. Only a scan is asynchronous, and it swaps the graph
in a single synchronous step once the new one is written. An in-flight read therefore cannot have its
session closed underneath it, and no mutex, queue or reference count is required to guarantee that.

## Request lifecycle

1. **Identity, version, timing** — sets `x-request-id`, `x-traceiq-version`, and `x-response-time` just
   before the body is written.
2. **JSON body parsing**, limited to 64 KB. A malformed body becomes a `bad-request` with the same
   shape as every other error.
3. **`/openapi.json`**, generated from the endpoint table.
4. **The endpoint**, which validates, delegates and wraps.
5. **Fallthrough** — a known path under an unsupported method is a `405`, anything else a `404`.
6. **The error handler**, which gives everything one shape.

**Observability lives in headers; determinism lives in the body.** A request identifier and an elapsed
time both vary between otherwise identical requests, and a body that varies cannot be compared, cached
or snapshot-tested. So they are headers, and the body is byte-identical for identical input.

## Response model

```json
{
  "success": true,
  "data": { "…": "the capability result, unchanged" },
  "meta": { "endpoint": "/symbol/{id}", "capability": "explorer+explain+impact+health", "graphApiCalls": 3059 }
}
```

```json
{
  "success": false,
  "error": { "code": "unknown-identifier", "detail": "the graph holds nothing named '…'", "hint": "use GET /search?q= to find an identifier" },
  "meta": { "endpoint": "GET /symbol/…", "capability": "api", "graphApiCalls": 3059 }
}
```

Every field of `meta` is deterministic. `capability` names the package that produced the payload;
`graphApiCalls` is how many reads have reached the database since the graph was opened.

## Endpoint reference

| Method | Path | Capability |
|---|---|---|
| `GET` | `/ping` | Liveness. Opens no graph |
| `GET` | `/version` | API version and whether a graph exists |
| `POST` | `/scan` | Build and store the graph. `201` |
| `GET` | `/overview` | explorer |
| `GET` | `/architecture` | navigation |
| `GET` | `/packages` | explorer |
| `GET` | `/packages/{name}` | explorer |
| `GET` | `/files/{path}` | explorer |
| `GET` | `/symbol/{id}` | explorer + explain + impact + health |
| `GET` | `/impact/{id}` | impact |
| `GET` | `/routes` | navigation |
| `GET` | `/route?method=&path=` | navigation |
| `GET` | `/health` | health — **not** a liveness check, see `/ping` |
| `GET` | `/search?q=&kind=&path=&match=` | explorer |
| `GET` | `/dependencies/{id}` | navigation |
| `GET` | `/cycles` | explorer |
| `GET` | `/hotspots` | explorer |
| `GET` | `/openapi.json` | The generated specification |

### Identifiers in a URL

`{name}`, `{path}` and `{id}` may contain **slashes**, which are sent as-is — the routes use wildcards
rather than requiring `%2F`.

A declaration identifier also contains a **`#`**, which starts a URL fragment. It **must** be
percent-encoded as `%23`, or the client strips everything after it before the request is sent:

```
GET /symbol/sym:src/svc.ts%23Service.run    correct
GET /symbol/sym:src/svc.ts#Service.run      the server receives 'sym:src/svc.ts'
```

Sending it unencoded returns `400 invalid-identifier` naming this fix, rather than a puzzling `404`.

### Errors

| Status | Codes |
|---|---|
| `400` | `bad-request`, `missing-parameter`, `invalid-identifier`, `invalid-package-name` |
| `404` | `not-found`, `unknown-identifier`, `unknown-route`, `unknown-package` |
| `405` | `method-not-allowed` |
| `409` | `repository-not-scanned` |
| `422` | `invalid-repository` |

`409` rather than `404` for a missing graph: the request was fine, the server has nothing to answer
from yet — a client can tell "scan first" from "that symbol is not there".

## Examples

```
$ curl -s localhost:3000/ping
{"success":true,"data":{"status":"ok"},"meta":{"endpoint":"/ping","capability":"api","graphApiCalls":0}}

$ curl -s -XPOST localhost:3000/scan -H 'content-type: application/json' -d '{"repository":"."}'
{"success":true,"data":{"files":202,"declarations":2594,"nodes":2822,"edges":11185,…}}

$ curl -s 'localhost:3000/route?method=GET&path=/users/:id' | jq '.data.chain[].declaration.name'
"requireAuth"
"getUser"

$ curl -s localhost:3000/nope
{"success":false,"error":{"code":"not-found","detail":"no endpoint for GET /nope","hint":"see GET /openapi.json for every endpoint"},…}
```

Run it with `PORT=3000 TRACEIQ_DB=.traceiq/graph.db node apps/api/bin/traceiq-api.js`.

## Performance

Measured against TraceIQ itself over real HTTP — 202 files, 2,594 declarations, 2,822 nodes, 11,185
edges:

| Endpoint | Cold | Warm | Payload |
|---|---|---|---|
| `POST /scan` | **1,385 ms** | — | 372 B |
| `/ping` · `/version` · `/routes` | 1.3–2.2 ms | 0.7–1.7 ms | 107 B – 163 B |
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

Every warm read is single-digit milliseconds except `/dependencies` and `/architecture`. The graph is
opened once and its cache is shared across requests, so the first read after a scan pays for the index
and every read after that does not.

**Memory: 165 MB before a scan, 502 MB after, 570 MB after every endpoint has been called.** The jump
is the scan: it runs in-process, so the compiler's program stays resident for the process lifetime. A
server that scans repeatedly should run the scan out of process — see the approval items.

## Limitations

- **A scan is a full rebuild and runs in-process.** It blocks for ~1.4 s on this repository and retains
  around 320 MB of compiler state afterwards.
- **One repository per server.** The database path is fixed at start-up.
- **Large payloads.** `/impact` reaches 871 KB and `/health` 517 KB, because a capability result is
  returned whole. There is no field selection or pagination.
- **No authentication**, as specified.
- **No caching headers.** Bodies are deterministic and would cache well, but no `ETag` or
  `Cache-Control` is set — `etag` is explicitly disabled so a body is never conditionally withheld.
- **`GET /health` is the health *report*, not a liveness probe.** Use `/ping` for that.
- Everything inherited from below: uncomposed route prefixes, partial call coverage, `INFERRED` calls,
  no interface dispatch, path-derived packages, cross-package imports resolving outside the analysed
  set. Each appears in the `limitations` field of the payload it affects.

## Testing Notes

Unit tests cover the endpoint table, the error vocabulary, the response envelope and the generated
OpenAPI document — including that every documented path is served, every declared error is documented,
and no documented path is unrouted.

`http.test.ts` starts a **real server on an ephemeral port and drives it with `fetch`**, so routing,
middleware, the body parser, status codes, headers, validation, every capability and the error handler
are exercised as a client exercises them. No HTTP testing library is involved. It covers the pre-scan
`409`, a real scan, all sixteen endpoints, both identifier encodings, every error code, header
behaviour, byte-identical determinism across repeated requests, and a rescan while serving.
