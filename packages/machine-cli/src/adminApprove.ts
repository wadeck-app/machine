import { adminLoginFix, capitalized, ADMIN_TOKEN_WHY } from './adminAccess.js';
import { existsSync } from 'node:fs';
import { candidacyCode, finalCode, isUuid, machineNameProblem, tryKeyId } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { sealBundle } from './approval.js';
import { distributeAdminRenewal, distributeMachine, formatDistribution, type DistributionReport, type FormattedDistribution } from './distribute.js';
import { expiryText, whenText } from './humanTime.js';
import { PromptTimeoutError } from './prompt.js';
import { NotInitializedError } from './errors.js';
import { exportMachineInfo, importPeer, installedRevocations, loadNetwork, registerMachine, trustedRegistrations, type MachineInfo, type PeerBundle } from './network.js';
import { viaAdminToken } from './adminRelay.js';
import { createRelayClient, normalizeRelayUrl, type RelayClient } from './relayClient.js';
import { readRelayAdminConfig, readRelayConfig, relayAdminFile, writeRelayAdminConfig } from './relayStore.js';

// Admin side of the enrollment by candidacy (decisions 35, 35a, 37): list what machines asked to join, recompute the
// verification code from the key and random AS RECEIVED (the relay is untrusted, a code string it sends proves
// nothing; shown as information and checked against any code the relay sends), ask a plain "approve this machine?",
// sign the registration and send the decision, then print the security code (the final code): the one human comparison (decisions 50, 55).
// The candidacy code is recomputed and checked but shown only with --verbose. A different security code on the new machine means a swapped key: `machine admin revoke <name>`.

const MAX_APPROVAL_BYTES = 16 * 1024;

// ---- admin login: the admin token of the relay (machine-admin scope) ----

/** The one missing step, with the exact command: the admin token is a human step in the relay console (decision 50). */
export function missingAdminTokenMessage(configDir: string, relayUrl?: string): string {
  return `no admin relay token on this machine (${relayAdminFile(configDir)} does not exist): ${ADMIN_TOKEN_WHY}. ${capitalized(adminLoginFix({ relay: relayUrl ?? '<relay-host>' }))}`;
}

export interface AdminLoginOptions {
  code: string;
  relayUrl: string;
  force: boolean;
  /** Tests inject a client; the default talks to the relay over the network. */
  client?: RelayClient;
  now?: () => Date;
}

/**
 * Claim a pairing code that gives an admin token (scopes ["machine-admin"], or full access: the opposite of `join`, which refuses both) and store
 * it in `_secrets_/relay-admin.json`. A plain machine token is refused by the client: it could neither list nor decide. `scopes` is null for a
 * full-access token, which the caller must warn about.
 */
