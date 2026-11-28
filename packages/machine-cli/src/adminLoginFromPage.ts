import { adminLoginByConsole, adminLoginName, type AdminLoginStarted } from './adminDeviceLogin.js';
import type { Timing } from './cliTypes.js';
import { realTiming } from './join.js';
import { AccessLoginUnsupportedError } from './relayClient.js';
import { readRelayAdminConfig, readRelayConfig, relayAdminFile } from './relayStore.js';

// `machine admin login` started FROM THE PAGE (admin-ui.md, "A failed source: three cases"): the Candidacies page says "this machine holds no admin relay token" and
// offers a button instead of a command to copy. The daemon runs the very same console login as the CLI (adminLoginByConsole) in the background, keeps its state in memory and
// the page reads it: the code to compare, the wait, the result. What stays the admin's: the confirmation in the relay console, comparing the code and the source address
// (T-37). What this never does: replace an existing token (the CLI has --force for that), answer the token or the device code, or keep anything before the relay delivered.

export type AdminLoginRefusal = 'already-configured' | 'token-file-invalid' | 'no-relay' | 'relay-error' | 'relay-unsupported';

export type AdminLoginAnswer =
  | { ok: true; state: 'idle' }
  | { ok: true; state: 'waiting'; userCode: string; verificationUrl: string; label: string; relayUrl: string; /** Epoch seconds. */ expiresAt: number; consoleHint: string }
  | { ok: true; state: 'approved'; label: string; scopes: string[] | null }
  | { ok: true; state: 'failed'; message: string }
  | { ok: false; reason: AdminLoginRefusal; message: string };

export interface AdminLoginDeps {
  /** Tests only: the clock of the wait (default: the real one). */
  timing?: Timing;
  hostname?: () => string;
  /** Epoch milliseconds. */
  now?: () => number;
}

export interface AdminLoginService {
  start: () => Promise<AdminLoginAnswer>;
  status: () => AdminLoginAnswer;
  cancel: () => AdminLoginAnswer;
  /** Tests only: resolves when the background wait ended. */
  settled: () => Promise<void>;
}

const replaceWith = 'run `machine admin login --force` in a terminal';

export function createAdminLoginService(configDir: string, deps: AdminLoginDeps = {}): AdminLoginService {
  let current: AdminLoginAnswer = { ok: true, state: 'idle' };
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let cancelled = false;
  const now = deps.now ?? Date.now;

  const refuse = (reason: AdminLoginRefusal, message: string): AdminLoginAnswer => ({ ok: false, reason, message });

  async function start(): Promise<AdminLoginAnswer> {
    if (current.ok && current.state === 'waiting') return current;
    let held;
    try {
      held = readRelayAdminConfig(configDir);
    } catch (e) {
      return refuse('token-file-invalid', `${(e as Error).message}. The page does not replace a token file: ${replaceWith}`);
    }
    if (held !== undefined) {
      return refuse('already-configured', `this machine already holds an admin relay token (${relayAdminFile(configDir)}): the page does not replace it; to replace it ${replaceWith}`);
    }
    let relayUrl: string | undefined;
    try {
      relayUrl = readRelayConfig(configDir)?.relayUrl;
    } catch (e) {
      return refuse('relay-error', (e as Error).message);
    }
    if (relayUrl === undefined) {
      return refuse('no-relay', 'this machine has not joined a relay yet, so there is no relay to log in to: run `machine setup <relay>` (or `machine join <relay>`) in a terminal first');
    }
    cancelled = false;
    const mine = new AbortController();
    controller = mine;
    const timing: Timing = { ...(deps.timing ?? realTiming()), signal: mine.signal };
    return await new Promise<AdminLoginAnswer>((resolve) => {
      let announced = false;
      const onStarted = (info: AdminLoginStarted): void => {
        announced = true;
        current = {
          ok: true,
          state: 'waiting',
          userCode: info.userCode,
          verificationUrl: info.verificationUrl,
          label: info.label,
          relayUrl: info.relayUrl,
          expiresAt: Math.floor(now() / 1000) + info.expiresInSeconds,
          consoleHint: `In the relay console open Tokens: the request "${info.label}" is listed there, marked MACHINE ADMIN. Compare its code with the one above, check that the source address is this computer, then approve.`,
        };
        resolve(current);
      };
      running = adminLoginByConsole(configDir, {
        relayUrl: relayUrl as string,
        force: false,
        name: adminLoginName(configDir, deps.hostname),
        timing,
        say: () => undefined,
        onStarted,
      }).then(
        (result) => {
          if (controller === mine) current = { ok: true, state: 'approved', label: result.label, scopes: result.scopes };
        },
        (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          // A newer start owns the state now (this one was cancelled): its end is of no interest.
          if (controller !== mine) return;
          if (!announced) {
            current = { ok: true, state: 'idle' };
            resolve(refuse(e instanceof AccessLoginUnsupportedError ? 'relay-unsupported' : 'relay-error', message));
            return;
          }
          // A cancel is the person's choice, not a failure.
          current = cancelled ? { ok: true, state: 'idle' } : { ok: true, state: 'failed', message };
        },
      );
    });
  }

  return {
    start,
    status: () => current,
    cancel: () => {
      if (current.ok && current.state === 'waiting') {
        cancelled = true;
        current = { ok: true, state: 'idle' };
        controller?.abort();
      }
      return current;
    },
    settled: () => running ?? Promise.resolve(),
  };
}
