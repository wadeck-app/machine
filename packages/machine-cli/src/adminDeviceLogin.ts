import { hostname as osHostname } from 'node:os';
import { adminLogin } from './adminApprove.js';
import type { Timing } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { FULL_ACCESS_WARNING, FULL_PAIRING_PARAGRAPH, fullPairingFix, MACHINE_ADMIN_CHIP, machineAdminUnsupportedAdvice } from './adminAccess.js';
import { awaitDeviceApproval, deviceLabel, MAX_DEVICE_LOGIN_SECONDS, printable } from './join.js';
import { PromptTimeoutError } from './prompt.js';
import { AccessLoginUnsupportedError, createRelayClient, normalizeRelayUrl, type RelayClient } from './relayClient.js';
import { readRelayAdminConfig, readRelayConfig, relayAdminFile, relayFile, writeRelayAdminConfig, writeRelayConfig } from './relayStore.js';

// `machine admin login` without a code and the login step of `machine setup` (decision 59, which replaces decision 58): the admin confirms ONE
// request in the relay console (nothing to copy) and gets a token of the `machine-admin` scope: everything a machine token may do, plus approving
// machines, and it cannot manage tokens. A relay that predates the scope answers 400 invalid_body: this fails loudly and never falls back to full
// access by itself. A full-access token is an explicit opt-in (`--full-access`), and the pairing code stays the script path.

/** The label of the admin request: names the machine and tells it from the machine's own token in the console ("desktop admin" next to "desktop"). */
export const adminLoginLabel = (machineName: string): string => `${deviceLabel(machineName).slice(0, 58).trim()} admin`;

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
  /** Asks for the pairing code, only for `--full-access` on a relay that does not support the full-access login (absent: that fallback is not offered). */
  askPairingCode?: () => Promise<string>;
  /** How to start over, for the end of every error (default: run `machine admin login` again). */
  restart?: string;
  /** The access asked for: "machine-admin" (default) or "full" (the explicit `--full-access` opt-in). */
  access?: 'machine-admin' | 'full';
  /**
   * `machine setup` on a machine that holds no relay token yet: the SAME token is also the relay token of this machine (relay.json), so that ONE
   * confirmation does both. The label is then the machine name. The token is never printed.
   */
  asMachineToken?: boolean;
  /** `machine setup`: the advice of a relay that predates the scope also says how the setup goes on. */
  setup?: boolean;
  client?: RelayClient;
  now?: () => Date;
}

export interface AdminConsoleLoginResult {
  relayUrl: string;
  label: string;
  /** True when a pairing code was used (`--full-access` on a relay that does not support the full-access login). */
  viaPairingCode: boolean;
  /** Scopes of the saved admin token: ["machine-admin"], or null for a full-access token. */
  scopes: string[] | null;
}