export async function adminLogin(configDir: string, options: AdminLoginOptions): Promise<{ relayUrl: string; label: string; scopes: string[] | null }> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  // Before the one-shot code is spent.
  if (readRelayAdminConfig(configDir) !== undefined && !options.force) {
    throw new Error(`this machine already holds an admin relay token (${relayAdminFile(configDir)}): pass --force with a new pairing code to replace it (the old token is then forgotten, not revoked: revoke it in the relay console)`);
  }
  const client = options.client ?? createRelayClient({ baseUrl: relayUrl });
  const claimed = await client.claimPairing(options.code, 'admin');
  const claimedAt = (options.now?.() ?? new Date()).toISOString();
  try {
    writeRelayAdminConfig(configDir, { relayUrl, token: claimed.token, label: claimed.label, claimedAt }, options.force);
  } catch (e) {
    throw new Error(`the pairing code was claimed but the token could not be saved (${(e as Error).message}): the code is used up and the token is lost; revoke it in the relay console and open a new pairing`);
  }
  return { relayUrl, label: claimed.label, scopes: claimed.scopes };
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
  /** Relay that binds a uuid to a token at approval (relay-api.md, ownership bound at approval): the uuid is already bound. Absent: the relay did not say. */
  uuidBound: boolean | undefined;
  /** The label of the token the uuid is bound to, as the relay says it (informative only; "(revoked token)" when that token is gone). */
  boundTokenLabel: string | undefined;
  /** True: the uuid is bound to the token that posted THIS candidacy (a re-approval, not a rebind). Absent: the relay did not say. */
  boundToCandidateToken: boolean | undefined;
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
    blockers.push('the candidacy carries no uuid (posted by an older `machine join`, or the relay dropped it): this machine cannot sign a registration without inventing one. Reject it, and ask the candidate to run `machine join --resume` on the machine, which posts a new candidacy with its uuid');
  } else if (typeof o.uuid !== 'string' || !isUuid(o.uuid) || o.uuid !== o.uuid.toLowerCase()) {
    blockers.push('the uuid sent by the relay is not a lower-case UUID');
  } else {
    uuid = o.uuid;
  }
  let uuidBound: boolean | undefined;
  if (o.uuidBound !== undefined) {
    if (typeof o.uuidBound === 'boolean') uuidBound = o.uuidBound;
    else blockers.push('the relay sent an invalid "uuidBound" (not true or false): it may be an incompatible version');
  }
  let boundToCandidateToken: boolean | undefined;
  if (o.boundToCandidateToken !== undefined) {
    if (typeof o.boundToCandidateToken === 'boolean') boundToCandidateToken = o.boundToCandidateToken;
    else blockers.push('the relay sent an invalid "boundToCandidateToken" (not true or false): it may be an incompatible version');
  }
  const boundTokenLabel = typeof o.boundTokenLabel === 'string' && o.boundTokenLabel.length > 0 ? o.boundTokenLabel : undefined;
  if (expiresAt !== 0 && nowSeconds >= expiresAt) blockers.push(`this candidacy ${expiryText(expiresAt, nowSeconds)}: the candidate must post a new one (\`machine join --resume\`)`);

  return { id, name, hostname, identityPublicKey, random, observedIp, createdAt, expiresAt, uuid, uuidBound, boundTokenLabel, boundToCandidateToken, code, blockers };
}

/** A uuid bound to the token of this very candidacy: approving it again changes nothing (a re-approval). */
const isReapproval = (v: CandidacyView): boolean => v.uuidBound === true && v.boundToCandidateToken === true;

/**
 * What approving a uuid that is already bound to ANOTHER token does, to be read before answering (relay-api.md, ownership bound at approval).
 * Only when `uuidBound && !boundToCandidateToken`: a relay that does not say whom the binding is for is read the safe way (a rebind).
 */
function bindingWarning(v: CandidacyView): string | undefined {
  if (v.uuidBound !== true || v.boundToCandidateToken === true) return undefined;
  const which = v.boundTokenLabel !== undefined ? `the token labelled "${printable(v.boundTokenLabel)}"` : 'another token (the relay did not say which)';
  return `the uuid is already bound to ${which}`;
}

