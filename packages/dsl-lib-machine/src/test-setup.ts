import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { adminKeyHolder } from './lib/adminKeyHolder.js';

// The unlocked-key holder is a module-level singleton: no test may leave a key (or a choice) to the next one.
afterEach(() => {
  cleanup();
  adminKeyHolder.reset();
});
