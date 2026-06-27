import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Root-level vitest config so `npx vitest` works from the repo root, not just
// from apps/web/.  The src/ alias mirrors apps/web/vitest.config.ts so test
// files importing "src/..." resolve correctly regardless of cwd.
// Per UNS-110.
export default defineConfig({
  resolve: {
    alias: {
      src: resolve(__dirname, 'apps/web/src'),
    },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    retry: 0,
    include: ['apps/web/tests/**/*.test.ts', 'apps/web/tests/**/*.test.tsx', 'api/functions/**/*.test.ts'],
    environment: 'node',
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
    target: 'es2022',
  },
});