export async function adminLoginByConsole(configDir: string, o: AdminConsoleLoginOptions): Promise<AdminConsoleLoginResult> {
  const relayUrl = normalizeRelayUrl(o.relayUrl);
  const access = o.access ?? 'machine-admin';
  // Before anything is sent.
  if (readRelayAdminConfig(configDir) !== undefined && !o.force) {
    throw new Error(`this machine already holds an admin relay token (${relayAdminFile(configDir)}): pass --force to replace it (the old token is then forgotten, not revoked: revoke it in the relay console)`);
  }
  if (o.asMachineToken === true && readRelayConfig(configDir) !== undefined) {
    throw new Error(`internal: this machine already holds a relay token (${relayFile(configDir)}), it must not be replaced by the admin login: nothing was sent`);
  }
  const client = o.client ?? createRelayClient({ baseUrl: relayUrl });
  const label = o.asMachineToken === true ? deviceLabel(o.name) : adminLoginLabel(o.name);
  let started;
  try {
    started = await client.deviceLoginStart(label, access);
  } catch (e) {
    if (e instanceof AccessLoginUnsupportedError) {
      // Full access was asked explicitly: the pairing code is the way for a relay that predates it (said loudly).
      if (e.access === 'full') return await pairingFallback(configDir, o, relayUrl, client, e);
      // Never a silent fallback to full access: the explicit choices are named.
      throw new AccessLoginUnsupportedError({
        status: e.status,
        ...(e.code !== undefined ? { code: e.code } : {}),
        ...(e.humanText !== undefined ? { humanText: e.humanText } : {}),
        access: e.access,
        pendingRequest: e.pendingRequest,
        message: `${e.message}. The ${machineAdminUnsupportedAdvice({ relay: relayUrl, ...(o.setup === true ? { setup: true } : {}) })}`,
      });
    }
    throw e;
  }

  const minutes = Math.max(1, Math.round(Math.min(started.expiresIn, MAX_DEVICE_LOGIN_SECONDS) / 60));
  const heading =
    access === 'full'
      ? `Admin login on ${relayUrl} (FULL ACCESS: can also manage tokens).`
      : o.asMachineToken === true
        ? `Relay login on ${relayUrl} (${MACHINE_ADMIN_CHIP}): one confirmation gives this machine its relay token and the admin rights to approve machines.`
        : `Admin login on ${relayUrl} (${MACHINE_ADMIN_CHIP}).`;
  const marked = access === 'full' ? 'FULL ACCESS' : 'MACHINE ADMIN';
  o.say(
    `${heading}\n\n` +
      `Code to ${access === 'full' ? 'type' : 'click'} in the relay console (nothing to copy, it is not a secret):\n\n` +
      `  ${printable(started.userCode)}\n\n` +
      (access === 'full'
        ? `In the relay console open Tokens: the request "${label}" is listed there, marked ${marked}. Type this code there, then approve (a full-access request has no codes to click).\n`
        : `Click the code ${printable(started.userCode)} in the relay console (the Tokens page lists the request "${label}", marked ${marked}): it must be the same as this one. A different code denies the request.\n`) +
      `Relay page: ${printable(started.verificationUrl)}\n` +
      `Check that the address and the label match this machine before you ${access === 'full' ? 'approve' : 'click'}.\n\n` +
      `Waiting for the approval in the relay console (up to ${minutes} min, Ctrl-C stops it and nothing is stored).\n`,
  );
  const restart = o.restart ?? 'run `machine admin login` again for a new code';
  const polled = await awaitDeviceApproval({ client, started, access, timing: o.timing, say: o.say, restart });
  o.say(access === 'full' ? '[ok] full access approved\n' : '[ok] machine admin access approved\n');
  const claimedAt = (o.now?.() ?? new Date()).toISOString();
  const config = { relayUrl, token: polled.token, label: polled.label, claimedAt };
  try {
    // One token, two files when it is also the machine token: the daemon reads relay.json, the admin commands read relay-admin.json.
    if (o.asMachineToken === true) writeRelayConfig(configDir, config, false);
    writeRelayAdminConfig(configDir, config, o.force);
  } catch (e) {
    throw new Error(`the relay delivered the token but it could not be saved (${(e as Error).message}): the token is lost. Revoke "${printable(polled.label)}" in the relay console (Tokens), then ${restart}`);
  }
  if (access === 'full') o.say(`${FULL_ACCESS_WARNING}\n`);
  return { relayUrl, label: polled.label, viaPairingCode: false, scopes: polled.scopes };
}

/** `--full-access` on a relay older than the full-access login: said as a warning, never silently, then the pairing code is asked. */
async function pairingFallback(configDir: string, o: AdminConsoleLoginOptions, relayUrl: string, client: RelayClient, why: AccessLoginUnsupportedError): Promise<AdminConsoleLoginResult> {
  o.say('[warn] this relay does not support the full-access login yet; falling back to a pairing code (tell the relay owner to update the relay)\n');
  if (why.pendingRequest) {
    o.say(`[warn] the relay started another login named "${o.asMachineToken === true ? deviceLabel(o.name) : adminLoginLabel(o.name)}" instead: deny that request in the relay console (Tokens), it must not be approved\n`);
  }
  o.say(`\n${FULL_PAIRING_PARAGRAPH}\n\n`);
  let code: string;
  try {
    if (o.askPairingCode === undefined) throw new Error('this command cannot ask a question');
    code = (await o.askPairingCode()).trim();
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new AdminLoginInputError(`no pairing code could be asked (${(e as Error).message}): this relay does not support the full-access login yet, so pass a pairing code: ${fullPairingFix({ relay: relayUrl, ...(o.force ? { force: true } : {}) })}`);
  }
  if (code.length === 0 || code.length > 32) throw new AdminLoginInputError('the pairing code is empty or longer than 32 characters: copy it again from the relay console');
  const login = await adminLogin(configDir, { code, relayUrl, force: o.force, client, ...(o.now ? { now: o.now } : {}) });
  if (login.scopes === null) o.say(`${FULL_ACCESS_WARNING}\n`);
  return { relayUrl: login.relayUrl, label: login.label, viaPairingCode: true, scopes: login.scopes };
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

