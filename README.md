# TraceIQ

**Know Your Codebase.**

TraceIQ is a Repository Intelligence Platform. It understands a repository through
static analysis and stores that understanding as a Knowledge Graph, so every
feature reads structured knowledge instead of re-analysing source code.

The Repository Intelligence Engine is the product. AI is a consumer of it.

## Version 1 Scope

| | |
|---|---|
| Language | TypeScript |
| Framework | Express |
| Parser | TypeScript Compiler API via ts-morph |
| Storage | SQLite, one database per repository |

## Pipeline

```
Repository
  → Repository Scanner      inventory, project type, framework
  → Project Host            owns the ts-morph Project
  → IR Builder              language-independent facts
  → Resolver                references bound to declarations
  → Framework Extractor     Express routes, middleware, roles
  → Graph Builder           facts turned into nodes and relationships
  → Graph Store             SQLite
  → Query Engine            the only way features read the graph
  → Explain Symbol          every fact about one declaration
  → Impact Analysis         what a change to one declaration reaches
  → Repository Health       architectural health of the whole repository
  → Repository Explorer     the read layer every interface consumes
  → Repository Navigation   routes, architecture trees, dependency navigation
  → TraceIQ CLI             the first production interface
  → TraceIQ REST API        the HTTP interface every client consumes
  → Context Builder         what context belongs together for a question
  → TraceIQ Web             seven pages over the REST API
  → AI Layer                answers
```

## Layout

```
apps/cli          the command-line interface       implemented
apps/api          the REST API over HTTP           implemented
apps/web          the Next.js web application      implemented
packages/scanner  repository discovery             implemented
packages/project-host  ts-morph Project owner      implemented
packages/ir       syntax → language-independent IR implemented
packages/resolver reference binding                implemented
packages/call-graph static CALLS relationships      implemented
packages/framework Express conventions             implemented
packages/graph-api the only read path to the graph implemented
packages/graph    graph builder + SQLite store     implemented
packages/query    query engine                     implemented
packages/explain  every fact about one declaration implemented
packages/impact   dependents closure for a change implemented
packages/health   repository-wide health report    implemented
packages/explorer the read layer: navigation API   implemented
packages/navigation routes + architecture + deps   implemented
packages/pipeline scan and open a stored graph     implemented
packages/context  deterministic context composition implemented
packages/shared   stable identifiers, path rules   implemented
packages/types    domain vocabulary                implemented
```

Each package documents its own purpose, responsibilities and boundaries in its
`README.md`. Progress is tracked in [docs/progress.md](docs/progress.md).

## Requirements

Node 22 or newer, and pnpm.

## Commands

```
pnpm install
pnpm build            # tsc -b across the workspace; also the typecheck for sources
pnpm typecheck:tests  # typechecks test files, which the build excludes
pnpm test             # vitest, run against sources with no build required
pnpm clean            # tsc -b --clean
```
