import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/**
 * Bundle the CLI and the daemon into ONE self-contained CommonJS file (the pattern of queue and orch). The version is
 * inlined: a bundle never reads a package.json next to it.
 */
export async function bundleMachine(options: { outfile: string; version: string }): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('./bin.ts', import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: options.outfile,
    // Sources use import.meta.url (the version fallback); in a CommonJS bundle it is the file itself.
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': '__importMetaUrl', __MACHINE_VERSION__: JSON.stringify(options.version) },
    logLevel: 'warning',
    supported: { 'top-level-await': false },
  });
}
