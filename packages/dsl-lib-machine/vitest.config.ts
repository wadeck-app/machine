import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// jsdom suite for the React components. machine-webcrypto is imported from source and writes its relative imports with a
// ".js" extension, so the plugin below maps them to the .ts file next to it (same trick as dsl-lib-orch).
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'resolve-js-to-ts',
      enforce: 'pre',
      resolveId(id, importer) {
        if (!importer || !id.startsWith('.') || !id.endsWith('.js')) return;
        const abs = path.resolve(path.dirname(importer), id);
        const tsx = abs.replace(/\.js$/, '.tsx');
        const ts = abs.replace(/\.js$/, '.ts');
        if (fs.existsSync(tsx)) return tsx;
        if (fs.existsSync(ts)) return ts;
      },
    },
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    restoreMocks: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Timeouts guard against a test that HANGS (PBKDF2 unlock), never a performance limit.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
