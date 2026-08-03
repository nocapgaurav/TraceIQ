<div align="center">

# TraceIQ

### Know Your Codebase.

**Static repository analysis that builds a queryable knowledge graph — then answers questions about
the repository from that graph, with citations.**

</div>

---

## What TraceIQ is

TraceIQ reads a repository the way a compiler does, not the way a search box does. It walks the
files, parses what it can parse, resolves references through the TypeScript type checker and
tree-sitter grammars, reads the repository's non-code artefacts — workflows, Dockerfiles, compose
files, manifests, schemas, documentation — and writes everything it establishes into a SQLite
knowledge graph.

Everything else is built on that graph. The web app browses it. The REST API serves it. And **Ask
TraceIQ** answers natural-language questions by selecting a bounded set of facts from it, sending
only those facts to a language model running on your own machine, then checking the answer back
against them.

## Why it exists

Pasting a repository into a chat window produces fluent text that nobody can check. TraceIQ makes
the evidence the primary artefact and the prose secondary.

**The model is the synthesis layer, not the analysis layer.** No source code is ever put in a
prompt. The model receives numbered, citable facts in exactly this shape —

```
[f12] repository has-package packages/graph (30 files, 364 declarations; imports 9 packages, imported by 7)
```

— and every sentence it writes is verified against the closed set it was given. Expand a citation
and you see the fact, the confidence attached to it, and which analyser established it.

|  | Prompt-stuffing | TraceIQ |
|---|---|---|
| **What the model sees** | As much source as fits | Numbered facts derived from a graph |
| **Context size** | Grows with the repository, then truncates | Bounded by a token budget, with every cap reported |
| **Verifiability** | A plausible sentence | A citation resolving to a fact, its confidence and its file |
| **Repeatability** | Varies run to run | The graph and the projection are deterministic |
| **Non-code files** | Whatever fits in the window | Read structurally, with declared relationships |
| **Missing evidence** | Fluent invention | "The analysis did not identify it" |

