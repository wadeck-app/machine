import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test helpers (named *.testUtil.ts: not a test file, never part of the module).

/** A fresh empty temp directory (mkdtemp, never a fixed name). Remove it with `removeTempDir`. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows keeps files open for a moment after a test: retry before failing. */
export function removeTempDir(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
