# syntax=docker/dockerfile:1

# The TraceIQ web application.
#
# Built from the **workspace root**, for the same reason the API is: this is a pnpm workspace.
#
#   docker build -f apps/web/Dockerfile -t traceiq-web .
#
# The runtime stage carries Next's `standalone` output — the traced server and only the files it loads. No
# package manager, no install, no workspace symlinks.

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

# `next build` needs no compiler, but the workspace install does: `better-sqlite3` is a dependency of a
# sibling package and pnpm installs the whole workspace. Cheaper to provide the toolchain than to fight it.
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG PNPM_VERSION=11.15.0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json           packages/types/
COPY packages/shared/package.json          packages/shared/
COPY packages/scanner/package.json         packages/scanner/
COPY packages/technology/package.json      packages/technology/
COPY packages/artifact/package.json        packages/artifact/
COPY packages/project-host/package.json    packages/project-host/
COPY packages/ir/package.json              packages/ir/
COPY packages/resolver/package.json        packages/resolver/
COPY packages/graph-api/package.json       packages/graph-api/
COPY packages/graph/package.json           packages/graph/
COPY packages/call-graph/package.json      packages/call-graph/
COPY packages/framework/package.json       packages/framework/
COPY packages/tree-sitter/package.json     packages/tree-sitter/
COPY packages/python/package.json          packages/python/
COPY packages/java/package.json            packages/java/
COPY packages/go/package.json              packages/go/
COPY packages/analyzer/package.json        packages/analyzer/
COPY packages/query/package.json           packages/query/
COPY packages/explain/package.json         packages/explain/
COPY packages/impact/package.json          packages/impact/
COPY packages/health/package.json          packages/health/
COPY packages/explorer/package.json        packages/explorer/
COPY packages/navigation/package.json      packages/navigation/
COPY packages/pipeline/package.json        packages/pipeline/
COPY packages/analysis/package.json        packages/analysis/
COPY packages/context/package.json         packages/context/
COPY packages/ai/package.json              packages/ai/
COPY packages/ai-ollama/package.json       packages/ai-ollama/
COPY packages/bench/package.json           packages/bench/
COPY apps/api/package.json                 apps/api/
COPY apps/cli/package.json                 apps/cli/
COPY apps/web/package.json                 apps/web/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
  pnpm config set store-dir /pnpm-store \
  && pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY apps/web/ apps/web/

# Where the browser's `/api/*` calls are forwarded.
#
# **This is a build-time value, not a runtime one.** Next compiles `rewrites()` into
# `.next/routes-manifest.json`, so the destination is fixed when the image is built and setting
# `TRACEIQ_API_URL` on the container has no effect on it. The default is the Compose service name, which is
# what makes `docker compose up` work unconfigured; point it elsewhere with
# `--build-arg TRACEIQ_API_URL=…`.
ARG TRACEIQ_API_URL=http://api:3000
ENV TRACEIQ_API_URL=${TRACEIQ_API_URL}

# The app's own typecheck is a separate script and is not part of `next build` — see next.config.mjs for why
# Next's built-in check is disabled. Running it here keeps a type error from reaching an image.
RUN pnpm --filter @traceiq/web exec tsc -p tsconfig.json --noEmit \
  && pnpm --filter @traceiq/web exec next build

# ---------------------------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-trixie-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# `standalone` writes the workspace layout it traced, so the server sits at `apps/web/server.js` with a
# top-level `node_modules` beside it. Both are copied as they are; rearranging them breaks the trace.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
# Static assets and the public directory are deliberately outside the traced bundle and have to come along
# separately, or every stylesheet and chunk 404s.
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node

# `HOSTNAME` matters: the standalone server binds to it, and left unset some Next versions bind to
# `localhost`, which is unreachable from outside the container. `3001` keeps the API's documented `3000` free
# so both can run on a host without a port clash.
ENV PORT=3001 \
    HOSTNAME=0.0.0.0

EXPOSE 3001

# The dashboard is prerendered and needs no API to answer, so a 200 here means the server is serving. Whether
# the API behind it is up is the API's own health check to report.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