Grounding **reduces** unsupported claims; it does not eliminate them. See
[Limitations](#limitations).

## Key features

| | |
|---|---|
| **Analyse any repository** | A local path or a public GitHub URL. TypeScript, JavaScript, Python, Java and Go are parsed semantically; every other language is still described by its files, manifests, dependencies and detected technologies — and the analysis reports the depth it reached rather than pretending. |
| **Browse the graph** | Packages, files, declarations, imports, exports, routes, environment variables, dependencies and the relationships between them. |
| **Understand non-code artefacts** | Workflows, Dockerfiles, compose files, Kubernetes resources, Terraform, manifests, schemas, scripts, tests and documentation are read for what they *declare* — jobs, services, build stages, entities, headings — not just counted. |
| **Trace impact** | What a change to one declaration could reach, direct and transitive, with the routes affected. |
| **See architectural health** | Role layers, cycles, coupling hotspots, isolated declarations, unresolved references. |
| **Ask grounded questions** | Cited answers about architecture, deployment, onboarding, workflows and components, from a local model. |
| **Two interfaces, one graph** | A web app and a REST API with a generated OpenAPI document. Both read the same stored graph, so they cannot disagree. |

## Architecture at a glance

```
  repository (local path or GitHub clone)
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │  Analysis pipeline — deterministic, no AI │
  │  scanner ─▶ language analysers ─▶ resolver│
  │      └────▶ technology detection          │
  │      └────▶ artefact readers              │
  └──────────────────────────────────────────┘
                 │
                 ▼
        repository graph (SQLite)
   nodes · edges · confidence · provenance
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
  Query · Explain     Context Builder
  Impact · Health    (bounded projection)
       │                   │
       ▼                   ▼
  REST API · Web    selected facts ─▶ local model (Ollama)
                                          │
                                          ▼
                             grounding · verification
                             evidence recovery
                             safe finalisation
                                          │
                                          ▼
                                    cited answer
```

**Deterministic analysis first.** Nothing in the pipeline guesses. The same repository produces a
byte-identical graph, and every node and edge carries a confidence level — `CERTAIN` for syntax,
`RESOLVED` for a reference the type checker bound, `INFERRED` for a heuristic with one candidate,
`AMBIGUOUS` where several are plausible — plus provenance naming the analyser and the file.

**Artefact-aware.** A file with no declarations is not a file with no purpose. Eighteen artefact
families are recognised; fifteen are read for structure, and each one carries a sentence saying what
it did *not* read. A `.env` file's values are never recorded — only its variable names.

**Bounded retrieval.** A full repository context measures megabytes, so the AI layer never sees it. A
projection selects facts against a token budget in priority order and reports every cap it applied.
What a question is *about* decides which families of evidence answer it, and each family in that
policy is guaranteed a place in the budget before any family takes a second helping.

**Grounding and verification.** Every identifier, name and citation in an answer is checked against
the closed set of facts the model was given, and a set of rules checks whether the *claims* are
licensed: a reference is not an execution order, a secret is not an authentication mechanism, a
fan-in count is not architectural importance.

**Evidence recovery, bounded to one pass.** A rejected claim fails because no fact of the licensing
kind was in the projection. That failure is translated into a retrieval request, the evidence is
reselected around exactly those kinds at the same token budget, and the answer is generated once
more. Where nothing could be retrieved that would change the verdict, no second generation is spent.

**Safe finalisation.** If verification still fails, the statements that failed are removed
deterministically by the verifier that rejected them — no third model call. What is returned
verifies; what was removed is reported.

Deeper detail lives in [`docs/progress.md`](docs/progress.md) and
[`docs/04-graph-spec.md`](docs/04-graph-spec.md).

## Tech stack

| Layer | |
|---|---|
| **Language** | TypeScript 7, strict, project references across a pnpm workspace |
| **Repository analysis** | ts-morph (TypeScript Compiler API) · web-tree-sitter with Python, Java and Go grammars · fast-glob |
| **Graph storage** | SQLite via better-sqlite3 — one database per repository |
| **REST API** | Express 5 · server-sent events · generated OpenAPI 3.0 document |
| **Web app** | Next.js 15 (App Router) · React 19 · Tailwind CSS 4 · Radix primitives · TanStack Query · Zustand · React Flow · Monaco |
| **AI** | Ollama, local. The AI layer itself has **zero external runtime dependencies** — Node's own `fetch` and streams |
| **Testing** | Vitest, for both the Node packages and the web app (jsdom + Testing Library) |
| **Infrastructure** | Docker Compose — five services, two named volumes |

## Quick Start

**Docker with Compose v2 is the only prerequisite** — `docker compose`, not `docker-compose`. Node
and pnpm are needed only to [work on TraceIQ itself](#local-development).

```bash
git clone https://github.com/nocapgaurav/TraceIQ.git
cd TraceIQ
docker compose up -d
```

The first run pulls the Ollama image, builds TraceIQ's two images, and takes several minutes — budget
about 8 GB of disk. It then starts the stack and **scans TraceIQ itself into the graph**, so the app
opens on real data. No `.env` file is needed: every variable has a working default.

Then open:

| | Host URL |
|---|---|
| **Web app — start here** | <http://localhost:3001> |
| **REST API** | <http://localhost:3000/overview> — the API has no root route, so `/` returns 404 |
| **OpenAPI document** | <http://localhost:3000/openapi.json> |

Everything binds to `127.0.0.1`. Nothing in this stack authenticates, so none of it is reachable
from your network. Change the **host** ports with `WEB_PORT`, `API_PORT` and `OLLAMA_PORT`; inside
the Compose network the services always reach each other on `api:3000`, `web:3001` and
`ollama:11434`.

Check it came up:

```bash
docker compose ps                    # api, web and ollama should read "Up … (healthy)"
curl http://localhost:3000/ping      # {"success":true,"data":{"status":"ok"}, …}
```

`ollama-pull` and `seed` are one-shot jobs; `Exited (0)` is the correct state for both.

Browsing, Explorer, Impact, Architecture, Search and the whole REST API work now. **Ask TraceIQ does
not**, until you choose a model — see [Enabling Ask TraceIQ](#enabling-ask-traceiq).

### What is running

| Service | Kind | Host port | What it does |
|---|---|---|---|
| `ollama` | long-running | `11434` | The model provider. Models live in the `ollama-models` volume. |
| `ollama-pull` | one-shot | — | Downloads the configured model, once, then exits. A no-op when no model is set. |
| `api` | long-running | `3000` | The REST API. Waits for `ollama-pull` to *finish*, because it resolves its model at startup. |
| `seed` | one-shot | — | Scans the mounted repository so the app has something to show. Skips itself when a graph already exists. |
| `web` | long-running | `3001` | The Next.js app. Waits for the API to be healthy. |

Two named volumes hold everything that matters, and both survive `docker compose down`:

| Volume | Contents |
|---|---|
| `traceiq-graph` | The repository graph (`/data/graph.db`) |
| `ollama-models` | Downloaded models (gigabytes) |

`docker compose down -v` deletes both — meaning a re-download and a re-analysis. To discard only the
graph, see [Troubleshooting](#the-graph-is-stale-wrong-or-unreadable).

## Analysing another repository

Out of the box TraceIQ analyses **itself**. Two ways to point it elsewhere.

### A public GitHub repository, from the web app

Open <http://localhost:3001>, choose **Analyze a repository**, paste a GitHub URL, and watch the five
stages — `validate → clone → scan → load → complete`. When it finishes, the new graph **replaces**
the previous one.

The clone happens inside the API container, in a worker process, into a temporary directory that is
removed afterwards whether the analysis succeeded or not. Only public HTTPS GitHub URLs are
accepted.

The same thing over HTTP:

```bash
curl -X POST http://localhost:3000/analysis \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/sindresorhus/is-plain-obj"}'

curl http://localhost:3000/analysis     # progress, newest first
```

### A local repository, mounted into the stack

Point `TRACEIQ_SCAN_PATH` at a path **on your host** and bring the stack up. It is mounted
read-only; TraceIQ never writes to the code it analyses.

```bash
TRACEIQ_SCAN_PATH=/path/to/your/repo docker compose up -d
```

`seed` only scans when the graph is empty. To force a rescan of the mounted path:

```bash
docker compose run --rm -e TRACEIQ_SCAN_FORCE=1 seed
```

## Enabling Ask TraceIQ

Ollama runs **inside the Docker stack** — you do not install it yourself. It holds no model by
default, because a model is several gigabytes and a first `docker compose up` should not begin with
a download nobody requested. Until one is configured, everything except chat works and the chat page
explains what to do.

```bash
cp .env.example .env
```

Set one line in `.env`, then bring the stack up again:

```dotenv
TRACEIQ_MODEL=qwen2.5:7b-instruct
```

```bash
docker compose up -d
docker compose logs -f ollama-pull     # watch the download — ~4.7 GB, once
```

`ollama-pull` writes the model into the persistent volume and the API waits for it to finish before
starting. `qwen2.5:7b-instruct` is the model TraceIQ is verified against; any Ollama chat model
works, and a smaller one is much faster and noticeably worse at following the citation rules.

With `TRACEIQ_MODEL` set, the API **refuses to start** if the provider is unreachable or does not
hold the model — a startup problem is better discovered at startup than mid-answer.

Give Docker **8 GB** of memory if you enable chat; 4 GB is enough to browse a repository without it.

## Using TraceIQ

### Explorer

Three panes: navigation on the left, the subject in the middle, what the vocabulary means on the
right. The selection lives in the URL, so any view is shareable.

Pick a package, then a file. **A source file** shows declaration counts, imports, exports, fan-in,
fan-out and routes, with tabs for its declarations, imports, exports, external packages and
environment variables. **A non-code artefact** — a workflow, a Dockerfile, a compose file, a README —
shows what it declares instead: a **Structure** tab with its jobs, steps, services, stages or
headings, plus **References**, **Referenced by** and **Unresolved** for paths it names that match no
file. Click any declaration to open its callers, callees, type references, roles and impact in
place.

Every panel states what the analysis did *not* establish rather than showing a bare zero.

### Ask TraceIQ

Pick a subject — the whole repository, a package, a file, a declaration or a route — and ask.
Questions it is built for:

```
Explain the architecture.
Where should a new developer start?
How is this project deployed?
Walk me through one important workflow end to end.
What are the most important components, and why?
How does authentication work?
```

Reading an answer:

| | |
|---|---|
| **`[f12]`** | A citation. Expand it to see the fact, its confidence and which analyser produced it. |
| **Grounded** | The answer cited facts and named nothing the facts did not contain. |
| **Grounded after evidence recovery** | The first attempt overreached, so the evidence was reselected around the kinds of fact the claim needed and the answer regenerated once. It verified. |
| **Limited evidence** | Verification still failed, so the unsupported statements were removed. What is shown verifies; what was removed is listed under the badge. |
| **Unverifiable** | Nothing was fabricated, but nothing was cited either, so nothing could be checked. |
| **Retrieval details** | Collapsed: facts selected, prompt cost, which lists the budget capped, and what any recovery pass went back for. |

**Unsupported prose is never returned**, so there is no ungrounded answer to interpret. **Absence is
reported as absence**: asked how caching works in a repository with no cache, TraceIQ says the
analysis did not identify one — not that the repository does not have one.

### From the API

```bash
# One JSON answer.
curl -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"question":"Explain the architecture.","subject":{"kind":"repository"}}'

# Server-sent events, token by token.
curl -N -X POST http://localhost:3000/chat/stream \
  -H 'content-type: application/json' \
  -d '{"question":"Explain the architecture.","subject":{"kind":"repository"}}'
```

Every endpoint is described in [`apps/api/README.md`](apps/api/README.md) and in the generated
[OpenAPI document](http://localhost:3000/openapi.json).

## Local development

Needed only to work on TraceIQ itself. To *use* it, [Docker](#quick-start) is enough.

| | |
|---|---|
| **Node.js** | ≥ 22 (`engines` in `package.json`) |
| **pnpm** | 11 — `corepack enable && corepack prepare pnpm@11.15.0 --activate` |
| **A C++ toolchain** | Only if `better-sqlite3` has no prebuilt binary for your platform |

```bash
pnpm install
pnpm build                                    # tsc -b across the workspace
```

`pnpm build` is incremental, and the API runs from `dist/`, so a source change needs a rebuild. The
web app's dev server hot-reloads on its own.

Run the two apps directly against a local graph:

```bash
# Terminal 1 — the API on port 3000, reading a graph built by the Docker stack or by POST /scan.
TRACEIQ_DB=.traceiq/graph.db node apps/api/bin/traceiq-api.js

# Terminal 2 — the web app on port 3001, proxying /api/* to http://127.0.0.1:3000.
pnpm --filter @traceiq/web dev
```

> The dev server and the Docker `web` service both want port 3001. Stop the container first
> (`docker compose stop web`), or set `WEB_PORT` to something else for the stack.

### Testing

```bash
pnpm test              # everything: backend then web
pnpm test:backend      # the Node packages and apps
pnpm test:web          # the web app, in jsdom
pnpm test:watch        # backend, watching

pnpm build             # tsc -b — the workspace typecheck and build
pnpm typecheck:tests   # typechecks every test file
pnpm typecheck:web     # the web app
pnpm build:web         # a production Next build
pnpm clean             # tsc -b --clean
```

There is no lint script and no ESLint configuration: correctness is enforced by `tsc` under `strict`,
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, plus the test suite. One suite talks to
a real Ollama and is skipped unless both `TRACEIQ_OLLAMA_LIVE=1` and `TRACEIQ_OLLAMA_MODEL` are set.

### Rebuilding the images

Docker images are built, not mounted, so code changes need a rebuild:

```bash
docker compose build api web && docker compose up -d
```

## Configuration

Every variable has a working default, so `.env` is optional. Copy the template only to change
something: `cp .env.example .env`.

| Variable | Default | What it does |
|---|---|---|
| `TRACEIQ_MODEL` | *(empty)* | The model that answers. Empty disables chat and nothing else. |
| `TRACEIQ_MODEL_CONTEXT` | `16384` | The context window the model is run with, and the budget the prompt is sized against. Raising it costs memory and time-to-first-token. |
| `TRACEIQ_PROVIDER` | `ollama` | The only provider implemented. |
| `TRACEIQ_SCAN_PATH` | `.` | The repository to mount and scan, as a path **on the host**. Mounted read-only. |
| `WEB_PORT` | `3001` | Host port for the web app. |
| `API_PORT` | `3000` | Host port for the REST API. |
| `OLLAMA_PORT` | `11434` | Host port for Ollama. |
| `TRACEIQ_API_URL` | `http://api:3000` | Where the browser's `/api/*` calls are forwarded. **Build-time** — rebuild the web image after changing it. |
| `TRACEIQ_WORKSPACE_ROOT` | *(system temp)* | Where GitHub clones are written before being scanned. |
| `TRACEIQ_CLONE_TIMEOUT_MS` | `600000` | How long a clone may take. |
| `TRACEIQ_MAX_CLONE_MB` | `2048` | The largest repository that may be cloned. |

Compose sets `TRACEIQ_DB` and `TRACEIQ_OLLAMA_URL` for you. A handful of tuning variables —
`TRACEIQ_ANALYSIS_CONCURRENCY`, `TRACEIQ_ANALYSIS_TIMEOUT_MS`, `TRACEIQ_WORKER_HEAP_MB`,
`TRACEIQ_FILE_BUDGET`, `TRACEIQ_WHOLE_PROGRAM_LIMIT` — and the optional `TRACEIQ_COMMIT` /
`TRACEIQ_BUILT_AT` build stamps are documented with their reasoning in
[`.env.example`](.env.example).

## Troubleshooting

Start with the logs: `docker compose logs api | tail -30`.

### The API keeps restarting, or exits immediately

| Log line | Cause | Fix |
|---|---|---|
| `model provider unavailable` | `TRACEIQ_MODEL` is set but Ollama is not reachable | `docker compose up -d ollama`, wait for healthy, then `docker compose up -d --no-deps api` |
| `model-not-found` | The provider does not hold that model | `docker compose exec ollama ollama pull <model>`, or fix the tag in `.env` |
| `unknown provider` | `TRACEIQ_PROVIDER` is not `ollama` | `ollama` is the only provider implemented |
| `uses schema version N, but this build expects M` | The graph was written by an older build | Reset the graph, below — not `down -v`, which deletes the model too |

`--no-deps` matters: a plain `docker compose up -d api` follows `depends_on` and waits on the whole
Ollama chain, which can be minutes while a model downloads.

### Chat says `ai-not-configured`

`TRACEIQ_MODEL` is empty — the default. See [Enabling Ask TraceIQ](#enabling-ask-traceiq).

### The graph is stale, wrong, or unreadable

The graph holds whatever was analysed last, including a GitHub repository analysed through the UI.
To go back to the mounted path, force a rescan as shown under
[Analysing another repository](#a-local-repository-mounted-into-the-stack).

To discard the graph entirely and keep the downloaded model — on the next `up`, `seed` finds no
graph and rescans:

```bash
docker compose down
docker volume rm traceiq_traceiq-graph      # Compose prefixes the project name
docker compose up -d
```

### A GitHub analysis fails

`repository-too-large` means the clone crossed `TRACEIQ_MAX_CLONE_MB`; `analysis-timeout` means it
exceeded `TRACEIQ_CLONE_TIMEOUT_MS`. Raise either in `.env` and restart the API. A git error usually
means the repository is private — only public HTTPS GitHub URLs are accepted.

### Port already in use

Set `WEB_PORT`, `API_PORT` or `OLLAMA_PORT` in `.env` and run `docker compose up -d` to recreate the
containers. These are **host** ports only, so nothing needs rebuilding — except `TRACEIQ_API_URL`,
which is compiled into the web image.

### Answers are very slow

Prompt evaluation on a CPU-only 7B container runs at roughly 46 tokens per second, so a
3,400-token prompt is around a seventy-second wait before the first word. Lower
`TRACEIQ_MODEL_CONTEXT`, use a smaller model, or give Docker more memory. The UI always names the
stage it is waiting on.

## Project structure

```
apps/
  api/          REST API — Express, SSE, generated OpenAPI, out-of-process analysis workers
  web/          Next.js app — Overview, Explorer, Architecture, Impact, Search, Ask TraceIQ
  cli/          An internal development tool for scanning and querying a graph

packages/
  types/        The closed vocabularies: relationships, roles, confidence, artefact terms
  shared/       Node identity construction, shared by every layer
  scanner/      Walks the repository: files, languages, roles, manifests, technology regions
  technology/   Detects frameworks, runtimes and infrastructure, with the files that prove each
  artifact/     Reads non-code artefacts — workflows, containers, schemas, docs, scripts
  project-host/ Bounded TypeScript program construction
  ir/           Language-independent intermediate representation of declarations
  resolver/     Binds references through the type checker; records what it could not bind
  call-graph/   Call edges, resolved and unresolved
  framework/    Routes, roles and environment variables from framework conventions
  tree-sitter/  The grammar host shared by the non-compiler analysers
  python/ java/ go/   Tree-sitter analysers
  analyzer/     Runs every analyser in isolation, so one failure costs only its own regions
  graph-api/    The graph's read model and interface — no SQL, no driver
  graph/        Builds and stores the graph; owns the schema and every SQL statement
  query/        Traversals over the graph
  explain/      Everything recorded about one declaration
  impact/       What a change could reach
  health/       Coupling, cycles, roles, findings
  explorer/     Overview, files, packages, dependencies, hotspots, artefact views, search
  navigation/   The trees the web app renders
  pipeline/     The write path: scan → analyse → build → store
  analysis/     Clone-and-scan orchestration for a GitHub URL
  context/      Composes capability results into one deterministic repository context
  ai/           Projection, planning, prompting, grounding, verification. Names no vendor
  ai-ollama/    The Ollama provider — the only place a vendor is named
  bench/        Ground-truth measurement harness

docs/
  progress.md       The engineering record — milestones, defects, measurements, decisions
  04-graph-spec.md  The graph specification
```

Most packages carry their own `README.md` describing purpose, boundaries and limitations.
[`apps/api/README.md`](apps/api/README.md) and [`apps/web/README.md`](apps/web/README.md) are the
interface references.

## Limitations

Stated plainly, because a tool that hides its edges is harder to trust than one that names them.

**Static-analysis boundaries.** TraceIQ reads code; it does not run it. Dynamic dispatch, reflection,
runtime configuration and anything decided at execution time are outside what it can establish. Such
relationships are recorded as `INFERRED` or `AMBIGUOUS`, and each one says so.

**Artefact-parsing boundaries.** No reader is a conforming parser. YAML anchors are not expanded,
templates are read as templates rather than as what they render to, Docker build arguments are not
substituted, Compose `extends` and override files are not resolved, a schema's columns and foreign
keys are not read, Markdown prose is not interpreted, and shell control flow is not followed.

**Unsupported formats.** Ansible, Helm before rendering, Kustomize, Bazel, CMake, Gradle DSL, systemd
units, nginx configuration, OpenAPI and JSON Schema *as schemas*, protobuf, notebooks and every
binary format have no reader. Each is still recorded with its family, language and position, and
carries a sentence saying no reader exists.

**Reference resolution resolves to files.** A path naming a directory — a `tsconfig` project
reference, a build context — stays unresolved, as does a path into a build output. Both are reported
as unresolved references rather than dropped.

**Repository classification is a judgement.** The repository *type* is derived from routes, manifests
and role annotations and can be wrong; a collection of sample applications with real routes may be
described as an application. The directory-map *category* is derived independently for that reason.

**AI and grounding.** Grounding is not a proof system: it checks that every name an answer uses
exists in the facts, and that a set of specific claim shapes are licensed. It cannot detect a wrong
claim about a real relationship. One evidence-recovery pass runs at most, and where a claim is one no
fact could ever license, none runs at all. Answer quality depends on the model and the machine —
weak answers are shortened and labelled, not laundered — and formatting instructions are not
enforceable.

**Performance and rescanning.** There is no incremental analysis: rescanning is whole-repository, and
because node identity is derived from location a rename reads as a delete plus a create. CPU-only
inference is slow.

## Privacy

With the default Docker setup, **repository analysis and inference both happen on your machine**.
Ollama runs as a container in the stack, models are downloaded to a local volume, and prompts go to
`http://ollama:11434` on the Compose network. No repository content is sent to a hosted model API.

Two things leave your machine, and both are explicit: **pulling a model** downloads it from Ollama's
registry, and **analysing a GitHub URL** clones that repository over HTTPS. Pointing
`TRACEIQ_OLLAMA_URL` at a remote provider sends evidence there instead — that is your configuration,
not the default.

Only *facts* reach a prompt — identifiers, counts, relationships and short evidence strings — never
file contents. A test asserts it directly: it answers a question about a repository whose source it
knows, then checks that no line of that source appears in the prompt. Environment variable **values**
are excluded further still: they are never read into the graph at all.

## License

TraceIQ is licensed under the MIT License. See [LICENSE](LICENSE).

---

<div align="center">

**TraceIQ** — every value shown exists in the repository graph.

</div>
