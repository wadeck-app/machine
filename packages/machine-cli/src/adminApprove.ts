import { existsSync } from 'node:fs';
import { candidacyCode, finalCode, isUuid, machineNameProblem, tryKeyId } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, type Prompt } from './admin.js';
import { NotInitializedError } from './errors.js';
import { exportMachineInfo, importPeer, registerMachine, type PeerBundle } from './network.js';
import { createRelayClient, normalizeRelayUrl, RelayError, type RelayClient } from './relayClient.js';
import { readRelayAdminConfig, relayAdminFile, writeRelayAdminConfig } from './relayStore.js';

// Admin side of the enrollment by candidacy (decisions 35, 35a, 37): list what machines asked to join, recompute the
// verification code from the key and random AS RECEIVED (the relay is untrusted, a code string it sends proves
// nothing; shown as information and checked against any code the relay sends), ask a plain "approve this machine?",
// sign the registration and send the decision, then print the FINAL code: the one human comparison (decision 50).
// A different final code on the new machine means a swapped key: `machine admin revoke <name>`.

const MAX_APPROVAL_BYTES = 16 * 1024;

// ---- admin login: the full-access token of the relay console ----

export interface AdminLoginOptions {
  code: string;
  relayUrl: string;
  force: boolean;
  /** Tests inject a client; the default talks to the relay over the network. */
  client?: RelayClient;
  now?: () => Date;
}

/**
 * Claim a pairing code that gives a FULL-ACCESS token (the opposite of `join`, which refuses one) and store it in
 * `_secrets_/relay-admin.json`. A machine-scoped token is refused by the client: it could neither list nor decide.
 */
export async function adminLogin(configDir: string, options: AdminLoginOptions): Promise<{ relayUrl: string; label: string }> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  // Before the one-shot code is spent.
  if (readRelayAdminConfig(configDir) !== undefined && !options.force) {
    throw new Error(`this machine already holds an admin relay token (${relayAdminFile(configDir)}): pass --force with a new pairing code to replace it (the old token is then forgotten, not revoked: revoke it in the relay console)`);
  }
  const client = options.client ?? createRelayClient({ baseUrl: relayUrl });
  const claimed = await client.claimPairing(options.code, 'full');
  const claimedAt = (options.now?.() ?? new Date()).toISOString();
  try {
    writeRelayAdminConfig(configDir, { relayUrl, token: claimed.token, label: claimed.label, claimedAt }, options.force);
  } catch (e) {
    throw new Error(`the pairing code was claimed but the token could not be saved (${(e as Error).message}): the code is used up and the token is lost; revoke it in the relay console and open a new pairing`);
  }
  return { relayUrl, label: claimed.label };
}

// ---- reviewing what the relay lists ----

export interface CandidacyView {
  id: string;
  name: string;
  hostname: string;
  identityPublicKey: string;
  random: string;
  observedIp: string;
  createdAt: number;
  expiresAt: number;
  uuid: string | undefined;
  /** Recomputed here from identityPublicKey and random, never taken from the relay. */
  code: string;
  /** Why this candidacy must not be approved (reject stays possible). */
  blockers: string[];
}

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
/** Text coming from the relay or from the candidate is shown with printable ASCII only: no escape sequence reaches the terminal. */
const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');
// Fields in which a relay (or its web UI) might hand over a code of its own: compared, never trusted.
const RELAY_CODE_FIELDS = ['code', 'verificationCode', 'candidacyCode'];

export function reviewCandidacy(raw: unknown, nowSeconds: number): CandidacyView {
  const o = asObject(raw);
  const blockers: string[] = [];
  const text = (key: string): string => {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0) {
      blockers.push(`the relay sent no "${key}"`);
      return '';
    }
    return v;
  };
  const num = (key: string): number => {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      blockers.push(`the relay sent no "${key}"`);
      return 0;
    }
    return v;
  };
  const id = text('id');
  const name = text('name');
  const hostname = typeof o.hostname === 'string' ? o.hostname : '';
  const identityPublicKey = text('identityPublicKey');
  const random = text('random');
  const observedIp = typeof o.observedIp === 'string' ? o.observedIp : '';
  const createdAt = num('createdAt');
  const expiresAt = num('expiresAt');

  if (name !== '') {
    const problem = machineNameProblem(name);
    if (problem) blockers.push(`the machine name is invalid (${problem})`);
  }
  if (identityPublicKey !== '' && tryKeyId(identityPublicKey) === undefined) blockers.push('identityPublicKey is not an Ed25519 public key');

  let code = '(cannot be computed)';
  if (identityPublicKey !== '' && random !== '') {
    try {
      code = candidacyCode(identityPublicKey, random);
    } catch (e) {
      blockers.push(`the verification code cannot be computed from the key and random of the relay (${(e as Error).message})`);
    }
  }
  for (const field of RELAY_CODE_FIELDS) {
    const given = o[field];
    if (typeof given === 'string' && code !== '(cannot be computed)' && normalizeCode(given) !== normalizeCode(code)) {
      blockers.push(
        `the relay sent a verification code (${printable(given)}) that does not match the key and random it sent (they give ${code}): the relay is inconsistent or swapped the key; do NOT approve`,
      );
    }
  }

  let uuid: string | undefined;
  if (o.uuid === undefined) {
    blockers.push('the relay candidacy carries no uuid yet: the relay must be updated to include it (relay-api.md, Approval section, open point), this machine cannot sign a registration without inventing one');
  } else if (typeof o.uuid !== 'string' || !isUuid(o.uuid) || o.uuid !== o.uuid.toLowerCase()) {
    blockers.push('the uuid sent by the relay is not a lower-case UUID');
  } else {
    uuid = o.uuid;
  }
  if (expiresAt !== 0 && nowSeconds >= expiresAt) blockers.push(`this candidacy expired at ${iso(expiresAt)}: the candidate must post a new one (\`machine join --resume\`)`);

  return { id, name, hostname, identityPublicKey, random, observedIp, createdAt, expiresAt, uuid, code, blockers };
}

