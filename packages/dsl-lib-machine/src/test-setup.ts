import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
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

// dsl-ui's FieldReadOnly (the read-only value fields of the signing dialogs) calls useToast, which throws outside a ToastProvider. The app shell provides one
// (app-core-sdk docs/module-authoring.md); a component test renders without the shell, so the hook answers with a recording stand-in there. Nothing here toasts.
vi.mock('@wadeck-app/dsl-ui/dist/components/overlay/Toast.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@wadeck-app/dsl-ui/dist/components/overlay/Toast.js')>();
  const standIn = { success: () => undefined, error: () => undefined, info: () => undefined };
  return {
    ...original,
    useToast: () => {
      try {
        return original.useToast();
      } catch {
        return standIn;
      }
    },
  };
});
