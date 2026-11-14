import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write a file so that a crash never leaves a half-written one: temp file in the same folder, then rename. */
export function writeFileAtomic(file: string, content: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, file);
}