const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

function age(nowSeconds: number, createdAt: number): string {
  const seconds = Math.max(0, nowSeconds - createdAt);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function formatList(views: CandidacyView[], nowSeconds: number): string {
  const lines = [`${views.length} pending candidacy(ies); approve one with \`machine admin approve <id>\` (a unique prefix of the id is enough):`];
  for (const v of views) {
    lines.push('', `  ${printable(v.id)}  ${printable(v.name)}  host ${printable(v.hostname)}  from ${printable(v.observedIp)}  age ${age(nowSeconds, v.createdAt)}  code ${v.code}`);
    for (const b of v.blockers) lines.push(`    [warn] cannot be approved: ${b}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatDetail(v: CandidacyView, nowSeconds: number): string {
  return [
    `Candidacy ${printable(v.id)}`,
    `  name       ${printable(v.name)}`,
    `  hostname   ${printable(v.hostname)} (declared by the machine, informative only)`,
    `  seen from  ${printable(v.observedIp)} (seen by the relay, informative only)`,
    `  uuid       ${v.uuid ?? '(missing)'}`,
    `  created    ${iso(v.createdAt)} (${age(nowSeconds, v.createdAt)} ago), expires ${iso(v.expiresAt)}`,
    '',
    'Verification code, recomputed here from the key and random received (information only, nothing to compare now; the one comparison comes after signing):',
    '',
    `  ${v.code}`,
    '',
    '',
  ].join('\n');
}

// ---- the approval ----

export interface ApproveOptions {
  /** Candidacy id or unique prefix. Absent: list. */
  id?: string;
  /** Absent: the relay of the saved admin token; a different one is refused. */
  relayUrl?: string;
  days: number;
  reject: boolean;
  /** Hidden passphrase prompt. */
  prompt: Prompt;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  /** Human text (stdout, or stderr with --json). */
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  client?: RelayClient;
}

export type ApproveResult =
  | { kind: 'list'; candidacies: CandidacyView[] }
  | { kind: 'rejected'; candidacy: CandidacyView }
  | { kind: 'approved'; candidacy: CandidacyView; finalCode: string; adminKeyId: string; registered: { uuid: string; name: string } };

/** The token of relay-admin.json is refused: say how to replace it instead of the generic machine-token advice. */
function adminRelayError(e: unknown): unknown {
  if (!(e instanceof RelayError)) return e;
  if (e.status === 401) {
    return new Error(`the relay refused the admin token (invalid or revoked)${e.humanText ? `: ${e.humanText}` : ''}: open a new full-access pairing in the relay console and run \`machine admin login <code> --force\``);
  }
  if (e.code === 'full_access_required') {
    return new Error('the token saved by `machine admin login` is not a full-access token, so it cannot list or decide candidacies: open a pairing WITHOUT "Limited to scopes" in the relay console and run `machine admin login <code> --force`');
  }
  return e;
}

async function viaAdminToken<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw adminRelayError(e);
  }
}

function pick(views: CandidacyView[], id: string): CandidacyView {
  const exact = views.filter((v) => v.id === id);
  const matches = exact.length > 0 ? exact : views.filter((v) => v.id.startsWith(id));
  if (matches.length === 0) {
    throw new Error(`no pending candidacy matches "${id}": run \`machine admin approve\` without an id to list them (a candidacy lives 15 minutes; the candidate can run \`machine join --resume\` to post a new one)`);
  }
  if (matches.length > 1) {
    throw new Error(`"${id}" matches ${matches.length} candidacies (${matches.map((m) => printable(m.id)).join(', ')}): type more characters of the id`);
  }
  return matches[0] as CandidacyView;
}

