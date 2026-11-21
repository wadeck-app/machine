import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The updater bundle sits next to the bundle (the daemon and `cli update` look for it there). */
export const UPDATER_BUNDLE_FILE = 'machine-updater.cjs';

const common = (version: string) => ({
  bundle: true,
  format: 'cjs' as const,
  platform: 'node' as const,
  target: 'node24',
  // Sources use import.meta.url (the version fallback, the launcher lookup); in a CommonJS bundle it is the file itself.
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl', __MACHINE_VERSION__: JSON.stringify(version) },
  logLevel: 'warning' as const,
  supported: { 'top-level-await': false },
});

/**
 * Bundle the CLI and the daemon into ONE self-contained CommonJS file (the pattern of queue and orch), and the updater into a
 * second one next to it. The version is inlined in both: a bundle never reads a package.json next to it.
 * Returns the path of the updater bundle.
 */
export async function bundleMachine(options: { outfile: string; version: string }): Promise<{ updater: string }> {
  await build({ ...common(options.version), entryPoints: [fileURLToPath(new URL('./bin.ts', import.meta.url))], outfile: options.outfile });
  const updater = join(dirname(options.outfile), UPDATER_BUNDLE_FILE);
  await build({ ...common(options.version), entryPoints: [fileURLToPath(new URL('./updater/entry.ts', import.meta.url))], outfile: updater });
  return { updater };
}
