import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Tests run directly against package sources so `pnpm test` never depends on a
 * prior build. Aliases must be added here as each package is initialised.
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
    },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
  },
});
