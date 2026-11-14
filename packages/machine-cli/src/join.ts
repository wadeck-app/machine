import { hostname as osHostname } from 'node:os';
import { candidacyCode, finalCode, newCandidacyRandom } from '@wadeck-app/machine-core';
import { applyApproval, checkApproval, isAlreadyPinned } from './approval.js';
import type { Timing } from './cliTypes.js';
import { exportMachineInfo, type MachineInfo } from './network.js';
import { createRelayClient, normalizeRelayUrl, RelayError, type RelayClient } from './relayClient.js';
import { deleteCandidacy, readCandidacy, readRelayConfig, relayFile, writeCandidacy, writeRelayConfig, candidacyFile, type CandidacyState } from './relayStore.js';

export const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_MS = 3_000;
// Used when the relay rate limits without saying for how long.
const DEFAULT_RETRY_MS = 30_000;

export interface JoinOptions {
  code: string;
  relayUrl: string;
  force: boolean;
  /** Tests inject a client; the default talks to the relay over the network. */
  client?: RelayClient;
  now?: () => Date;
  hostname?: () => string;
}

export interface JoinResult {
  relayUrl: string;
  label: string;
  name: string;
  candidacyId: string;
  /** Verification code, to compare with the one the admin sees (decision 35a). */
  verificationCode: string;
  expiresAt: number;
}

/** Printable ASCII only, 1 to 64 characters (relay-api.md field rules): the hostname is informative, never trusted. */
export function sanitizeHostname(raw: string): string {
  const clean = raw.replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 64);
  return clean.length > 0 ? clean : 'unknown';
}

/** Post a fresh candidacy (new random) and remember it, so that `--resume` can continue later. */
async function postNewCandidacy(configDir: string, client: RelayClient, info: MachineInfo, hostname: () => string): Promise<CandidacyState> {
  const random = newCandidacyRandom();
  // Canonical lower-case: the relay refuses anything else, and the admin signs the registration for exactly this uuid.
  const uuid = info.uuid.toLowerCase();
  const posted = await client.postCandidacy({ name: info.name, hostname: sanitizeHostname(hostname()), identityPublicKey: info.identityPublicKey, random, uuid });
  const state: CandidacyState = { v: 1, id: posted.id, random, name: info.name, identityPublicKey: info.identityPublicKey, createdAt: posted.createdAt, expiresAt: posted.expiresAt, uuid };
  writeCandidacy(configDir, state);
  return state;
}

const resultOf = (relayUrl: string, label: string, state: CandidacyState): JoinResult => ({
  relayUrl,
  label,
  name: state.name,
  candidacyId: state.id,
  verificationCode: candidacyCode(state.identityPublicKey, state.random),
  expiresAt: state.expiresAt,
});

/**
 * Claim the pairing code, store the machine token, then post this machine's candidacy. The identity is read first so
 * that a machine without identity does not burn a one-shot code.
 */
export async function joinRelay(configDir: string, options: JoinOptions): Promise<JoinResult> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  // Throws NotInitializedError with the fix when `machine init` was not run.
  const info = exportMachineInfo(configDir);
  refuseIfAlreadyJoined(configDir, options.force);

  const claimClient = options.client ?? createRelayClient({ baseUrl: relayUrl });
  const claimed = await claimClient.claimPairing(options.code);
  return storeTokenAndPost(configDir, relayUrl, claimed, info, options);
}

function refuseIfAlreadyJoined(configDir: string, force: boolean): void {
  if (readRelayConfig(configDir) !== undefined && !force) {
    throw new Error(
      `this machine already joined a relay (${relayFile(configDir)}): run \`machine join --resume\` to continue with the saved token, or pass --force to join again and replace it (the old token is then forgotten, not revoked: revoke it in the relay console)`,
    );
  }
}

