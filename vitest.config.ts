import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    retry: 0,
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
  },
});