function age(nowSeconds: number, createdAt: number): string {
  const seconds = Math.max(0, nowSeconds - createdAt);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function formatList(views: CandidacyView[], nowSeconds: number, verbose: boolean): string {
  const lines = [`${views.length} pending candidacy(ies); approve one with \`machine admin approve <id>\` (a unique prefix of the id is enough):`];
  for (const v of views) {
    lines.push('', `  ${printable(v.id)}  ${printable(v.name)}  host ${printable(v.hostname)}  from ${printable(v.observedIp)}  age ${age(nowSeconds, v.createdAt)}${verbose ? `  candidacy code ${v.code}` : ''}`);
    const binding = bindingWarning(v);
    if (binding !== undefined) lines.push(`    [warn] ${binding}: approving replaces that binding (the old token then no longer works for this machine)`);
    for (const b of v.blockers) lines.push(`    [warn] cannot be approved: ${b}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatDetail(v: CandidacyView, nowSeconds: number, verbose: boolean): string {
  const binding = bindingWarning(v);
  return [
    `Candidacy ${printable(v.id)}`,
    `  name       ${printable(v.name)}`,
    `  hostname   ${printable(v.hostname)} (declared by the machine, informative only)`,
    `  seen from  ${printable(v.observedIp)} (seen by the relay, informative only)`,
    `  uuid       ${v.uuid ?? '(missing)'}`,
    ...(binding !== undefined ? [`  [warn] ${binding}: approving replaces that binding (the old token then no longer works for this machine)`] : []),
    ...(isReapproval(v) ? ['  binding    the uuid is already bound to the same token as this candidacy: a re-approval, nothing is rebound'] : []),
    `  created    ${whenText(v.createdAt, nowSeconds)}, ${expiryText(v.expiresAt, nowSeconds)}`,
    '',
    // Decision 55: the candidacy code is internal (recomputed here from the key and random received); the one comparison is the security code.
    ...(verbose ? ['Candidacy code (--verbose; recomputed here from the key and random received, there is nothing to compare):', '', `  ${v.code}`, ''] : []),
    `After you sign, a security code is shown here and on "${printable(v.name)}": it must read exactly the same on both.`,
    '',
    '',
  ].join('\n');
}

// ---- the approval ----

export interface ApproveOptions {
  /** Candidacy id or unique prefix. Absent: none or several are listed, exactly one is approved directly. */
  id?: string;
  /**
   * `machine join` on the machine that holds the admin key: the candidacy it just posted, approved here without the y/N question and
   * without the details (the relay's copy must match every field, or nothing is signed). The passphrase is still asked.
   */
  selfJoin?: { id: string; uuid: string; identityPublicKey: string; random: string; name: string };
  /** Absent: the relay of the saved admin token; a different one is refused. */
  relayUrl?: string;
  days: number;
  reject: boolean;
  /** Also show the candidacy code (internal by default, decision 55). */
  verbose?: boolean;
  /** Hidden passphrase prompt. */
  prompt: Prompt;
  /** Replaces the line that announces the passphrase prompt (the caller already holds the passphrase and says so itself). */
  signingNote?: string;
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
  | {
      kind: 'approved';
      candidacy: CandidacyView;
      finalCode: string;
      adminKeyId: string;
      registered: { uuid: string; name: string };
      /** What was sent to the other peers (distribution.md). A failure never undoes the approval: `formatted.failed` makes the command exit 1. */
      distribution: { report: DistributionReport | undefined; formatted: FormattedDistribution };
    };

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
    throw new Error(missingAdminTokenMessage(configDir, o.relayUrl ?? readRelayConfig(configDir)?.relayUrl));
  }
  if (o.relayUrl !== undefined && normalizeRelayUrl(o.relayUrl) !== config.relayUrl) {
    throw new Error(`the saved admin token belongs to ${config.relayUrl}, not ${normalizeRelayUrl(o.relayUrl)}: drop --relay, or replace the token: ${adminLoginFix({ relay: '<url>', force: true })}`);
  }
  const client = o.client ?? createRelayClient({ baseUrl: config.relayUrl, token: config.token });

  const listed = await viaAdminToken(() => client.listCandidacies());
  const views = listed.map((c) => reviewCandidacy(c, o.now()));

  // Without an id: none or several are listed; exactly ONE goes straight to its details (no id to copy).
  let wanted = o.id ?? o.selfJoin?.id;
  if (wanted === undefined) {
    if (views.length === 0) {
      o.say('no pending candidacy: on the new machine run `machine join <relay>` (its candidacy appears here at once), then run `machine admin approve` again\n');
      return { kind: 'list', candidacies: views };
    }
    if (views.length > 1) {
      o.say(formatList(views, o.now(), o.verbose === true));
      return { kind: 'list', candidacies: views };
    }
    wanted = (views[0] as CandidacyView).id;
    o.say('One pending candidacy: showing it (with several, `machine admin approve <id>` picks one).\n');
  }

  const view = pick(views, wanted);
  // This machine approving the candidacy it posted itself a moment ago: the relay's copy must be exactly that one.
  const joining = o.selfJoin;
  if (joining !== undefined && (view.id !== joining.id || view.uuid !== joining.uuid || view.identityPublicKey !== joining.identityPublicKey || view.random !== joining.random || view.name !== joining.name)) {
    throw new Error(`the relay lists a candidacy ${printable(view.id)} that is not the one this machine just posted (key, name, uuid or random differ): nothing was signed or sent. Do not trust this relay answer; run \`machine join --resume\` to post a new candidacy`);
  }
  // The questions can take minutes: a candidacy that expired meanwhile is not signed for (the relay would refuse the decision anyway).
  const stillPending = (when: string): void => {
    if (view.expiresAt !== 0 && o.now() >= view.expiresAt) {
      throw new Error(`the candidacy ${printable(view.id)} ${expiryText(view.expiresAt, o.now())}, ${when}: nothing was signed or sent. Ask the candidate to run \`machine join --resume\` and approve the new candidacy`);
    }
  };
  // The details of a candidacy this very command just posted are the machine's own: not repeated.
  if (joining === undefined) o.say(formatDetail(view, o.now(), o.verbose === true));
  else {
    const binding = bindingWarning(view);
    o.say(`This machine holds the admin key: approving its own candidacy "${printable(view.name)}" (nothing to compare, nobody else to ask).\n${binding !== undefined ? `[info] ${binding}: it is this machine's own uuid, its new token replaces the old binding\n` : ''}`);
  }

  if (o.reject) {
    await viaAdminToken(() => client.decideCandidacy(view.id, { decision: 'reject' }));
    o.say(`[ok] candidacy ${printable(view.id)} rejected: the candidate is told on its next check\n`);
    return { kind: 'rejected', candidacy: view };
  }

  if (view.blockers.length > 0) {
    throw new Error(`refusing to approve ${printable(view.id)}: ${view.blockers.join('; ')}. Nothing was signed or sent (\`machine admin approve ${printable(view.id)} --reject\` rejects it)`);
  }
  const uuid = view.uuid as string;

  // The very first machine of a network is its admin machine: its own candidacy is approved here, and it is no peer of itself.
  // A candidacy that takes the uuid of this machine with another key or name is not this machine (a squatter): refused before anything is asked or signed.
  let adminInfo: MachineInfo | undefined;
  try {
    adminInfo = exportMachineInfo(configDir);
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
  }
  const selfApproval = adminInfo !== undefined && adminInfo.uuid === uuid;
  if (joining !== undefined && !selfApproval) throw new Error('internal: a self-join approval was requested for a uuid that is not this machine: nothing was signed or sent');
  if (adminInfo !== undefined && selfApproval && (adminInfo.identityPublicKey !== view.identityPublicKey || adminInfo.name !== view.name)) {
    throw new Error(
      `refusing to approve ${printable(view.id)}: it claims the uuid of this machine (${uuid}) with another key or name than this machine has. Nothing was signed or sent (\`machine admin approve ${printable(view.id)} --reject\` rejects it)`,
    );
  }

  // A uuid this machine already trusts with another identity key is a replacement of the key, not a renewal: only when the relay says the
  // uuid is bound (the explicit rebind, confirmed below) is it allowed.
  const known = selfApproval ? undefined : loadNetwork(configDir, o.now()).directory.find(uuid);
  const keyChanged = known !== undefined && known.identityPublicKey !== view.identityPublicKey;
  if (keyChanged && view.uuidBound !== true) {
    throw new Error(
      `refusing to approve ${printable(view.id)}: it claims the uuid of "${printable(known?.name ?? view.name)}" (${uuid}), already trusted here, with another identity key. The relay does not say that the uuid is bound to a token (uuidBound is not true), so this cannot be told from someone taking the uuid. Nothing was signed or sent. Reject it (\`machine admin approve ${printable(view.id)} --reject\`); if the machine really has a new key, revoke the old machine (\`machine admin revoke ${printable(view.name)}\`) and enroll it again`,
    );
  }
  // A machine revoked on this machine that asks again (`join --resume` after a revoke): approving enrolls it again with a new registration.
  const revokedBefore = view.uuid === undefined ? undefined : installedRevocations(configDir).filter((entry) => entry.uuid === view.uuid).at(-1);
  if (revokedBefore !== undefined) {
    o.say(`[warn] this machine was REVOKED on this machine earlier (serial ${revokedBefore.serial}): approving it enrolls it again with a new registration. Approve only if that is what you want (\`machine admin approve ${printable(view.id)} --reject\` refuses it)\n`);
  }
  const rebind = bindingWarning(view);
  let answer: string;
  try {
    // Only the candidacy this process posted itself (checked above, field by field) is approved without the y/N question: the passphrase stays.
    if (joining !== undefined) answer = 'y';
    else answer = await o.ask(
      `Approve this machine: "${printable(view.name)}", hostname ${printable(view.hostname)}, from ${printable(view.observedIp)}${selfApproval ? ' (this is the admin machine itself: the first machine of the network)' : ''}?${rebind !== undefined ? ` WARNING: ${rebind}, approving replaces it (the old token then no longer works for this machine).` : ''}${revokedBefore !== undefined ? ' WARNING: this machine was revoked here earlier, approving enrolls it again.' : ''}${keyChanged ? ' WARNING: this uuid is already trusted here with another identity key: approving replaces the old key on this machine (it is not revoked).' : ''} [y/N] `,
    );
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new Error(
      `no terminal to confirm "${printable(view.name)}": approving always needs a person at a terminal and there is no option to skip the question. Run \`machine admin approve ${printable(view.id)}\` in a terminal window`,
    );
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not approved: the machine was not confirmed. Nothing was signed or sent');
  stillPending('while the question was open');

  // One passphrase typed, used for both registrations of this command, then dropped with the process.
  let typed: string | undefined;
  const prompt: Prompt = async (label) => (typed ??= await o.prompt(label));
  o.say(o.signingNote ?? '\nEnter the admin passphrase to sign this registration, Ctrl-C to cancel.\n');
  const self = await registerMachine(configDir, { v: 1, uuid, name: view.name, identityPublicKey: view.identityPublicKey }, { now: o.now, prompt, validForDays: o.days });

  // The candidate also gets this machine as a peer, with the SAME pair secret, and this machine trusts the candidate with it
  // (the pairing of `machine admin register --secret-from`). The pair secrets this machine shares with its existing peers
  // are not given to a third machine.
  const peers: PeerBundle[] = [];
  let adminSelfImported = false;
  let adminUuid: string | null = null;
  if (adminInfo === undefined) {
    o.say('[warn] this machine has no identity (`machine init`): the candidate is enrolled without this machine as a peer\n');
  } else {
    adminUuid = adminInfo.uuid;
    // The candidate is this machine: no peer entry, no pair secret with itself, nothing to import.
    if (!selfApproval) {
      peers.push(await registerMachine(configDir, adminInfo, { now: o.now, prompt, validForDays: o.days, pairSecret: self.pairSecret }));
      adminSelfImported = true;
    }
  }

  // The relay is untrusted and reads everything it carries: the pair secrets are sealed to the identity key of the candidate
  // (decision 22), bound to this admin machine, the candidate, the candidacy random and the entry they sit in.
  const parts = (slot: string) => ({ adminUuid, candidateUuid: uuid, random: view.random, slot });
  const sealedSelf = sealBundle(self, view.identityPublicKey, parts('self'));
  const sealedPeers = peers.map((p) => sealBundle(p, view.identityPublicKey, parts(`peer:${p.registration.body.uuid}`)));

  // `random` binds the approval to this candidacy (unsigned: the relay can set it, so it only catches old or mixed-up approvals).
  const approval = { v: 1, self: sealedSelf, admin: { v: 1, adminPublicKey: pin.adminPublicKey, adminKeyId: pin.adminKeyId }, adminUuid, peers: sealedPeers, random: view.random };
  const size = Buffer.byteLength(JSON.stringify(approval));
  if (size > MAX_APPROVAL_BYTES) throw new Error(`the approval is ${size} bytes, the relay accepts ${MAX_APPROVAL_BYTES}: nothing was sent`);

  stillPending('while the passphrase was typed');

  // Trust the candidate here BEFORE telling the relay: when the decision fails, the extra entry is harmless (a key a human
  // verified), while the opposite order could leave an enrolled machine that this one does not know.
  if (adminSelfImported) importPeer(configDir, self, { now: o.now() });
  try {
    await viaAdminToken(() => client.decideCandidacy(view.id, { decision: 'approve', approval }));
  } catch (e) {
    throw new Error(`${(e as Error).message}. The candidate was NOT approved${adminSelfImported ? `; its registration was already added to the peers of this machine (harmless, the candidate cannot use it before it is enrolled)` : ''}. Run \`machine admin approve\` again to see whether the candidacy is still pending`);
  }

  const code = finalCode(view.identityPublicKey, pin.adminPublicKey, view.random);
  if (joining !== undefined) {
    o.say(`\n[ok] "${printable(view.name)}" approved for ${o.days} day(s), registered with admin key ${pin.adminKeyId}.\n\n`);
  } else {
    o.say(
      `\n[ok] "${printable(view.name)}" approved for ${o.days} day(s), registered with admin key ${pin.adminKeyId}.\n\n` +
        `Security code of "${printable(view.name)}" (admin key ${pin.adminKeyId}):\n\n  ${code}\n\n` +
        (selfApproval
          ? 'This machine is the admin machine: it created the admin key it enrolls with, so there is no other machine to compare the code with. Run `machine join --resume` here to finish.\n'
          : `It must read exactly the same on "${printable(view.name)}". If it differs, run: machine admin revoke ${printable(view.name)}\n\n`),
    );
  }

  // Only after the decision went through: the other peers are told about the new machine (and it about them). A failure is reported
  // loudly with the retry command and never undoes the approval.
  const retry = `machine admin distribute ${uuid}`;
  let report: DistributionReport | undefined;
  let formatted: FormattedDistribution;
  if (selfApproval) {
    // A renewal of the registration of this machine: the peers must learn the new one (they learned the first when they were approved).
    // The very first approval has nobody to tell, and says nothing about it.
    const retryRenewal = 'machine join --resume, then `machine admin approve <id>` again';
    if (trustedRegistrations(configDir, o.now()).length === 0) {
      formatted = { out: '', err: '', failed: false };
    } else {
      try {
        const unlocked = await unlockAdminKey(configDir, prompt);
        report = await distributeAdminRenewal(configDir, self.registration, { client, adminPrivateKeyPkcs8: unlocked.privateKeyPkcs8, adminUuid, now: o.now });
        formatted = formatDistribution(report, 'the approval', retryRenewal);
      } catch (e) {
        formatted = {
          out: '',
          err: `[error] the other peers could not be informed about the renewal of "${printable(view.name)}": ${(e as Error).message}\n[warn] the approval stands: nothing was undone. Run \`${retryRenewal}\` to send it again; it is safe to run again\n`,
          failed: true,
        };
      }
    }
  } else if (!adminSelfImported) {
    formatted = {
      out: '',
      err: `[warn] the other peers were NOT told about "${printable(view.name)}": this machine has no identity (\`machine init\`), so the new machine is not in its peer list. They learn it only through the manual flow (\`machine admin register\`, then \`machine peer import\` on each machine)\n`,
      failed: false,
    };
  } else {
    try {
      const unlocked = await unlockAdminKey(configDir, prompt);
      report = await distributeMachine(configDir, uuid, { client, adminPrivateKeyPkcs8: unlocked.privateKeyPkcs8, adminUuid, now: o.now });
      formatted = formatDistribution(report, 'the approval', retry);
    } catch (e) {
      formatted = {
        out: '',
        err: `[error] the other peers could not be informed about "${printable(view.name)}": ${(e as Error).message}\n[warn] the approval stands: nothing was undone. Run \`${retry}\` to send what is missing; it is safe to run again\n`,
        failed: true,
      };
    }
  }
  if (formatted.out) o.say(formatted.out);
  if (keyChanged) {
    o.say(
      `[warn] the old key of "${printable(view.name)}" is replaced on this machine by the key of this candidacy, and the other peers were told the new registration. Nothing was revoked automatically: \`machine admin revoke ${printable(view.name)}\` revokes the machine (its uuid), not only the old key\n`,
    );
  }
  return {
    kind: 'approved',
    candidacy: view,
    finalCode: code,
    adminKeyId: pin.adminKeyId,
    registered: { uuid: self.registration.body.uuid, name: self.registration.body.name },
    distribution: { report, formatted },
  };
}