/** Store the claimed token (the same way for a pairing code and for a device login), then post this machine's candidacy. */
async function storeTokenAndPost(configDir: string, relayUrl: string, claimed: { token: string; label: string }, info: MachineInfo, options: Pick<JoinOptions, 'force' | 'client' | 'now' | 'hostname'>): Promise<JoinResult> {
  const claimedAt = (options.now?.() ?? new Date()).toISOString();
  writeRelayConfig(configDir, { relayUrl, token: claimed.token, label: claimed.label, claimedAt }, options.force);
  // A candidacy of the previous token is of no use any more.
  deleteCandidacy(configDir);

  const client = options.client ?? createRelayClient({ baseUrl: relayUrl, token: claimed.token });
  let state: CandidacyState;
  try {
    state = await postNewCandidacy(configDir, client, info, options.hostname ?? osHostname);
  } catch (e) {
    throw new Error(
      `the token was claimed and saved in ${relayFile(configDir)}, but the candidacy could not be posted: ${(e as Error).message}. Run \`machine join --resume\` to post it again with the saved token`,
    );
  }
  return resultOf(relayUrl, claimed.label, state);
}

// ---- Device login: the relay token without a pairing code (decision 50, layer 1) ----

// The relay answers `slow_down` below 2.5 s: never poll faster than this, whatever the relay announces.
export const MIN_DEVICE_POLL_MS = 3_000;
// Used when the relay rate limits without saying for how long.
const DEFAULT_DEVICE_RETRY_MS = 30_000;
// The relay says `expired` itself; this only stops a relay that never does.
const DEVICE_EXPIRY_GRACE_MS = 5_000;

/** The label asked for the token: the machine name restricted to letters, digits, space and `_ . -`, 1 to 64 characters. */
export function deviceLabel(machineName: string): string {
  const clean = machineName.replace(/[^A-Za-z0-9 _.-]/g, '-').trim().slice(0, 64);
  return clean.length > 0 ? clean : 'machine';
}

/**
 * `machine join` argument: made only of digits (spaces and hyphens allowed, as in `1234 5678`) it is a pairing code,
 * anything else is a relay, either a URL or a bare host (`relay.example.test` means `https://relay.example.test`).
 */
