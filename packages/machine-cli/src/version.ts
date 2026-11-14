import { readFileSync } from 'node:fs';

/**
 * Version of this package. Read from package.json next to the sources; when the CLI is bundled (WP9) the bundler must
 * inline it instead. A missing or unreadable file is an error, never a made-up version.
 */
export function appVersion(): string {
  const file = new URL('../package.json', import.meta.url);
  try {
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    if (typeof version !== 'string' || version.length === 0) throw new Error('no "version" field');
    return version;
  } catch (e) {
    throw new Error(`cannot determine the machine version from ${file.pathname}: ${(e as Error).message}`);
  }
}
