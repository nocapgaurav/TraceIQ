import { fileURLToPath } from 'node:url';

/**
 * Where the TraceIQ REST API is listening.
 *
 * Read when this config is loaded, which for a built app is **build time**: Next compiles `rewrites()` into
 * the routes manifest, so the destination is baked and setting this on a running server changes nothing. The
 * container image therefore takes it as a build argument. It is never inlined into the browser bundle.
 */
const API_UPSTREAM = process.env.TRACEIQ_API_URL ?? 'http://127.0.0.1:3000';

/**
 * The web app talks to the API over HTTP and nothing else.
 *
 * No `transpilePackages` and no alias pointing into `packages/` — the frontend must not import a backend
 * package, and the only contract between them is the REST surface.
 *
 * **Plain `.mjs`, not `.ts`.** Next loads a TypeScript config through the workspace's own `typescript`
 * package, and this repository is on TypeScript 7, whose API that loader does not yet understand — it
 * fails with `Cannot read properties of undefined (reading 'fileExists')`. A `.mjs` config is loaded by
 * Node directly and sidesteps it.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  reactStrictMode: true,

  /**
   * A self-contained server bundle, for the container image.
   *
   * Without this the runtime image would need the whole workspace `node_modules` — hundreds of megabytes of
   * symlinks into a pnpm store that the image would also have to carry. `standalone` traces only the files
   * the server actually loads and copies them, so the runtime stage needs no package manager and no install.
   *
   * `outputFileTracingRoot` must point at the workspace root: this is a pnpm monorepo, so the files Next
   * traces live above `apps/web`, and without it the trace stops at this package and the bundle is missing
   * its dependencies.
   */
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),

  /**
   * The API proxy.
   *
   * **This exists because of CORS, not for convenience.** The TraceIQ API sends no
   * `Access-Control-Allow-Origin` header — reasonably, since it was built for the CLI and for
   * server-side consumers — so a browser refuses every cross-origin request to it before one is even
   * sent. The API is frozen for this milestone, so the frontend makes its calls same-origin and Next
   * forwards them. Nothing is rewritten but the host: the path, query string and method pass through, so
   * the browser and the CLI see the identical REST surface.
   *
   * `:path*` keeps slashes, which matters because a `file:` path and a `sym:` identifier both contain
   * them and the API matches them with wildcards.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_UPSTREAM}/:path*` }];
  },

  /**
   * How long the proxy tolerates silence from the API.
   *
   * **Raised, but the heartbeat is what actually fixes this and the order matters.** Next applies its
   * default as `proxyReq.setTimeout(30000, …)` in `router-utils/proxy-request` — a socket *inactivity*
   * timeout, not a total duration — and answering one question was measured spending 89 seconds
   * between the last preparatory frame and the first token, all of it the model reading the prompt at
   * 45.75 tokens per second.
   *
   * Three options were compared:
   *
   * - **Raising this alone.** Fixes the development stack and nothing else. Every other hop a
   *   deployment puts in front of the API — nginx's 60-second `proxy_read_timeout`, a managed edge's
   *   idle limit, a corporate proxy — has its own timeout that this repository cannot configure, and
   *   the same stream dies there instead. It also makes the one honest signal worse: with no ceiling
   *   at all, a genuinely dead API is indistinguishable from a slow one, forever.
   * - **Heartbeat frames alone.** Fixes every hop at once, because every one of them resets on bytes
   *   flowing. This is the portable answer and it is what `HEARTBEAT_MS` in the API's `sse.ts` does,
   *   writing an SSE comment every ten seconds — under a third of the tightest timeout in a realistic
   *   chain. It needs no configuration anywhere and works behind proxies nobody here has heard of.
   * - **Both**, which is what is done. The heartbeat is the correctness mechanism; this stays finite
   *   and becomes purely a dead-upstream detector. Two minutes is far above the ten-second heartbeat,
   *   so it can only fire when the API has genuinely stopped writing — which is exactly when a client
   *   should be told rather than left hanging.
   */
  experimental: { proxyTimeout: 120_000 },

  /**
   * The `@/…` alias, declared here as well as in `tsconfig.json`.
   *
   * Next normally reads `paths` out of the tsconfig, but it parses that file with the same TypeScript
   * package the config loader uses — so on TypeScript 7 the alias never reaches the bundler and every
   * import fails to resolve. Declaring it directly removes the dependency on that path. The tsconfig
   * copy stays, because the editor and `tsc` read it.
   */
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    };

    return webpackConfig;
  },

  turbopack: {
    resolveAlias: { '@/*': './src/*' },
  },

  /**
   * `tsc -p tsconfig.json --noEmit` is this app's typecheck, run as its own `pnpm typecheck` script.
   * Next's built-in check is disabled because it drives TypeScript through the same incompatible loader
   * and cannot run here at all — not because type errors are tolerated.
   */
  typescript: { ignoreBuildErrors: true },

  /**
   * Next's lint step also loads TypeScript through the unsupported API and aborts the build with
   * "TypeScript 7.0.2 is not supported by this version of Next.js". This repository has no ESLint
   * configuration at all — correctness is enforced by `tsc` under `strict`,
   * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, plus the test suite.
   */
  eslint: { ignoreDuringBuilds: true },
};

export default config;