export type JoinArgument = { kind: 'code'; code: string } | { kind: 'relay'; relayUrl: string };
export function classifyJoinArgument(argument: string): JoinArgument {
  const text = argument.trim();
  if (text.length === 0) throw new Error('the argument of `machine join` is empty: give a relay host or URL (or nothing for the default relay), or an 8-digit pairing code');
  if (/^[\d\s-]+$/.test(text)) return { kind: 'code', code: text };
  return { kind: 'relay', relayUrl: /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}` };
}

/** Text from the relay shown on a terminal: printable ASCII only, no escape sequence gets through. */
const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');

export interface DeviceLoginOptions {
  relayUrl: string;
  force: boolean;
  timing: Timing;
  /** Human text (stdout, or stderr with --json). */
  say: (text: string) => void;
  client?: RelayClient;
  now?: () => Date;
  hostname?: () => string;
}

/**
 * Get the machine token by device login: the user types nothing here, they type the code shown on the console page of
 * the relay. The deviceCode lives in this function only (never printed, never written, so an interrupted join leaves
 * nothing behind and starts over). Nothing is stored before the relay delivered a token with scopes exactly ["machine"].
 */
export async function joinWithDeviceLogin(configDir: string, options: DeviceLoginOptions): Promise<JoinResult> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const info = exportMachineInfo(configDir);
  refuseIfAlreadyJoined(configDir, options.force);
  const { timing, say } = options;
  const publicClient = options.client ?? createRelayClient({ baseUrl: relayUrl });

  const started = await publicClient.deviceLoginStart(deviceLabel(info.name));
  const { deviceCode, userCode, verificationUrl } = started;
  say(
    `Relay access for "${deviceLabel(info.name)}" on ${relayUrl}. Approve it in the relay console:\n\n` +
      `${printable(userCode)}\n\n${printable(verificationUrl)}\n\n` +
      `Open that page, check that the address and label match this machine, and type this code to approve\n\n`,
  );

  let intervalMs = Math.max(MIN_DEVICE_POLL_MS, Math.ceil(started.pollIntervalSeconds * 1000));
  const deadline = timing.nowMs() + started.expiresIn * 1000;
  const restart = 'run `machine join` again for a new code';
  // Slept before every poll, the first one included: never faster than the interval.
  let wait = intervalMs;
  for (;;) {
    await timing.sleep(wait, timing.signal);
    wait = intervalMs;
    if (timing.signal?.aborted) {
      throw new Error(`interrupted: nothing was stored and the code ${printable(userCode)} is dropped (a device login cannot be resumed): ${restart}`);
    }
    if (timing.nowMs() >= deadline + DEVICE_EXPIRY_GRACE_MS) {
      throw new Error(`the code ${printable(userCode)} expired before it was approved (it lives ${Math.round(started.expiresIn / 60)} min) and nothing was stored: ${restart}`);
    }
    try {
      const polled = await publicClient.deviceLoginPoll(deviceCode);
      if (polled.status === 'approved') {
        say('[ok] relay access approved\n');
        // The token is delivered once: a failed write loses it, which is said plainly.
        const claimed = { token: polled.token, label: polled.label };
        try {
          return await storeTokenAndPost(configDir, relayUrl, claimed, info, options);
        } catch (e) {
          if (readRelayConfig(configDir)?.token === polled.token) throw e;
          throw new Error(`the relay delivered a token but it could not be saved (${(e as Error).message}): the token is lost. Revoke "${printable(polled.label)}" in the relay console (Tokens), then ${restart}`);
        }
      }
      if (polled.status === 'denied') {
        throw new Error(`the request was denied in the relay console: nothing was stored. If it was a mistake, ${restart}`);
      }
      if (polled.status === 'expired') {
        throw new Error(`the code ${printable(userCode)} expired (or was already used) before it was approved: nothing was stored: ${restart}`);
      }
      if (polled.status === 'slow_down') {
        wait = Math.max(polled.retryAfterSeconds !== undefined ? polled.retryAfterSeconds * 1000 : intervalMs * 2, intervalMs);
        // Stay slower from now on.
        intervalMs = wait;
        say(`[warn] the relay asks for fewer checks: next check in ${Math.ceil(wait / 1000)} s\n`);
      }
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      if (e.status === 429) {
        wait = Math.max(e.retryAfterSeconds !== undefined ? e.retryAfterSeconds * 1000 : DEFAULT_DEVICE_RETRY_MS, intervalMs);
        say(`[warn] the relay is rate limiting: next check in ${Math.ceil(wait / 1000)} s\n`);
      } else if (e.status === 0 || e.status >= 500) {
        say(`[warn] ${e.message} (still waiting, retrying)\n`);
      } else {
        throw e;
      }
    }
  }
}

// ---- Waiting for the decision ----

export const realTiming = (): Timing => ({
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
  nowMs: () => Date.now(),
  pollIntervalMs: DEFAULT_POLL_MS,
});

export type WaitOutcome = { kind: 'approved'; approval: unknown } | { kind: 'rejected' } | { kind: 'expired' } | { kind: 'timeout' } | { kind: 'interrupted' };

/**
 * Poll the candidacy until the admin decided, it expired (404), the timeout elapsed or the signal fired. Retry-After of
 * a 429 is honoured; a network failure or a 5xx is reported and retried until the deadline; anything else (revoked
 * token, 403) ends the wait with its own actionable message.
 */
export async function waitForDecision(
  client: RelayClient,
  id: string,
  options: { timing: Timing; timeoutMs: number; signal?: AbortSignal; warn: (text: string) => void },
): Promise<WaitOutcome> {
  const { timing, signal } = options;
  const deadline = timing.nowMs() + options.timeoutMs;
  for (;;) {
    if (signal?.aborted) return { kind: 'interrupted' };
    let wait = timing.pollIntervalMs;
    try {
      const status = await client.getCandidacy(id);
      if (status.status === 'approved') return { kind: 'approved', approval: status.approval };
      if (status.status === 'rejected') return { kind: 'rejected' };
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      if (e.status === 404) return { kind: 'expired' };
      if (e.status === 429) {
        wait = Math.max(e.retryAfterSeconds !== undefined ? e.retryAfterSeconds * 1000 : DEFAULT_RETRY_MS, 0);
        options.warn(`[warn] the relay is rate limiting: next check in ${Math.ceil(wait / 1000)} s`);
      } else if (e.status === 0 || e.status >= 500) {
        options.warn(`[warn] ${e.message} (still waiting, retrying)`);
      } else {
        throw e;
      }
    }
    if (signal?.aborted) return { kind: 'interrupted' };
    const remaining = deadline - timing.nowMs();
    if (remaining <= 0) return { kind: 'timeout' };
    if (wait >= remaining) {
      await timing.sleep(remaining, signal);
      return signal?.aborted ? { kind: 'interrupted' } : { kind: 'timeout' };
    }
    await timing.sleep(wait, signal);
  }
}

// ---- The whole flow ----

export interface FlowOptions {
  /** Pairing code. Absent: the relay token comes from a device login (or from the saved token with `resume`). */
  code?: string;
  resume: boolean;
  /** Absent: the relay of the saved token (resume) or the default relay. */
  relayUrl?: string;
  defaultRelayUrl: string;
  force: boolean;
  wait: boolean;
  timeoutMs: number;
  /** Final code the admin read out, for a script without terminal (T-05: compared by a human before it is passed). */
  yesFinalCode?: string;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  timing: Timing;
  client?: RelayClient;
  now?: () => Date;
  hostname?: () => string;
  /** Human text of the progress (stdout, or stderr with --json). */
  say: (text: string) => void;
  /** Where the candidacy is announced, with its verification code. */
  onPosted: (info: JoinResult & { resumed: boolean }) => void;
}

export interface Enrolled {
  adminKeyId: string;
  adminPublicKey: string;
  finalCode: string;
  self: { uuid: string; name: string };
  peers: { uuid: string; name: string }[];
}

export type FlowResult = { status: 'posted'; posted: JoinResult } | { status: 'enrolled'; posted: JoinResult; enrolled: Enrolled };

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();
const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

export async function runJoin(configDir: string, o: FlowOptions): Promise<FlowResult> {
  const info = exportMachineInfo(configDir);
  const hostname = o.hostname ?? osHostname;
  let relayUrl: string;
  let label: string;
  let client: RelayClient;
  let state: CandidacyState;
  let resumed = false;

  if (o.resume) {
    const config = readRelayConfig(configDir);
    if (config === undefined) {
      throw new Error(`no relay token on this machine (${relayFile(configDir)} does not exist): run \`machine join\` (device login, approved in the relay console) or \`machine join <code>\` with a pairing code from the admin`);
    }
    if (o.relayUrl !== undefined && normalizeRelayUrl(o.relayUrl) !== config.relayUrl) {
      throw new Error(`the saved token belongs to ${config.relayUrl}, not ${normalizeRelayUrl(o.relayUrl)}: drop --relay, or run \`machine join <code> --relay <url> --force\` to replace the token`);
    }
    relayUrl = config.relayUrl;
    label = config.label;
    client = o.client ?? createRelayClient({ baseUrl: relayUrl, token: config.token });
    const saved = readCandidacy(configDir);
    // A candidacy saved by an older version was posted without the uuid: it cannot be approved, so a new one carries it.
    if (saved !== undefined && saved.uuid !== undefined) {
      state = saved;
    } else {
      state = await postNewCandidacy(configDir, client, info, hostname);
    }
    resumed = true;
  } else {
    const common = {
      relayUrl: o.relayUrl ?? o.defaultRelayUrl,
      force: o.force,
      ...(o.client ? { client: o.client } : {}),
      ...(o.now ? { now: o.now } : {}),
      hostname,
    };
    // No pairing code: device login, the user approves in the relay console.
    const joined = o.code !== undefined ? await joinRelay(configDir, { ...common, code: o.code }) : await joinWithDeviceLogin(configDir, { ...common, timing: o.timing, say: o.say });
    relayUrl = joined.relayUrl;
    label = joined.label;
    client = o.client ?? createRelayClient({ baseUrl: relayUrl, token: (readRelayConfig(configDir) as NonNullable<ReturnType<typeof readRelayConfig>>).token });
    state = readCandidacy(configDir) as CandidacyState;
  }

  o.onPosted({ ...resultOf(relayUrl, label, state), resumed });
  const posted = resultOf(relayUrl, label, state);
  if (!o.wait) return { status: 'posted', posted };

  const stopped = (why: string) =>
    new Error(`${why}: the token is saved and the candidacy ${state.id} stays valid until ${iso(state.expiresAt)}. Run \`machine join --resume\` to keep waiting (verification code ${candidacyCode(state.identityPublicKey, state.random)})`);

  for (let attempt = 0; state.approval === undefined; attempt++) {
    o.say(`Waiting for the admin to approve (up to ${Math.round(o.timeoutMs / 60_000)} min, Ctrl-C to stop; \`machine join --resume\` continues later)...\n`);
    const outcome = await waitForDecision(client, state.id, { timing: o.timing, timeoutMs: o.timeoutMs, ...(o.timing.signal ? { signal: o.timing.signal } : {}), warn: (t) => o.say(`${t}\n`) });
    if (outcome.kind === 'approved') {
      // Kept before anything is verified or asked: the relay drops an approved entry after 5 minutes.
      // An approved answer without approval is kept as null: refused by the check, never polled again.
      state = { ...state, approval: outcome.approval ?? null };
      writeCandidacy(configDir, state);
    } else if (outcome.kind === 'rejected') {
      deleteCandidacy(configDir);
      throw new Error(`the admin rejected this candidacy. The token is kept: if it was a mistake, ask the admin, then run \`machine join --resume\` to post a new candidacy`);
    } else if (outcome.kind === 'expired') {
      deleteCandidacy(configDir);
      if (!o.resume || attempt > 0) {
        throw new Error('the candidacy expired before the admin decided (it lives 15 minutes). The token is kept: run `machine join --resume` to post a new candidacy, then tell the admin to compare the new verification code');
      }
      // Resume: the old candidacy is gone, a new one with a fresh random replaces it.
      o.say('[warn] the previous candidacy expired: posting a new one (new verification code)\n');
      state = await postNewCandidacy(configDir, client, info, hostname);
      o.onPosted({ ...resultOf(relayUrl, label, state), resumed: true });
    } else if (outcome.kind === 'timeout') {
      throw stopped(`no decision after ${Math.round(o.timeoutMs / 1000)} s`);
    } else {
      throw stopped('interrupted');
    }
  }

  const enrolled = await enroll(configDir, state, info, o);
  return { status: 'enrolled', posted, enrolled };
}

