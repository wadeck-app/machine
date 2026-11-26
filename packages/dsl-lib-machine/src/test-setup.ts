import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { adminKeyHolder } from './lib/adminKeyHolder.js';
import { signingsSettled } from './lib/allowFlow.js';
import { lifetimeMemory } from './lib/quickAllow.js';

// The unlocked-key holder and the last lifetime picked are module-level singletons: no test may leave a key (or a choice) to the next one.
afterEach(async () => {
  cleanup();
  // A signing that outlives its test (the dialog closes when the signing is SUBMITTED, the unlock takes about a second) would post through the fetcher of the
  // NEXT test and keep an unlocked key in the holder: wait for it before the holder is reset.
  await signingsSettled();
  adminKeyHolder.reset();
  lifetimeMemory.reset();
});

// Radix primitives (the dsl-ui Switch and RadioGroup) measure their elements with ResizeObserver, which jsdom does not provide.
(globalThis as typeof globalThis & { ResizeObserver: unknown }).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
