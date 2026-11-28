import type { RouteAnswer, SignedDocumentWire, SignedRegistrationWire } from './routeContracts.js';

// The pure state machine of the Machines page (list, Revoke): what the local daemon of the admin machine holds, and what the four routes of the page answer from it. No
// React, no Node API, no import of another package (the mock of the page runs it in the browser). Every function takes the state and returns a NEW state with the
// answer: nothing is mutated. The refusal texts are the ones of the daemon (machine-cli `revokeFromPage.ts`) and the module backend (`machineRevoke.ts`,
// `index.ts`); what the backend never produces and this machine invents is marked `MOCK` below.

/** A peer this machine trusts, with what the Machines page shows of it. */
export interface PeerEntry {
  registration: SignedRegistrationWire;
  /** The key id of its identity key (fake in a seed). */
  keyId: string;
  aliases: string[];
  /** `direct`: this machine reaches it now; `unknown`: the probe has not reached it. */
  reachableState: 'direct' | 'unknown';
  reachable: string;
  receivesNotices: boolean;
  listHeldText: string;
}

/** What the scenario plans for the delivery of a revocation to the peers that stay. */
export type RevokePlan = 'delivered' | 'partial' | 'failed' | 'relay-unreachable';

export interface MachinesState {
  admin: { uuid: string; name: string; identityPublicKey: string; publicKey: string; keyId: string };
  /** The text of the encrypted admin key file served by `GET /admin-key`. */
  adminKeyFile: string;
  /** The trusted peers (this machine is not in the list). */
  peers: PeerEntry[];
  /** The revocations installed here. */
  revoked: Array<{ uuid: string; serial: number }>;
  /** Version (issuedAt) of the revocation list held here. */
  heldVersion: number;
  plan: RevokePlan;
}

export interface MachineRow {
  uuid: string;
  name: string;
  self: boolean;
  role: string;
  aliasesText: string;
  reachableState: string;
  reachable: string;
  receivesNotices: 'yes' | 'no';
  listHeldText: string;
}

export interface MachinesAnswer {
  machines: MachineRow[];
  noticesText: string;
  reachableNote?: string;
  count: number;
  enrolled: boolean;
  presenceNote: string;
}

export interface RevokeContextAnswer {
  ok: true;
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  revoked: { uuid: string; name: string; serial: number; keyId: string };
  held: { entries: Array<{ uuid: string; serial: number }>; version: number };
  recipients: SignedRegistrationWire[];
  noticeRecipients: SignedDocumentWire | null;
}

export interface RevokeRequest {
  uuid: string;
  signed: Record<string, unknown>;
  documents: Array<Record<string, unknown>>;
  noticeRecipients: Record<string, unknown> | null;
}

export interface DeliveryRow {
  uuid: string;
  name: string;
  state: 'delivered' | 'inbox' | 'failed';
  code: string;
  reason: string;
  next: string;
}

export interface RevokeApplyAnswer {
  ok: true;
  revoked: { uuid: string; name: string };
  failed: boolean;
  report: object;
  text: { out: string; err: string };
  machines: DeliveryRow[];
  retry: string;
}