export async function runApprove(configDir: string, o: ApproveOptions): Promise<ApproveResult> {
  if (!existsSync(adminKeyFile(configDir))) {
    throw new Error(`this machine has no admin key (${adminKeyFile(configDir)} does not exist): run \`machine admin init\` here, or run this command on the machine that holds the admin key`);
  }
  const pin = readAdminPin(configDir);
  const config = readRelayAdminConfig(configDir);
  if (config === undefined) {
    throw new Error(`no admin relay token on this machine (${relayAdminFile(configDir)} does not exist): open a full-access pairing in the relay console (Tokens, Add token, WITHOUT "Limited to scopes") and run \`machine admin login <code>\``);
  }
  if (o.relayUrl !== undefined && normalizeRelayUrl(o.relayUrl) !== config.relayUrl) {
    throw new Error(`the saved admin token belongs to ${config.relayUrl}, not ${normalizeRelayUrl(o.relayUrl)}: drop --relay, or run \`machine admin login <code> --relay <url> --force\``);
  }
  const client = o.client ?? createRelayClient({ baseUrl: config.relayUrl, token: config.token });

  const listed = await viaAdminToken(() => client.listCandidacies());
  const views = listed.map((c) => reviewCandidacy(c, o.now()));

  if (o.id === undefined) {
    if (views.length === 0) o.say('no pending candidacy\n');
    else o.say(formatList(views, o.now()));
    return { kind: 'list', candidacies: views };
  }

  const view = pick(views, o.id);
  o.say(formatDetail(view, o.now()));

  if (o.reject) {
    await viaAdminToken(() => client.decideCandidacy(view.id, { decision: 'reject' }));
    o.say(`[ok] candidacy ${printable(view.id)} rejected: the candidate is told on its next check\n`);
    return { kind: 'rejected', candidacy: view };
  }

  if (view.blockers.length > 0) {
    throw new Error(`refusing to approve ${printable(view.id)}: ${view.blockers.join('; ')}. Nothing was signed or sent (\`machine admin approve ${printable(view.id)} --reject\` rejects it)`);
  }
  const uuid = view.uuid as string;

  let answer: string;
  try {
    answer = await o.ask(`Approve this machine: "${printable(view.name)}", hostname ${printable(view.hostname)}, from ${printable(view.observedIp)}? [y/N] `);
  } catch {
    throw new Error(
      `no terminal to confirm "${printable(view.name)}": approving always needs a person at a terminal and there is no option to skip the question. Run \`machine admin approve ${printable(view.id)}\` in a terminal window`,
    );
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not approved: the machine was not confirmed. Nothing was signed or sent');

  // One passphrase typed, used for both registrations of this command, then dropped with the process.
  let typed: string | undefined;
  const prompt: Prompt = async (label) => (typed ??= await o.prompt(label));
  o.say('Enter the admin passphrase to sign this registration, Ctrl-C to cancel.\n');
  const self = await registerMachine(configDir, { v: 1, uuid, name: view.name, identityPublicKey: view.identityPublicKey }, { now: o.now, prompt, validForDays: o.days });

  // The candidate also gets this machine as a peer, with the SAME pair secret, and this machine trusts the candidate with it
  // (the pairing of `machine admin register --secret-from`). The pair secrets this machine shares with its existing peers
  // are not given to a third machine.
  const peers: PeerBundle[] = [];
  let adminSelfImported = false;
  try {
    const adminInfo = exportMachineInfo(configDir);
    if (adminInfo.uuid === uuid) throw new Error('the candidate has the uuid of this machine');
    peers.push(await registerMachine(configDir, adminInfo, { now: o.now, prompt, validForDays: o.days, pairSecret: self.pairSecret }));
    adminSelfImported = true;
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
    o.say('[warn] this machine has no identity (`machine init`): the candidate is enrolled without this machine as a peer\n');
  }

  const approval = { v: 1, self, admin: { v: 1, adminPublicKey: pin.adminPublicKey, adminKeyId: pin.adminKeyId }, peers };
  const size = Buffer.byteLength(JSON.stringify(approval));
  if (size > MAX_APPROVAL_BYTES) throw new Error(`the approval is ${size} bytes, the relay accepts ${MAX_APPROVAL_BYTES}: nothing was sent`);

  // Trust the candidate here BEFORE telling the relay: when the decision fails, the extra entry is harmless (a key a human
  // verified), while the opposite order could leave an enrolled machine that this one does not know.
  if (adminSelfImported) importPeer(configDir, self, { now: o.now() });
  try {
    await viaAdminToken(() => client.decideCandidacy(view.id, { decision: 'approve', approval }));
  } catch (e) {
    throw new Error(`${(e as Error).message}. The candidate was NOT approved${adminSelfImported ? `; its registration was already added to the peers of this machine (harmless, the candidate cannot use it before it is enrolled)` : ''}. Run \`machine admin approve\` again to see whether the candidacy is still pending`);
  }

  const code = finalCode(view.identityPublicKey, pin.adminPublicKey, view.random);
  o.say(
    `[ok] "${printable(view.name)}" approved for ${o.days} day(s), registered with admin key ${pin.adminKeyId}.\n` +
      `Final code (admin key ${pin.adminKeyId}):\n\n  ${code}\n\n` +
      `On the new machine, the code must read exactly this. If it differs, run: machine admin revoke ${printable(view.name)}\n`,
  );
  return { kind: 'approved', candidacy: view, finalCode: code, adminKeyId: pin.adminKeyId, registered: { uuid: self.registration.body.uuid, name: self.registration.body.name } };
}
