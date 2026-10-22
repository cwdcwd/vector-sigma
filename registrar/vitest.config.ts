import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    // Coverage: `npm run test:coverage` at the root, also run in CI.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Thin process entry points (argv/env wiring only); their logic is exported and tested.
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Floors (ratchet: raise as coverage rises, never lower): CI fails below them.
      thresholds: { lines: 92, branches: 78, functions: 90, statements: 89 },
    },
  },
});