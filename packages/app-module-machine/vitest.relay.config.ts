import { defineConfig } from 'vitest/config';

// The module backend against the REAL relay of the poc-node repository: `npm run test:relay` (never part of `npm test`).
// Needs MACHINE_TEST_RELAY_MODULE; without it the file fails loudly.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.relaytest.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
