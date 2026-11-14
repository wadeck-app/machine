import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Replaced by the bundler (see bundle.ts): a bundle carries its version and never reads a package.json. */
declare const __MACHINE_VERSION__: string | undefined;

/**
 * Version of this package. In a bundle it is inlined; from the sources it is read from package.json next to them.
 * A missing or unreadable file is an error, never a made-up version.
 */
export function appVersion(): string {
  if (typeof __MACHINE_VERSION__ === 'string') return __MACHINE_VERSION__;
  const file = new URL('../package.json', import.meta.url);
  try {
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    if (typeof version !== 'string' || version.length === 0) throw new Error('no "version" field');
    return version;
  } catch (e) {
    throw new Error(`cannot determine the machine version from ${fileURLToPath(file)}: ${(e as Error).message}`);
  }
}
