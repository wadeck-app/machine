import { hostname as osHostname } from 'node:os';
import { adminLogin } from './adminApprove.js';
import type { Timing } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { FULL_ACCESS_PARAGRAPH, FULL_ACCESS_WHY, pairingLoginFix } from './fullAccess.js';
import { awaitDeviceApproval, deviceLabel, MAX_DEVICE_LOGIN_SECONDS, printable } from './join.js';
import { PromptTimeoutError } from './prompt.js';
import { createRelayClient, FullAccessLoginUnsupportedError, normalizeRelayUrl, type RelayClient } from './relayClient.js';
import { readRelayAdminConfig, relayAdminFile, writeRelayAdminConfig } from './relayStore.js';

// `machine admin login` without a code and the full-access step of `machine setup` (decision 58): the admin confirms a request in the relay
// console by typing the code the CLI shows (nothing to copy). A relay that predates the feature answers 400 invalid_body to the `access`
// field: then, loudly, the pairing code path of `adminLogin` is used.

/** The label of the request: names the machine, so that it is told apart from the machine login of the same computer in the console. */
export const adminLoginLabel = (machineName: string): string => `machine admin on ${deviceLabel(machineName).slice(0, 40)}`;

/** The person cannot be asked the pairing code (no terminal): the message names the commands to run. */
export class AdminLoginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminLoginInputError';
  }
}

export interface AdminConsoleLoginOptions {
  relayUrl: string;
  force: boolean;
  /** The machine name or the computer name: it goes in the label of the request. */
  name: string;
  timing: Timing;
  /** Human text (stdout, or stderr with --json). */
  say: (text: string) => void;
  /** Asks for the pairing code, only when the relay does not support the full-access login. */
  askPairingCode: () => Promise<string>;
  /** How to start over, for the end of every error (default: run `machine admin login` again). */
  restart?: string;
  client?: RelayClient;
  now?: () => Date;
}

export interface AdminConsoleLoginResult {
  relayUrl: string;
  label: string;
  /** True when the relay did not support the confirm-only login and a pairing code was used. */
  viaPairingCode: boolean;
}

export async function adminLoginByConsole(configDir: string, o: AdminConsoleLoginOptions): Promise<AdminConsoleLoginResult> {
  const relayUrl = normalizeRelayUrl(o.relayUrl);
  // Before anything is sent.
  if (readRelayAdminConfig(configDir) !== undefined && !o.force) {
    throw new Error(`this machine already holds an admin relay token (${relayAdminFile(configDir)}): pass --force to replace it (the old token is then forgotten, not revoked: revoke it in the relay console)`);
  }
  const client = o.client ?? createRelayClient({ baseUrl: relayUrl });
  const label = adminLoginLabel(o.name);
  let started;
  try {
    started = await client.deviceLoginStart(label, 'full');
  } catch (e) {
    if (e instanceof FullAccessLoginUnsupportedError) return await pairingFallback(configDir, o, relayUrl, client, e);
    throw e;
  }

  const minutes = Math.max(1, Math.round(Math.min(started.expiresIn, MAX_DEVICE_LOGIN_SECONDS) / 60));
  o.say(
    `Admin login on ${relayUrl} (FULL ACCESS): ${FULL_ACCESS_WHY}.\n\n` +
      `Code to type in the relay console (nothing to copy, it is not a secret):\n\n` +
      `  ${printable(started.userCode)}\n\n` +
      `In the relay console open Tokens: the request "${label}" is listed there, marked FULL ACCESS. Type the code and approve it.\n` +
      `Relay page: ${printable(started.verificationUrl)}\n` +
      `Check that the address and the label match this machine before you approve.\n\n` +
      `Waiting for the approval in the relay console (up to ${minutes} min, Ctrl-C stops it and nothing is stored).\n`,
  );
  const restart = o.restart ?? 'run `machine admin login` again for a new code';
  const polled = await awaitDeviceApproval({ client, started, access: 'full', timing: o.timing, say: o.say, restart });
  o.say('[ok] full access approved\n');
  const claimedAt = (o.now?.() ?? new Date()).toISOString();
  try {
    writeRelayAdminConfig(configDir, { relayUrl, token: polled.token, label: polled.label, claimedAt }, o.force);
  } catch (e) {
    throw new Error(`the relay delivered the admin token but it could not be saved (${(e as Error).message}): the token is lost. Revoke "${printable(polled.label)}" in the relay console (Tokens), then ${restart}`);
  }
  return { relayUrl, label: polled.label, viaPairingCode: false };
}

/** The relay is older than the full-access login: said as a warning, never silently, then the pairing code is asked. */
async function pairingFallback(configDir: string, o: AdminConsoleLoginOptions, relayUrl: string, client: RelayClient, why: FullAccessLoginUnsupportedError): Promise<AdminConsoleLoginResult> {
  o.say('[warn] this relay does not support the full-access login yet; falling back to a pairing code (tell the relay owner to update the relay)\n');
  if (why.pendingRequest) {
    o.say(`[warn] the relay started a MACHINE login named "${adminLoginLabel(o.name)}" instead: deny that request in the relay console (Tokens), it must not be approved\n`);
  }
  o.say(`\n${FULL_ACCESS_PARAGRAPH}\n\n`);
  let code: string;
  try {
    code = (await o.askPairingCode()).trim();
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new AdminLoginInputError(`no pairing code could be asked (${(e as Error).message}): this relay does not support the full-access login yet, so pass a pairing code: ${pairingLoginFix({ relay: relayUrl, ...(o.force ? { force: true } : {}) })}`);
  }
  if (code.length === 0 || code.length > 32) throw new AdminLoginInputError('the pairing code is empty or longer than 32 characters: copy it again from the relay console');
  const login = await adminLogin(configDir, { code, relayUrl, force: o.force, client, ...(o.now ? { now: o.now } : {}) });
  return { relayUrl: login.relayUrl, label: login.label, viaPairingCode: true };
}

/** The name for the label: this machine's name when it has an identity, else the computer name (`machine admin login` works without one). */
export function adminLoginName(configDir: string, hostname: () => string = osHostname): string {
  try {
    return readMachine(configDir).name;
  } catch (e) {
    if (e instanceof NotInitializedError) return hostname().split('.')[0]?.toLowerCase() || 'machine';
    throw e;
  }
}
