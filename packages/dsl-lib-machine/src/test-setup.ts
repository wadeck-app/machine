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

// The Dialog of dsl-ui moves the focus to what asks for it (the autoFocus Cancel button) in a requestAnimationFrame, about 16 ms after it opens. A test types the
// passphrase right after rendering, so the real frame would fire in the middle of the typing and send the end of it to the Cancel button (seen in the full suite:
// "Enter the admin passphrase to sign"). The frame callback runs as a microtask instead: same order as the old synchronous focus, no timing in the tests.
(globalThis as typeof globalThis & { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame = (cb) => {
  queueMicrotask(() => cb(0));
  return 0;
};
