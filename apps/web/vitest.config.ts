import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Make src/ available for test imports (default tsconfig.app.json only includes 'src',
      // so Vite's resolver doesn't know about src/ from the test directory)
      src: resolve(__dirname, 'src'),
    },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    retry: 0,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Use 'node' environment for API tests (no React DOM needed)
    // Use 'jsdom' for React component tests (add `// @vitest-environment jsdom` at the top of the .tsx file)
    environment: 'node',
  },
  esbuild: {
    // Allow JSX/TSX transformation in test files (default is 'src' only via tsconfig.app.json)
    jsx: 'automatic',
    jsxImportSource: 'react',
    target: 'es2022',
  },
});