export interface MachinesStep<T> {
  state: MachinesState;
  answer: RouteAnswer<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (status: number, kind: string, error: string): RouteAnswer<never> => ({ status, body: { status, kind, error, message: error } });
const ok = <T>(body: T): RouteAnswer<T> => ({ status: 200, body });
const refuse = <T>(state: MachinesState, status: number, kind: string, error: string): MachinesStep<T> => ({ state, answer: fail(status, kind, error) });

const retryOf = (uuid: string): string => `machine admin distribute ${uuid}`;
const PRESENCE_NOTE = 'Presence and addresses are not shown yet: the daemon list does not carry them (run machine list for the relay view).';

/** `GET /machines`. */
export function listMachines(state: MachinesState): MachinesStep<MachinesAnswer> {
  const self: MachineRow = { uuid: state.admin.uuid, name: state.admin.name, self: true, role: 'this machine', aliasesText: '', reachableState: 'self', reachable: 'this machine', receivesNotices: 'yes', listHeldText: 'holds the list' };
  const peers = state.peers.map((p): MachineRow => ({
    uuid: p.registration.body.uuid,
    name: p.registration.body.name,
    self: false,
    role: 'peer',
    aliasesText: p.aliases.join(', '),
    reachableState: p.reachableState,
    reachable: p.reachable,
    receivesNotices: p.receivesNotices ? 'yes' : 'no',
    listHeldText: p.listHeldText,
  }));
  const receivers = [state.admin.name, ...state.peers.filter((p) => p.receivesNotices).map((p) => p.registration.body.name)];
  return {
    state,
    answer: ok({
      machines: [self, ...peers],
      noticesText: `Request notices go to ${receivers.join(', ')} (list serial 1).`,
      count: peers.length + 1,
      enrolled: true,
      presenceNote: PRESENCE_NOTE,
    }),
  };
}

/** `GET /admin-key`. */
export function machinesAdminKey(state: MachinesState): MachinesStep<{ file: string }> {
  return { state, answer: ok({ file: state.adminKeyFile }) };
}

/** Why a machine this one does not trust cannot be revoked: already revoked here, or not a peer at all (daemon `untrusted`). */
function untrusted<T>(state: MachinesState, uuid: string, nothing: string): MachinesStep<T> {
  const entry = state.revoked.find((e) => e.uuid === uuid);
  if (entry !== undefined) {
    return refuse(state, 409, 'not-trusted', `machine ${uuid} is already revoked on this machine (serial ${entry.serial}), so there is nothing to sign. To send the revocation to the other machines again, run \`${retryOf(uuid)}\` in a terminal`);
  }
  return refuse(state, 409, 'not-trusted', `machine ${uuid} is not a trusted peer of this machine (see the Machines page, or \`machine status\`): only a machine this one trusts can be revoked. ${nothing}`);
}

/** `GET /revoke-context/:uuid`. */
export function revokeContext(state: MachinesState, uuid: string): MachinesStep<RevokeContextAnswer> {
  if (!UUID.test(uuid)) return refuse(state, 400, 'bad_request', 'expected the uuid of the machine to revoke in the path: /revoke-context/<uuid>');
  if (uuid === state.admin.uuid) {
    return refuse(state, 409, 'self', `"${state.admin.name}" is the admin machine itself: it cannot revoke itself from this page (the network would lose its admin machine). Nothing was signed`);
  }
  const peer = state.peers.find((p) => p.registration.body.uuid === uuid);
  if (peer === undefined) return untrusted(state, uuid, 'Nothing was signed');
  return {
    state,
    answer: ok({
      ok: true,
      adminMachine: { uuid: state.admin.uuid, name: state.admin.name },
      adminPublicKey: state.admin.publicKey,
      adminKeyId: state.admin.keyId,
      revoked: { uuid, name: peer.registration.body.name, serial: peer.registration.body.serial, keyId: peer.keyId },
      held: { entries: state.revoked.map((e) => ({ ...e })), version: state.heldVersion },
      recipients: state.peers.filter((p) => p.registration.body.uuid !== uuid).map((p) => p.registration),
      // MOCK: the seeds hold no list of notice recipients; the page then signs `[this machine]`.
      noticeRecipients: null,
    }),
  };
}

const APPLY_RULE = 'expected exactly {"uuid": "<uuid>", "signed": <signed revocation list>, "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null>}, nothing else: reload the page and revoke again';

/** The sentence that says why `body` is not a revocation to apply (module backend `machineRevoke.ts` parseApply), or undefined. */
function applyProblem(body: unknown): string | undefined {
  if (!isObject(body) || Object.keys(body).length !== 4 || !('uuid' in body) || !('signed' in body) || !('documents' in body) || !('noticeRecipients' in body)) return APPLY_RULE;
  if (typeof body['uuid'] !== 'string' || !UUID.test(body['uuid'])) return `"uuid" is not the uuid of the machine to revoke: ${APPLY_RULE}`;
  if (!isObject(body['signed'])) return `"signed" must be the signed revocation list: ${APPLY_RULE}`;
  if (!Array.isArray(body['documents']) || !body['documents'].every(isObject)) return `"documents" must be a list of signed documents: ${APPLY_RULE}`;
  if (body['noticeRecipients'] !== null && !isObject(body['noticeRecipients'])) return `"noticeRecipients" must be a signed list or null: ${APPLY_RULE}`;
  return undefined;
}

/** The report of the delivery the scenario plans for the peers that stay (`stay`) once `revoked` is removed. MOCK: the daemon's CLI texts, hand-written. */
function planned(plan: RevokePlan, revoked: PeerEntry, stay: PeerEntry[]): Omit<RevokeApplyAnswer, 'ok' | 'revoked' | 'retry'> {
  const uuid = revoked.registration.body.uuid;
  const retry = retryOf(uuid);
  const row = (p: PeerEntry, state: DeliveryRow['state'], code: string, reason: string, next: string): DeliveryRow => ({ uuid: p.registration.body.uuid, name: p.registration.body.name, state, code, reason, next });
  const names = stay.map((p) => p.registration.body.name);
  const stands = `[warn] the revocation stands: nothing was undone. The machines above do not know it yet (they learn it when the document reaches them). Run \`${retry}\` to send what is missing; it is safe to run again`;
  if (plan === 'delivered' || stay.length === 0 && plan !== 'relay-unreachable') {
    return {
      failed: false,
      report: {},
      text: { out: stay.length === 0 ? '[ok] no other peer to inform\n' : `${names.map((n) => `[ok] Delivered directly to ${n} (installed, 0.1 s)`).join('\n')}\n`, err: '' },
      machines: stay.map((p) => row(p, 'delivered', 'direct', 'took the documents directly', 'nothing to do')),
    };
  }
  if (plan === 'partial') {
    return {
      failed: false,
      report: {},
      text: { out: `[ok] ${stay.length} document(s) stored by the relay for ${stay.length} machine(s)\n`, err: '' },
      machines: stay.map((p) => row(p, 'inbox', 'unreachable', 'offline', 'installs by itself when it is back, nothing to do')),
    };
  }
  const why = plan === 'failed' ? 'the relay refused the document' : 'the relay is unreachable';
  const lines = [...stay.map((p) => `[error] ${p.registration.body.name} (${p.registration.body.uuid}): revocation document not stored: ${why}`), ...(plan === 'relay-unreachable' ? [`[error] ${revoked.registration.body.name} (${uuid}): not removed from the relay: ${why}`] : []), stands];
  return {
    failed: true,
    report: {},
    text: { out: '', err: `${lines.join('\n')}\n` },
    machines: [
      ...stay.map((p) => row(p, 'failed', 'not-stored', 'documents not stored', `run \`${retry}\``)),
      ...(plan === 'relay-unreachable' ? [row(revoked, 'failed', 'not-stored', 'not removed from the relay', `run \`${retry}\``)] : []),
    ],
  };
}

/** `POST /revoke`: the daemon installs the list (the peer is no longer trusted here), then the planned delivery. */
export function revokeApply(state: MachinesState, body: RevokeRequest): MachinesStep<RevokeApplyAnswer> {
  const problem = applyProblem(body);
  if (problem !== undefined) return refuse(state, 400, 'bad_request', problem);
  if (body.uuid === state.admin.uuid) return refuse(state, 409, 'self', `"${state.admin.name}" is the admin machine itself: it cannot be revoked from this page. Nothing was installed`);
  const peer = state.peers.find((p) => p.registration.body.uuid === body.uuid);
  if (peer === undefined) return untrusted(state, body.uuid, 'Nothing was installed');
  const stay = state.peers.filter((p) => p.registration.body.uuid !== body.uuid);
  const next: MachinesState = {
    ...state,
    peers: stay,
    revoked: [...state.revoked, { uuid: body.uuid, serial: peer.registration.body.serial }],
    heldVersion: state.heldVersion + 1,
  };
  return { state: next, answer: ok({ ok: true, revoked: { uuid: body.uuid, name: peer.registration.body.name }, retry: retryOf(body.uuid), ...planned(state.plan, peer, stay) }) };
}
