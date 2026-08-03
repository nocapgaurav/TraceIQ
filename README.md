<div align="center">

# TraceIQ

### Know Your Codebase.

**Static repository analysis that builds a queryable knowledge graph — then answers questions about
the repository from that graph, with citations.**

</div>

---

TraceIQ reads a repository the way a compiler does, not the way a search box does. It walks the
files, parses what it can parse, resolves references through the TypeScript type checker and
tree-sitter grammars, reads the repository's non-code artefacts — workflows, Dockerfiles, compose
files, manifests, schemas, documentation — and writes everything it establishes into a SQLite
knowledge graph.

Everything else is built on that graph. The web app browses it. The CLI queries it. And **Ask
TraceIQ** answers natural-language questions by selecting a bounded set of facts from it, sending
only those facts to a local language model, and then checking the answer back against them.

**The model is the synthesis layer, not the analysis layer.** No source code is ever put in a
prompt. The model receives numbered, citable facts in exactly this shape —

```
[f12] repository has-package packages/graph (30 files, 364 declarations; imports 9 packages, imported by 7)
```

— and every sentence it writes is verified against the closed set it was given. That is what makes
an answer traceable: expand a citation and you see the fact, the confidence attached to it, and
which analyser established it.

<!--
  SCREENSHOT PLACEHOLDER — Overview
  Add a screenshot of http://localhost:3001/dashboard here.
  No screenshots are committed to this repository yet.
-->

---

## Contents

