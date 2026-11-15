import { defineConfig } from 'vitest/config';

// Integration tests against the REAL relay of the poc-node repository: `npm run test:relay` (never part of `npm test`).
// Needs MACHINE_TEST_RELAY_MODULE (see src/relayIntegration/testRelayModule.ts); without it every file fails loudly.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/relayIntegration/**/*.relaytest.ts'],
    // One file at a time: each one starts a real relay server and in-process daemons, and the machine is a working desktop.
    fileParallelism: false,
    // Real HTTP round trips and a real server; the timeouts guard against a hang, never a performance limit.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
