import { defineConfig } from 'vitest/config';

// Integration suite: packages the module and starts a real app-core server. Needs an app-core-cli (see README, "Tests").
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.integration.test.ts'],
    // Timeouts guard against a test that HANGS (packaging and starting app-core), never a performance limit.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
