import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    // Timeouts guard against a test that HANGS, never a performance limit.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
