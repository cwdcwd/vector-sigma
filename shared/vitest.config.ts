import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Coverage: `npm run test:coverage` at the root, also run in CI.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Floors (ratchet: raise as coverage rises, never lower): CI fails below them.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
