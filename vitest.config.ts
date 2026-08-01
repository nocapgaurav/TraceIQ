import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * The backend suites.
 *
 * Tests run directly against package sources so `pnpm test` never depends on a prior build. Aliases must
 * be added here as each package is initialised.
 *
 * **`apps/web` is excluded.** A component test needs jsdom, the React plugin and a DOM setup file, none
 * of which belong in a Node suite — the web app carries its own `vitest.config.ts` for that, and the root
 * `test` script runs both configs in turn. Without this exclusion the glob below would also match the web
 * app's `.test.ts` files and run them in Node with no document.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@traceiq/types': packageSource('types'),
      '@traceiq/shared': packageSource('shared'),
      '@traceiq/scanner': packageSource('scanner'),
      '@traceiq/project-host': packageSource('project-host'),
      '@traceiq/ir': packageSource('ir'),
      '@traceiq/resolver': packageSource('resolver'),
      '@traceiq/graph-api': packageSource('graph-api'),
      '@traceiq/graph': packageSource('graph'),
      '@traceiq/call-graph': packageSource('call-graph'),
      '@traceiq/framework': packageSource('framework'),
      '@traceiq/query': packageSource('query'),
      '@traceiq/explain': packageSource('explain'),
      '@traceiq/impact': packageSource('impact'),
      '@traceiq/health': packageSource('health'),
      '@traceiq/explorer': packageSource('explorer'),
      '@traceiq/navigation': packageSource('navigation'),
      '@traceiq/pipeline': packageSource('pipeline'),
      '@traceiq/bench': packageSource('bench'),
      '@traceiq/analyzer': packageSource('analyzer'),
      '@traceiq/python': packageSource('python'),
      '@traceiq/tree-sitter': packageSource('tree-sitter'),
      '@traceiq/java': packageSource('java'),
      '@traceiq/go': packageSource('go'),
      '@traceiq/context': packageSource('context'),
      // Mirrors the package's own `exports` map: the fakes and the provider contract battery
      // ship as a separate entry point so they cannot reach production code.
      '@traceiq/ai/testing': fileURLToPath(new URL('./packages/ai/src/testing.ts', import.meta.url)),
      '@traceiq/ai': packageSource('ai'),
      '@traceiq/ai-ollama': packageSource('ai-ollama'),
      '@traceiq/cli': fileURLToPath(new URL('./apps/cli/src/index.ts', import.meta.url)),
      '@traceiq/api': fileURLToPath(new URL('./apps/api/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'backend',
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/**'],
  },
});