async function enroll(configDir: string, state: CandidacyState, info: MachineInfo, o: FlowOptions): Promise<Enrolled> {
  const now = Math.floor((o.now?.() ?? new Date()).getTime() / 1000);
  let checked;
  try {
    checked = checkApproval(state.approval, info, now);
  } catch (e) {
    // An approval that does not verify is useless: dropped, so that --resume posts a fresh candidacy.
    deleteCandidacy(configDir);
    throw new Error(`${(e as Error).message}. Nothing was pinned or imported. Do not trust this approval: tell the admin, then run \`machine join --resume\` to post a new candidacy`);
  }

  const code = finalCode(info.identityPublicKey, checked.admin.adminPublicKey, state.random);
  // Throws when another admin key is already pinned: before the human is asked anything.
  const alreadyPinned = isAlreadyPinned(configDir, checked);
  if (!alreadyPinned) {
    o.say(`The admin approved this machine. Final code, it must be exactly the one the admin sees (admin key ${checked.admin.adminKeyId}):\n\n  ${code}\n\n`);
    const keep = `The approval is kept in ${candidacyFile(configDir)}: run \`machine join --resume\` once you can answer`;
    if (o.yesFinalCode !== undefined) {
      if (normalizeCode(o.yesFinalCode) !== normalizeCode(code)) {
        throw new Error(`--yes-final-code ${o.yesFinalCode} does not match the final code ${code}: the admin key was NOT pinned. Either you mistyped it, or the admin key offered here is not the one of the admin (a swapped key): ask the admin to read the code again. ${keep}`);
      }
    } else {
      let answer: string;
      try {
        answer = await o.ask(`Is this the code shown to the admin? Pin the admin key ${checked.admin.adminKeyId}? [y/N] `);
      } catch {
        throw new Error(`no terminal to confirm the final code ${code}: the admin key was NOT pinned. Compare it with the admin, then run \`machine join --resume --yes-final-code ${code}\`. ${keep}`);
      }
      if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error(`final code not confirmed: the admin key was NOT pinned. ${keep}`);
    }
  }

  applyApproval(configDir, checked, now);
  deleteCandidacy(configDir);
  return {
    adminKeyId: checked.admin.adminKeyId,
    adminPublicKey: checked.admin.adminPublicKey,
    finalCode: code,
    self: { uuid: checked.selfBody.uuid, name: checked.selfBody.name },
    peers: checked.peerBodies.map((b) => ({ uuid: b.uuid, name: b.name })),
  };
}
