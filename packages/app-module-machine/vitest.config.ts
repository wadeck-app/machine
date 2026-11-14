import { defineConfig } from 'vitest/config';

// Default suite: unit tests only. The real-server integration test needs an app-core-cli and runs through `npm run test:integration`
// (vitest.integration.config.ts); it is excluded here on purpose and `npm test` says so.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
