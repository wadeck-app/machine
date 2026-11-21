// The PIN-aware fetcher and the PIN dialog of the app-core shell, for a component that calls a route the module declared `sensitive`.
//
// This is the same contract as `@wadeck-app/app-core-sdk/shell` (appFetcher, elevate): the shell puts `{ elevate, fetcher }` under a key of globalThis
// at startup, and a component reaches it there. It is written here, not imported, because the app-core-sdk installed in this repository predates that
// entry (the `/shell` export exists from 2026.11.20); replace this file by `import { appFetcher, elevate } from '@wadeck-app/app-core-sdk/shell'` once
// the dependency is updated. There is NO fallback to a plain `fetch`: a sensitive route without the shell's token would only answer 401, and a silent
// retry outside the shell would hide that the PIN was never asked.

/** The key of globalThis where the shell puts its API (the shell and the SDK keep the same literal). */
export const APP_CORE_SHELL_GLOBAL = '__APP_CORE_SHELL__';

/** The shape of dsl-renderer's Fetcher: `url` is "METHOD /path". */
export type AppFetcher = (url: string, params?: Record<string, string>, body?: unknown, extraHeaders?: Record<string, string>) => Promise<unknown>;

interface ShellApi {
  elevate: () => Promise<void>;
  fetcher: AppFetcher;
}

function fromShell<K extends keyof ShellApi>(key: K, publicName: string): ShellApi[K] {
  const api: unknown = Reflect.get(globalThis, APP_CORE_SHELL_GLOBAL);
  const found = typeof api === 'object' && api !== null ? (api as Partial<ShellApi>)[key] : undefined;
  if (typeof found !== 'function') {
    throw new Error(`the app-core shell does not provide ${publicName}(): update app-core (\`app-core-cli update\`) and reload the page. The Allow button signs through a route that needs the app-core PIN.`);
  }
  return found as ShellApi[K];
}

/** Opens the PIN dialog if needed and resolves when the shell holds an access token. Rejects with "Sensitive action cancelled: PIN not entered" when cancelled. */
export function elevate(): Promise<void> {
  return fromShell('elevate', 'elevate')();
}

/** The fetcher of the pages of the shell: Bearer token, refresh, PIN dialog and one retry on a sensitive route. */
export function appFetcher(url: string, params?: Record<string, string>, body?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
  return fromShell('fetcher', 'appFetcher')(url, params, body, extraHeaders);
}