| | |
|---|---|
| **[What TraceIQ does](#what-traceiq-does)** · **[Quick Start](#quick-start)** · **[The model](#the-model)** | Understand it, then run it |
| **[Analyse a repository](#analyse-a-repository)** · **[Explorer](#using-the-explorer)** · **[Ask TraceIQ](#using-ask-traceiq)** | Use it |
| **[How it works](#how-it-works)** · **[What it understands](#what-traceiq-understands)** · **[Tech stack](#tech-stack)** | How it is built |
| **[Local development](#local-development-without-docker)** · **[Testing](#testing)** · **[Docker cheat sheet](#docker-cheat-sheet)** · **[Troubleshooting](#troubleshooting)** | Work on it |
| **[Project structure](#project-structure)** · **[Limitations](#limitations)** · **[Privacy](#privacy)** | Know its edges |

---

## What TraceIQ does

| | |
|---|---|
| **Analyse any repository** | Point it at a local path or a public GitHub URL. TypeScript, JavaScript, Python, Java and Go are parsed semantically; every other language is still described by its files, manifests, dependencies and detected technologies — and the analysis reports which depth it reached rather than pretending. |
| **Browse the repository graph** | Packages, files, declarations, imports, exports, routes, environment variables, dependencies and the relationships between them. |
| **Understand non-code artefacts** | Workflows, Dockerfiles, compose files, Kubernetes resources, Terraform, manifests, schemas, shell scripts, tests, `.env` files and documentation are read for what they *declare* — jobs, services, build stages, entities, headings — not just counted. |
| **Trace impact** | What a change to one declaration could reach, direct and transitive, with the routes affected. |
| **See architectural health** | Role layers, cycles, coupling hotspots, isolated declarations, unresolved references. |
| **Ask questions** | Grounded, cited answers about architecture, deployment, onboarding, workflows and components — from a model running on your own machine. |
| **Use it three ways** | A web app, a REST API with a generated OpenAPI document, and a CLI. All three read the same graph. |

---

## Quick Start

The recommended path. **Docker is the only prerequisite** — Node and pnpm are needed only for
[local development](#local-development-without-docker).

### Prerequisites

| | |
|---|---|
| **Docker** | With Compose v2 (`docker compose`, not `docker-compose`). Verified on Docker 29 / Compose v5. |
| **Git** | To clone the repository. |
| **Disk** | ~8 GB of images — the Ollama base image is ~7 GB on its own, plus ~1 GB for TraceIQ's API and web images. Another ~5 GB if you enable chat and download the model. |
| **Memory** | 4 GB for Docker is enough to browse a repository. Give it **8 GB** if you enable chat — a 7B model runs inside the stack. |

Node.js ≥ 22 and pnpm 11 are required **only** if you run the apps directly instead of in Docker.

### 1. Clone and start

```bash
git clone https://github.com/nocapgaurav/TraceIQ.git
cd TraceIQ
docker compose up -d
```

The first run pulls the Ollama image, builds TraceIQ's two images, and takes several minutes. It then
starts five services in dependency order and **scans TraceIQ itself into the graph**, so the app
opens on real data rather than an empty state.

No `.env` file is needed. Every variable has a working default.

### 2. Open it

| | |
|---|---|
| **Web app** | <http://localhost:3001> — start here |
| **REST API** | <http://localhost:3000/overview> — the API has no root route, so `/` returns 404 |
| **OpenAPI** | <http://localhost:3000/openapi.json> |

Everything binds to `127.0.0.1`. Nothing in this stack authenticates, so none of it is reachable
from your network.

### 3. Chat is off until you ask for it

Browsing, Explorer, Impact, Architecture, Search and the whole REST API work immediately. **Ask
TraceIQ does not**, because a model is several gigabytes and a first `docker compose up` should not
begin with a download nobody requested. The chat page says so, and the API answers
`503 ai-not-configured`.

To enable it, see [The model](#the-model) below.

### What just started

```
ollama ──healthy──▶ ollama-pull ──completed──▶ api ──healthy──▶ web
  │                                            │                 │
  │                                            └──healthy──▶ seed │
  ▼                                            ▼                 ▼
ollama-models                            traceiq-graph      (no volume)
  (named volume)                          (named volume)
```

| Service | Kind | What it does |
|---|---|---|
| `ollama` | long-running | The model provider, on port `11434`. Models live in the `ollama-models` volume. |
| `ollama-pull` | **one-shot** | Downloads the configured model, once, then exits. A no-op when no model is set. |
| `api` | long-running | The REST API on port `3000`. Waits for `ollama-pull` to *finish*, because it resolves its model at startup. |
| `seed` | **one-shot** | Scans the mounted repository through `POST /scan` so the app has something to show. **Skips itself when a graph already exists**, so it is a first-run step and not a rescan on every `up`. |
| `web` | long-running | The Next.js app on port `3001`. Waits for the API to be *healthy*. |

**Two named volumes hold everything that matters:**

| Volume | Contents | Survives `down`? |
|---|---|---|
| `traceiq-graph` | The repository graph (`/data/graph.db`) | Yes |
| `ollama-models` | Downloaded models (gigabytes) | Yes |

`docker compose down` stops and removes the containers and leaves both volumes alone — verified.
**`docker compose down -v` deletes both**, which means re-downloading the model and re-analysing the
repository. Use it only when you mean it.

---

## The model

Ollama runs **inside the Docker stack**. You do not install it yourself.

### Enable chat

```bash
cp .env.example .env
```

Set one line in `.env`:

```dotenv
TRACEIQ_MODEL=qwen2.5:7b-instruct
```

Then bring the stack up again:

```bash
docker compose up -d
```

The `ollama-pull` service downloads the model into the persistent volume — **~4.7 GB, once** — and
the API waits for it to finish before starting. Watch it:

```bash
docker compose logs -f ollama-pull
```

`qwen2.5:7b-instruct` is the model TraceIQ is verified against. Any Ollama chat model works; a
smaller one (`qwen2.5:0.5b-instruct`, ~400 MB) is much faster and noticeably worse at following the
citation rules.

### Verify the model is there

```bash
docker compose exec ollama ollama list
```

To pull one by hand, or to add a second:

```bash
docker compose exec ollama ollama pull qwen2.5:7b-instruct
```

### If the provider is unavailable

With `TRACEIQ_MODEL` set, the API **refuses to start** when the provider is unreachable or does not
hold the model — it exits with `model provider unavailable` or `model-not-found` rather than failing
one request at a time. That is deliberate: it is a startup problem, and finding out at startup is
better than finding out mid-answer. Check `docker compose logs api`.

With `TRACEIQ_MODEL` unset, the API starts normally and only the two chat endpoints report
`ai-not-configured`.

---

## Verify it is running

```bash
docker compose ps
```

All three long-running services should read `Up … (healthy)`; `ollama-pull` and `seed` should be
absent or `Exited (0)` — they are one-shot jobs that are *supposed* to finish.

```bash
# Liveness. Answers without opening a graph.
curl http://localhost:3000/ping

# Is a repository scanned, and where is the graph?
curl http://localhost:3000/version

# Full status: uptime, memory, graph, analysis depth per region.
curl http://localhost:3000/healthz

# Real data from the graph.
curl http://localhost:3000/overview
```

`/ping` returns:

```json
{"success":true,"data":{"status":"ok"},"meta":{"endpoint":"/ping","capability":"api","graphApiCalls":0}}
```

Logs, if something looks wrong:

```bash
docker compose logs -f api
docker compose logs seed        # the first-run scan
docker compose logs ollama-pull # the model download
```

---

## Analyse a repository

Out of the box TraceIQ analyses **itself**. There are three ways to point it at something else.

### A. A public GitHub repository, from the web app (recommended)

1. Open <http://localhost:3001>.
2. Click **Analyze a repository**.
3. Paste a GitHub URL — for example `https://github.com/facebook/react`.
4. Click **Analyze Repository**.
5. Watch the five stages: *Validating repository URL → Cloning → Scanning → Loading → Complete*.
6. When it finishes, the new graph **replaces** the previous one. Open **Overview** or **Explorer**.

The clone happens in the API container, into a temporary directory that is removed afterwards
whether the analysis succeeded or not. It runs in a worker process, so the API stays responsive.

The same thing over HTTP:

```bash
curl -X POST http://localhost:3000/analysis \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/sindresorhus/is-plain-obj"}'

# Progress, newest first.
curl http://localhost:3000/analysis
```

### B. A local repository, mounted into the stack

Point `TRACEIQ_SCAN_PATH` at it — a path **on your host** — and bring the stack up. It is mounted
read-only; TraceIQ never writes to the code it analyses.

```bash
TRACEIQ_SCAN_PATH=/path/to/your/repo docker compose up -d
```

`seed` only scans when the graph is empty. To force a rescan of the mounted path:

```bash
docker compose run --rm -e TRACEIQ_SCAN_FORCE=1 seed
```

> The `seed` container's own documentation mentions `docker compose run --rm seed --force`. **That
> does not work** — Compose replaces the container's command, so it runs `node --force`. Use the
> environment variable above.

### C. The CLI, against a graph on your own disk

No Docker, no API. Requires the [local development](#local-development-without-docker) setup.

```bash
node apps/cli/bin/traceiq.js scan /path/to/repo
node apps/cli/bin/traceiq.js overview
```

---

## Using the Explorer

Open **Explorer** in the sidebar. Three panes: navigation on the left, the subject in the middle,
what the vocabulary means on the right. The selection lives in the URL, so any view is shareable.

1. **Pick a package** in the left pane, then a file inside it.
2. **For a source file**, the centre pane shows declaration counts, imports, exports, fan-in,
   fan-out and routes, with tabs for declarations, imports, exports, external packages, environment
   variables and the raw API payload.
3. **For a non-code artefact** — a workflow, a Dockerfile, a compose file, a README, a schema — the
   centre pane shows what that artefact declares instead: a **Structure** tab with its jobs, steps,
   services, stages, entities or headings; **References** and **Referenced by**; and **Unresolved**
   for paths it names that match no file.
4. **Click a declaration** to open it in place — its callers, callees, type references, roles and
   impact — without leaving the page.
5. **Ask TraceIQ about what is selected** using the quick action on the panel.

Every panel states what the analysis did *not* establish rather than showing a bare zero. A file
with no declarations reads "No source-code declarations were extracted from this file", followed by
what it does declare and where the reading stopped.

<!--
  SCREENSHOT PLACEHOLDER — Explorer
  Add a screenshot of http://localhost:3001/explorer with an artefact selected
  (for example ?file=docker-compose.yml).
-->

---

## Using Ask TraceIQ

Open **Ask TraceIQ**. Pick a subject — the whole repository, a package, a file, a declaration or a
route — and ask.

Questions TraceIQ is built to answer:

```
What does this repository do?
Explain the architecture.
What are the major packages, and how do they interact?
Where should a new developer start?
What tests should I read first?
How is this project deployed?
Walk me through one important workflow end to end.
What are the most important components, and why?
How does authentication work?
Which modules depend on the graph package?
```

### Reading an answer

| | |
|---|---|
| **`[f12]`** | A citation. The model is instructed to cite every claim; expand it to see the fact, its confidence and which analyser produced it. |
| **grounded** | The answer cited facts and named nothing the facts did not contain. |
| **unverifiable** | Nothing was fabricated, but nothing was cited either, so nothing could be checked. |
| **ungrounded** | The answer named something no fact carried, or made a claim the facts do not license. The answer is still shown, with what failed. |
| **rewritten once** | Verification rejected the first attempt, so it was regenerated from the same facts with the failed sentences named. This happens at most once per answer. |

**Absence is reported as absence.** Asked how caching works in a repository with no cache, TraceIQ
says the analysis did not identify one — not that the repository does not have one. Those are
different claims, and only the first is supportable.

<!--
  SCREENSHOT PLACEHOLDER — Ask TraceIQ
  Add a screenshot of http://localhost:3001/chat showing an answer with citations.
-->

### From the CLI

An interactive, streaming REPL. Ctrl+C cancels one answer without ending the session.

```bash
node apps/cli/bin/traceiq.js chat --model qwen2.5:7b-instruct --subject repository
```

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

---

## How it works

```
       repository (local path or GitHub clone)
                        │
                        ▼
  ┌─────────────────────────────────────────────┐
  │  Analysis pipeline — deterministic, no AI   │
  │                                             │
  │  scanner ─▶ language analysers ─▶ resolver  │
  │      │       (ts-morph, tree-sitter)        │
  │      └────▶ technology detection            │
  │      └────▶ artefact readers                │
  └─────────────────────────────────────────────┘
                        │
                        ▼
              repository graph (SQLite)
         nodes · edges · confidence · provenance
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   Query Engine     Explorer        Context Builder
   Explain          Health          (bounded projection)
   Impact           Navigation             │
        │               │                  ▼
        └───────┬───────┘            selected facts
                │                          │
                ▼                          ▼
        REST API · CLI · Web         local model (Ollama)
                                           │
                                           ▼
                                  grounding + verification
                                           │
                                           ▼
                                   cited answer
```

Five ideas carry the design.

**Deterministic analysis first.** Nothing in the pipeline guesses. The same repository produces a
byte-identical graph, and every node and edge carries a confidence level — `CERTAIN` for syntax,
`RESOLVED` for a reference the type checker bound, `INFERRED` for a heuristic with one candidate,
`AMBIGUOUS` where several are plausible — plus provenance naming the analyser and the file.

**A graph, reused.** Analysis happens once. Every surface reads the same stored graph, so the CLI,
the API and the web app cannot disagree about a repository.

**Artefact-aware.** A file with no declarations is not a file with no purpose. See
[What TraceIQ understands](#what-traceiq-understands).

**Bounded AI context.** A full repository context measures megabytes — far more than any context
window. So the AI layer never sees it. A projection layer selects facts against a token budget, in
priority order, and reports every cap it applied. Prompts run around 4,300–4,600 tokens regardless
of repository size.

**Grounding, then one correction.** After generation, every identifier, package name and citation in
the answer is checked against the closed set of facts it was given, and a small set of rules checks
whether the *claims* are licensed — a reference is not an execution order, a secret is not an
authentication mechanism, a fan-in count is not architectural importance. An answer that fails is
regenerated **once**, from the same facts, with the failed sentences named. If it still fails, the
safer of the two is returned with its warning intact.

---

## What TraceIQ understands

### Source code

TypeScript and JavaScript through the TypeScript compiler API; Python, Java and Go through
tree-sitter grammars. Declarations, containment, imports, exports, calls, type references,
inheritance, routes, environment variable reads and architectural roles.

Any other language still produces a graph — files, languages, manifests, declared dependencies,
detected technologies — and the analysis records the depth it reached per region, so a consumer can
tell "analysed and found nothing" from "never analysed".

### Non-code artefacts

Eighteen artefact families. Fifteen are read for structure, two are recorded by presence, and one is
an explicit "no reader exists for this":

| Family | What is read |
|---|---|
| `ci-workflow` | Jobs, declared prerequisites, steps, commands, triggers, conditions, variable names |
| `container-image` | Build stages, base images, commands, exposed ports, variable names, copied paths |
| `container-compose` | Services, images, build contexts, ports, volumes, networks, `depends_on`, commands |
| `orchestration-resource` | Each document's kind and name, container images, ports, variable names |
| `infrastructure-as-code` | Terraform resources, data sources, modules, variables, outputs, module sources |
| `package-manifest` | Scripts, workspace members, declared entry points, metadata |
| `schema` | Tables, views, indexes, altered tables, Prisma/GraphQL model declarations |
| `documentation` | Headings, and links that resolve to repository files |
| `script` | Functions, uppercase assignments, invoked paths, variable references |
| `test` | Suites, and a bounded sample of case names |
| `environment-configuration` | **Variable names only** — never values |
| `tool-configuration`, `build-configuration`, `workspace-configuration`, `data` | Sections, settings, referenced paths |
| `lockfile`, `generated` | Presence, with the reason they were not read |
| `unknown-artifact` | Presence, language and position, with a boundary saying no reader exists |

Three things worth knowing:

- **A `.env` file's values are never recorded.** It holds live credentials in a great many
  repositories, and a value recorded in the graph would reach a prompt and then an answer. Only the
  names are stored, and a test enforces it.
- **A YAML file's family is decided by its content, not its name.** `deploy.yml` is a workflow in one
  repository, a compose file in the next and a Kubernetes manifest in the third; what is knowable is
  what its top level declares.
- **No reader is a conforming parser, and every one says what it did not read.** Each artefact
  carries a boundary sentence — "read as indentation structure; template expansion was not
  performed" — shown verbatim in the Explorer. An artefact with no extracted structure *and* a
  boundary sentence is a very different claim from silence.

Where the evidence supports it, artefacts participate in the graph like anything else: a workflow
step that invokes a script, a compose service that declares it needs another, a document that links
to a module, a configuration file that configures a detected technology. Those relationships reach
the Explorer, retrieval and the answers — which is what makes "how is this deployed" and "walk me
through a workflow" answerable on a repository whose ordering exists only in YAML.

---

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
| **Infrastructure** | Docker Compose, five services, two named volumes |

Everything below the web app depends on four external runtime packages in total —
`better-sqlite3`, `ts-morph`, `fast-glob`, `express`.

---

## Local development without Docker

Needed only to work on TraceIQ itself. To *use* it, [Docker](#quick-start) is enough.

### Prerequisites

| | |
|---|---|
| **Node.js** | ≥ 22 (`engines` in `package.json`). Verified on 22 and 26. |
| **pnpm** | 11 — the version the lockfile was written by. `corepack enable && corepack prepare pnpm@11.15.0 --activate` |
| **A C++ toolchain** | Only if `better-sqlite3` has no prebuilt binary for your platform. macOS: Xcode command line tools. Debian/Ubuntu: `python3 make g++`. |
| **Ollama** | Only for chat. Either run the Docker stack (which exposes it on `127.0.0.1:11434`) or install Ollama natively. |

### Install and build

```bash
pnpm install
pnpm build          # tsc -b across the workspace; required before the API or CLI will run
```

### Run the stack directly

**First, scan a repository into a local graph** — a one-shot command, not a long-running process:

```bash
node apps/cli/bin/traceiq.js scan .
# writes .traceiq/graph.db
```

**Terminal 1 — the API on port 3000**

```bash
TRACEIQ_DB=.traceiq/graph.db node apps/api/bin/traceiq-api.js
```

Add chat by naming a model the provider holds. Without it the API starts and reports
`chat disabled`:

```bash
TRACEIQ_DB=.traceiq/graph.db \
TRACEIQ_MODEL=qwen2.5:7b-instruct \
node apps/api/bin/traceiq-api.js
```

**Terminal 2 — the web app on port 3001**

```bash
pnpm --filter @traceiq/web dev
```

In development the web app proxies `/api/*` to `http://127.0.0.1:3000` by default, so no
configuration is needed when the API is running as above. Open <http://localhost:3001>.

> **Both the dev server and the Docker `web` service use port 3001.** Running them together leaves
> the dev server unable to bind it. Stop the container first — `docker compose stop web` — or set
> `WEB_PORT` to something else for the stack.

**Terminal 3 (optional) — Ollama**, if you are not running the Docker stack:

```bash
ollama serve
ollama pull qwen2.5:7b-instruct
```

### Rebuild after a change

`pnpm build` is incremental. The API and CLI run from `dist/`, so a source change needs a rebuild;
the web app's dev server hot-reloads on its own.

---

## Testing

```bash
pnpm test              # everything: backend then web
pnpm test:backend      # the Node packages and apps
pnpm test:web          # the web app, in jsdom
pnpm test:watch        # backend, watching

pnpm build             # tsc -b — the workspace typecheck and build
pnpm typecheck:tests   # typechecks every test file
pnpm typecheck:web     # the web app
pnpm build:web         # a production Next build
```

There is **no lint script and no ESLint configuration**. Correctness is enforced by `tsc` under
`strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, plus the test suite.

The suite is large and layered: unit tests against fabricated inputs, integration tests over a real
scanned repository, boundary tests asserting architectural rules mechanically against both source
and build output, HTTP tests against a real server on an ephemeral port, component tests against the
web app's accessible tree, and determinism tests asserting byte-identical output for identical input.

One suite talks to a real Ollama and is skipped unless both `TRACEIQ_OLLAMA_LIVE=1` and
`TRACEIQ_OLLAMA_MODEL` are set. It never runs in CI.

**Deliberately not tested:** whether a given model writes a *good* answer. That is model evaluation,
it needs labelled data, and a test asserting it would be asserting a hope.

---

## Docker cheat sheet

Run all of these from the repository root.

```bash
# Start / stop
docker compose up -d                       # start everything, detached
docker compose up                          # start in the foreground, logs on stdout
docker compose down                        # stop and remove containers; volumes survive
docker compose down -v                     # ⚠️  also deletes the graph and the models

# Status and logs
docker compose ps
docker compose logs -f api
docker compose logs -f web
docker compose logs ollama-pull            # the model download
docker compose logs seed                   # the first-run scan

# Restart or stop one service without touching the rest
docker compose restart api
docker compose stop web                    # free port 3001 for a local dev server
docker compose start web
docker compose up -d --no-deps api         # start/replace only api, skipping the ollama chain

# Rebuild after changing code
docker compose build api
docker compose build web
docker compose build                       # both
docker compose up -d --build               # rebuild and restart in one step

# Re-analyse the mounted repository
docker compose run --rm -e TRACEIQ_SCAN_FORCE=1 seed

# The model
docker compose exec ollama ollama list
docker compose exec ollama ollama pull qwen2.5:7b-instruct

# Health
curl http://localhost:3000/ping
curl http://localhost:3000/version
curl http://localhost:3000/healthz
```

**Why `--no-deps` matters.** `docker compose up -d api` follows `depends_on`, which waits on
`ollama` becoming healthy and `ollama-pull` completing — minutes if a model is downloading.
`--no-deps` starts only the service you named. Note that `up` never triggers a rescan on its own:
`seed` checks for an existing graph and leaves it alone.

---

## Troubleshooting

### The API container keeps restarting, or exits immediately

Read its logs first:

```bash
docker compose logs api | tail -30
```

| Log line | Cause | Fix |
|---|---|---|
| `model provider unavailable` | `TRACEIQ_MODEL` is set but Ollama is not reachable | `docker compose up -d ollama`, wait for healthy, then `docker compose up -d --no-deps api` |
| `model-not-found` | The provider does not hold that model | `docker compose exec ollama ollama pull <model>`, or fix the tag in `.env` |
| `unknown provider` | `TRACEIQ_PROVIDER` is not `ollama` | `ollama` is the only provider implemented |
| `uses schema version N, but this build expects M` | The graph in the volume was written by an older build of TraceIQ | Reset the graph volume only — see [the graph volume](#reset-the-graph-only) below. Do not use `down -v`; it deletes the model as well |

### The model is still downloading

`ollama-pull` blocks the API on purpose. Watch it, and wait:

```bash
docker compose logs -f ollama-pull
```

### Chat says `ai-not-configured`

`TRACEIQ_MODEL` is empty — the default. Set it in `.env` and run `docker compose up -d` again. See
[The model](#the-model).

### The dashboard says no repository has been scanned

```bash
curl http://localhost:3000/version        # "scanned": false confirms it
docker compose logs seed                  # why the first-run scan did not complete
docker compose run --rm -e TRACEIQ_SCAN_FORCE=1 seed
```

### The graph is stale, or shows the wrong repository

The graph holds whatever was analysed last — including a GitHub repository analysed through the UI.
To go back to the mounted path:

```bash
docker compose run --rm -e TRACEIQ_SCAN_FORCE=1 seed
```

### Reset the graph only

Throws away the graph and keeps the downloaded model. On the next `up`, `seed` finds no graph and
re-scans the mounted repository automatically:

```bash
docker compose down
docker volume rm traceiq_traceiq-graph
docker compose up -d
```

The volume is named `traceiq_traceiq-graph` because Compose prefixes the project name; confirm it
with `docker volume ls`.

### A GitHub analysis fails

| Error code | Meaning |
|---|---|
| `repository-too-large` | The clone crossed `TRACEIQ_MAX_CLONE_MB` (2048 by default) |
| `analysis-timeout` | The clone exceeded `TRACEIQ_CLONE_TIMEOUT_MS` (ten minutes by default) |
| a git error | Private repositories are not supported; only public HTTPS GitHub URLs are accepted |

Raise the limits in `.env` and restart the API.

### Port already in use

Change the host port and restart. All three are configurable:

```dotenv
WEB_PORT=4001
API_PORT=4000
OLLAMA_PORT=21434
```

Then `docker compose up -d` to recreate the containers with the new mappings. These change only the
**host** ports; inside the Compose network the services still talk to each other on `3000`, `3001`
and `11434`, so nothing needs rebuilding.

`TRACEIQ_API_URL` is a **build-time** value for the web image — if you change it, rebuild with
`docker compose build web`. Setting it on a running container has no effect, because Next compiles
its rewrites into the build.

### Answers are very slow

Prompt evaluation on a CPU-only 7B container was measured at about 46 tokens per second, so a
4,500-token prompt is roughly a ninety-second wait before the first word. Options: lower
`TRACEIQ_MODEL_CONTEXT` (fewer facts, shorter prompt, faster), use a smaller model, or give Docker
more memory. The UI names the stage it is waiting on so a long wait is never a blank screen.

### Code changes are not showing up

Docker images are built, not mounted. Rebuild:

```bash
docker compose build api web && docker compose up -d
```

### Stop everything safely

```bash
docker compose down          # keeps the graph and the models
```

---

## Project structure

```
apps/
  api/          REST API — Express, SSE, generated OpenAPI, out-of-process analysis workers
  web/          Next.js app — Overview, Explorer, Architecture, Impact, Search, Ask TraceIQ
  cli/          traceiq — scan, query and an interactive chat REPL

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
  progress.md       The full engineering record — every milestone, defect and measurement
  04-graph-spec.md  The graph specification
```

Most packages carry their own `README.md` describing purpose, boundaries and limitations.

---

## How this differs from pasting a repository into a chat window

|  | Prompt-stuffing | TraceIQ |
|---|---|---|
| **What the model sees** | As much source as fits | Numbered facts derived from a graph |
| **Context size** | Grows with the repository, then truncates | Bounded by a token budget, with every cap reported |
| **Verifiability** | A plausible sentence | A citation that resolves to a fact, its confidence and its file |
| **Repeatability** | Varies run to run | The graph and the projection are deterministic; identical input gives identical facts |
| **Cost of a second question** | The whole repository again | The graph is already built; only the projection changes |
| **Non-code files** | Whatever fits in the window | Read structurally, with declared relationships |
| **When evidence is missing** | Fluent invention | "The analysis did not identify it" |

Grounding **reduces** unsupported claims; it does not eliminate them. See
[Limitations](#limitations).

---

## Limitations

Stated plainly, because a tool that hides its edges is harder to trust than one that names them.

**Static analysis has a ceiling.** TraceIQ reads code; it does not run it. Dynamic dispatch,
reflection, runtime configuration and anything decided at execution time are outside what it can
establish. Some relationships are therefore recorded as `INFERRED` or `AMBIGUOUS`, and every one of
them says so.

**Artefact readers are shallow by design.** None is a conforming parser. YAML anchors and aliases
are not expanded, flow sequences are not split, and a templated file is read as the template rather
than as what it renders to. Docker build arguments are not substituted. Compose `extends`, profiles
and override files are not resolved. A schema's columns and foreign keys are not read, so
relationships *between* entities are not established. Markdown prose is not interpreted — the
headings say what a document covers, not what it says. Shell control flow is not followed.

**Unsupported formats degrade gracefully rather than silently.** Ansible, Helm before rendering,
Kustomize, Bazel, CMake, Gradle DSL, systemd units, nginx configuration, OpenAPI and JSON Schema *as
schemas*, protobuf, notebooks and every binary format have no reader. Each is still recorded with
its family, its language and its position, and carries a boundary sentence saying no reader exists.

**Reference resolution resolves to files.** A path naming a directory — a `tsconfig` project
reference, a build context — stays unresolved, as does a path into a build output that is not in the
repository. Those are reported as unresolved references rather than dropped.

**Repository classification is a judgement.** The repository *type* is derived from routes,
manifests and role annotations, and it can be wrong — a collection of sample applications with real
routes may be described as an application. The directory-map *category* (`codebase`, `monorepo`,
`collection`, `infrastructure`, `umbrella`) is derived independently for this reason.

**Grounding is not a proof system.** It checks that every name an answer uses exists in the facts it
was given, and that a small set of specific claim shapes are licensed. It cannot detect a wrong claim
about a real relationship — an answer saying `[f12]` proves X when it proves Y passes. One corrective
pass runs at most.

**Answer quality depends on the model and the machine.** A small model produces weaker answers, and
CPU-only inference is slow. TraceIQ reports the verdict rather than hiding it: a weak answer is
labelled, not laundered.

**Rescanning is whole-repository.** There is no incremental analysis, and node identity is derived
from location, so a rename reads as a delete plus a create.

---

## Privacy

With the default Docker setup, **repository analysis and inference both happen on your machine**.
Ollama runs as a container in the stack, the model is downloaded from Ollama's registry to a local
volume, and prompts go to `http://ollama:11434` on the Compose network. No repository content is
sent to a hosted model API.

Two things do leave your machine, and both are explicit:

- **Pulling a model** downloads it from Ollama's registry.
- **Analysing a GitHub URL** clones that repository over HTTPS from GitHub.

If you point `TRACEIQ_OLLAMA_URL` at a remote provider, evidence goes there instead. That is your
configuration, not the default.

Note also that only *facts* reach a prompt — identifiers, counts, relationships and short evidence
strings — never file contents. A test asserts it directly: it answers a question about a repository
whose source it knows, then checks that no line of that source appears in the prompt. The one
deliberate exclusion further down is environment variable **values**, which are never read into the
graph at all.

---

## Configuration reference

Every variable has a working default; `.env` is optional. Copy the template only to change
something:

```bash
cp .env.example .env
```

| Variable | Default | What it does |
|---|---|---|
| `TRACEIQ_MODEL` | *(empty)* | The model that answers. Empty disables chat and nothing else. `qwen2.5:7b-instruct` is verified. |
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

The API also reads `TRACEIQ_DB` (graph path), `TRACEIQ_OLLAMA_URL` (provider address),
`TRACEIQ_ANALYSIS_CONCURRENCY`, `TRACEIQ_ANALYSIS_TIMEOUT_MS` and `TRACEIQ_WORKER_HEAP_MB`. The
Compose file sets the first two for you.

---

## Documentation

| | |
|---|---|
| [`docs/progress.md`](docs/progress.md) | The full engineering record — every milestone, every defect found and fixed, every measurement and decision |
| [`docs/04-graph-spec.md`](docs/04-graph-spec.md) | The graph specification: node kinds, relationships, confidence, provenance |
| `packages/*/README.md` | Per-package purpose, boundaries and limitations |
| [`apps/api/README.md`](apps/api/README.md) · [`apps/web/README.md`](apps/web/README.md) · [`apps/cli/README.md`](apps/cli/README.md) | Interface reference |
| <http://localhost:3000/openapi.json> | Generated from the endpoint table, so it cannot drift from the routes |
| [`.env.example`](.env.example) | Every configuration variable, with the reasoning behind each default |

---

## License

**Not yet chosen.** There is no `LICENSE` file and no `license` field in `package.json`, so the
default applies: all rights reserved, and no permission is granted to use, copy, modify or
distribute this code.

---

<div align="center">

**TraceIQ** — every value shown exists in the repository graph.

</div>
