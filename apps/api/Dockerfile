# syntax=docker/dockerfile:1

# The TraceIQ REST API.
#
# Built from the **workspace root**, not from this directory: a pnpm workspace cannot be installed from one
# package in isolation, and the API depends on eleven sibling packages by `workspace:*`.
#
#   docker build -f apps/api/Dockerfile -t traceiq-api .
#
# Two stages. The builder installs everything, compiles TypeScript and produces a self-contained bundle; the
# runtime carries only that bundle. Both use the same base image on purpose — `better-sqlite3` is a native
# addon, and a bundle compiled against one libc and Node ABI cannot be run on another.

# ---------------------------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------------------------
# Both stages use **trixie**, not bookworm, and that is load-bearing.
#
# `better-sqlite3` ships a prebuilt `prebuilds/linux-arm64.node` and its loader prefers that over anything
# compiled locally. The prebuild is linked against GLIBC 2.38; Debian bookworm has 2.36. On bookworm the API
# therefore built cleanly, started cleanly, passed its health check — and failed every scan with
# "the database at /data/graph.db could not be opened", which names neither glibc nor the prebuild. Trixie
# ships glibc 2.41 and the prebuild loads.
FROM node:22-trixie-slim AS builder

# `better-sqlite3` has no prebuilt binary for every platform and falls back to compiling. Without these the
# install fails with a node-gyp error that names none of them.
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm, at the version the lockfile was written by. Corepack pins it from `packageManager` where present and
# from this argument otherwise, so a floating `latest` cannot change resolution between builds.
ARG PNPM_VERSION=11.15.0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

# Manifests first, so `pnpm install` is cached against dependency changes rather than source changes. Every
# workspace manifest has to be present before install, because the workspace graph is resolved from them.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json           packages/types/
COPY packages/shared/package.json          packages/shared/
COPY packages/scanner/package.json         packages/scanner/
COPY packages/project-host/package.json    packages/project-host/
COPY packages/ir/package.json              packages/ir/
COPY packages/resolver/package.json        packages/resolver/
COPY packages/graph-api/package.json       packages/graph-api/
COPY packages/graph/package.json           packages/graph/
COPY packages/call-graph/package.json      packages/call-graph/
COPY packages/framework/package.json       packages/framework/
COPY packages/query/package.json           packages/query/
COPY packages/explain/package.json         packages/explain/
COPY packages/impact/package.json          packages/impact/
COPY packages/health/package.json          packages/health/
COPY packages/explorer/package.json        packages/explorer/
COPY packages/navigation/package.json      packages/navigation/
COPY packages/pipeline/package.json        packages/pipeline/
COPY packages/context/package.json         packages/context/
COPY packages/ai/package.json              packages/ai/
COPY packages/ai-ollama/package.json       packages/ai-ollama/
COPY apps/api/package.json                 apps/api/
COPY apps/cli/package.json                 apps/cli/
COPY apps/web/package.json                 apps/web/

# `--frozen-lockfile` makes a lockfile that disagrees with a manifest a build failure rather than a silent
# resolution. `--ignore-scripts=false` is the default and is what compiles `better-sqlite3`.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
  pnpm config set store-dir /pnpm-store \
  && pnpm install --frozen-lockfile

# Source last: a source change re-runs the build and nothing before it.
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# `tsc -b` walks the project references, so this builds every package the API needs and nothing it does not.
RUN pnpm exec tsc -b apps/api

# A self-contained bundle: the API, its eleven workspace packages and their production dependencies, with no
# symlinks into a store the runtime image will not have.
#
# `--legacy` is required from pnpm 10 for a workspace that does not set `inject-workspace-packages`; `--prod`
# drops the dev tooling. The API's own `bin/traceiq-api.js` imports `@traceiq/ai-ollama`, which is why that is
# a runtime dependency and survives `--prod`.
RUN pnpm deploy --filter @traceiq/api --prod --legacy /bundle

# ---------------------------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-trixie-slim AS runtime

# `git`, because Repository Analysis clones with it.
#
# The slim image has none, and without this every analysis fails with "git is not installed on the server
# running TraceIQ" — the workflow reports that clearly, but the deployment should not need it to.
# `ca-certificates` is what lets git verify github.com over TLS; git alone would fail the handshake.
RUN apt-get update \
  && apt-get install --no-install-recommends -y git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# The graph lives on a volume, so the process must be able to write there. Node's image already has an
# unprivileged `node` user; the API needs no root at any point.
WORKDIR /app
RUN mkdir -p /data && chown -R node:node /data

COPY --from=builder --chown=node:node /bundle ./

# `/workspace` is where a repository to scan is mounted. Created here so the mount has a target even when
# nothing is mounted, and so `POST /scan` fails with a readable error rather than on a missing directory.
RUN mkdir -p /workspace && chown node:node /workspace

USER node

# Defaults chosen so the container is useful with no configuration at all: it listens on the documented port
# and writes its graph to the volume. `TRACEIQ_MODEL` is deliberately unset — see docker-compose.yml.
ENV PORT=3000 \
    TRACEIQ_DB=/data/graph.db \
    TRACEIQ_OLLAMA_URL=http://ollama:11434

EXPOSE 3000

# `/ping` is the liveness endpoint and is the right one to use: it answers without opening a graph, so an API
# that has nothing scanned yet is still reported healthy — which it is. `/health` is the repository health
# report, not a liveness check, and using it here would mark an unscanned API as broken.
#
# Node's own `fetch` rather than curl: the slim image has no curl, and adding one to serve a health check
# would be a package in the runtime image for no other reason.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/traceiq-api.js"]
