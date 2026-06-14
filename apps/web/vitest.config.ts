import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    retry: 0,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.tsx'],
    // Use 'node' environment for API tests (no React DOM needed)
    // Use 'jsdom' only for React component tests (add // @vitest-environment jsdom to those files)
    environment: 'node',
  },
});
