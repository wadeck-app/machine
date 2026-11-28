import type { DeliveryPlan, DeliveryRow, MachinesState, MachinesStep, PeerEntry, SignedAliasesWire } from './machinesState.js';
import type { RouteAnswer, SignedDocumentWire, SignedRegistrationWire } from './routeContracts.js';

// Rename and network aliases on the Machines page, on mock data (admin-ui.md, "Rename and aliases from the page"): the pure state machine of the four routes
// GET /rename-context/:uuid, POST /rename, GET /aliases-context and POST /aliases. Same rules as machinesState.ts: no React, no Node API, no import of another package, every
// function takes the state and returns a NEW state with the answer. The refusal texts are the ones of the daemon (machine-cli `renameFromPage.ts`, `aliasesFromPage.ts`)
// where this machine can tell them from the seed; the delivery is the one the scenario plans (`state.plan`). MOCK: no signature is checked here (the page's own code signs for
// real, see scenarioSigning.test.ts), only the shape and the rules that need no key.

/** The key under which the daemon keeps the documents of the network aliases for a retry: the same reserved uuid as machine-core `NETWORK_ALIASES_SUBJECT_UUID` (a test keeps them equal). */
export const ALIASES_SUBJECT_UUID = '00000000-0000-4000-8000-0000000a11a5';
export const ALIASES_RETRY = 'machine admin alias send';
const renameRetry = (name: string): string => `machine admin rename ${name} ${name}`;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RenameContextAnswer {
  ok: true;
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  machine: { uuid: string; name: string; serial: number; keyId: string };
  current: SignedRegistrationWire;
  machines: Array<{ uuid: string; name: string }>;
  aliases: Record<string, string>;
  networkAliases: Record<string, string>;
  revokedUpTo: number | null;
  others: SignedRegistrationWire[];
  noticeRecipients: SignedDocumentWire | null;
}

export interface RenameRequest {
  uuid: string;
  signed: { body: { uuid: string; name: string; serial: number } & Record<string, unknown>; signature: string };
  documents: Array<Record<string, unknown>>;
  noticeRecipients: Record<string, unknown> | null;
}

export interface RenameApplyAnswer {
  ok: true;
  subject: { uuid: string; name: string };
  failed: boolean;
  report: object;
  text: { out: string; err: string };
  machines: DeliveryRow[];
  retry: string;
}

export interface AliasesContextAnswer {
  ok: true;
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  current: SignedAliasesWire | null;
  machines: Array<{ uuid: string; name: string }>;
  revoked: string[];
  localAliases: Record<string, string>;
  recipients: SignedRegistrationWire[];
}

export interface AliasesRequest {
  signed: SignedAliasesWire;
  documents: Array<Record<string, unknown>>;
}

export interface AliasesApplyAnswer {
  ok: true;
  serial: number;
  entries: Array<{ alias: string; uuid: string; name?: string }>;
  changed: true;
  failed: boolean;
  report: object;
  text: { out: string; err: string };
  machines: DeliveryRow[];
  retry: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ok = <T>(body: T): RouteAnswer<T> => ({ status: 200, body });
const refuse = <T>(state: MachinesState, status: number, kind: string, error: string): MachinesStep<T> => ({ state, answer: { status, body: { status, kind, error, message: error } } });

const machinesOf = (state: MachinesState): Array<{ uuid: string; name: string }> => [
  { uuid: state.admin.uuid, name: state.admin.name },
  ...state.peers.map((p) => ({ uuid: p.registration.body.uuid, name: p.registration.body.name })),
];

/** The local aliases of this machine (alias to uuid), from the peers it knows them on. */
const localAliasesOf = (state: MachinesState): Record<string, string> => Object.fromEntries(state.peers.flatMap((p) => p.aliases.map((a) => [a, p.registration.body.uuid] as const)));

const networkMapOf = (state: MachinesState): Record<string, string> => Object.fromEntries((state.networkAliases?.body.entries ?? []).map((e) => [e.alias, e.uuid]));

/** The delivery the scenario plans for `told` (in this order). MOCK: the daemon's CLI texts, hand-written. */
function plannedFor(plan: DeliveryPlan, told: Array<{ uuid: string; name: string }>, what: string, retry: string, kindOfDocument: string): Omit<RenameApplyAnswer, 'ok' | 'subject' | 'retry'> {
  const row = (m: { uuid: string; name: string }, state: DeliveryRow['state'], code: string, reason: string, next: string): DeliveryRow => ({ uuid: m.uuid, name: m.name, state, code, reason, next });
  if (told.length === 0) {
    return { failed: false, report: {}, text: { out: '[ok] no other peer to inform\n', err: '' }, machines: [] };
  }
  if (plan === 'delivered') {
    return {
      failed: false,
      report: {},
      text: { out: `${told.map((m) => `[ok] Delivered directly to ${m.name} (installed, 0.1 s)`).join('\n')}\n`, err: '' },
      machines: told.map((m) => row(m, 'delivered', 'direct', 'took the documents directly', 'nothing to do')),
    };
  }
  if (plan === 'partial') {
    return {
      failed: false,
      report: {},
      text: { out: `[ok] ${told.length} document(s) stored by the relay for ${told.length} machine(s)\n`, err: '' },
      machines: told.map((m) => row(m, 'inbox', 'unreachable', 'offline', 'installs by itself when it is back, nothing to do')),
    };
  }
  const why = plan === 'relay-unreachable' ? 'the relay is unreachable' : 'the relay refused the document';
  const lost = plan === 'mixed' ? told.slice(1) : told;
  const stands = `[warn] ${what} stands: nothing was undone. The machines above do not know it yet (they learn it when the document reaches them). Run \`${retry}\` to send what is missing; it is safe to run again`;
  return {
    failed: true,
    report: {},
    text: {
      out: plan === 'mixed' ? `[ok] Delivered directly to ${(told[0] as { name: string }).name} (installed, 0.1 s)\n` : '',
      err: `${[...lost.map((m) => `[error] ${m.name} (${m.uuid}): ${kindOfDocument} document not stored: ${why}`), stands].join('\n')}\n`,
    },
    machines: told.map((m, i) => (plan === 'mixed' && i === 0 ? row(m, 'delivered', 'direct', 'took the documents directly', 'nothing to do') : row(m, 'failed', 'not-stored', 'documents not stored', `run \`${retry}\``))),
  };
}

/** What the daemon keeps for a retry when the delivery failed (in memory): by subject uuid. A delivery that failed nothing leaves nothing. */
function retained(state: MachinesState, subject: { uuid: string; name: string }, answer: { failed: boolean; machines: DeliveryRow[]; retry: string }): MachinesState {
  const { [subject.uuid]: _forgotten, ...others } = state.retainedDeliveries ?? {};
  return { ...state, retainedDeliveries: answer.failed ? { ...others, [subject.uuid]: { subject, machines: answer.machines, retry: answer.retry } } : others };
}

/** `GET /rename-context/:uuid`. */
export function renameContext(state: MachinesState, uuid: string): MachinesStep<RenameContextAnswer> {
  if (!UUID.test(uuid)) return refuse(state, 400, 'bad_request', 'expected the uuid of the machine to rename in the path: /rename-context/<uuid>');
  if (uuid === state.admin.uuid) {
    return refuse(
      state,
      409,
      'self',
      `"${state.admin.name}" is the admin machine itself: renaming it is not supported from this page yet (its peers would need a renewed registration of the admin machine). Rename the other machines, or enroll this one again under another name. Nothing was signed`,
    );
  }
  const peer = state.peers.find((p) => p.registration.body.uuid === uuid);
  if (peer === undefined) {
    const gone = state.revoked.find((e) => e.uuid === uuid);
    if (gone !== undefined) {
      return refuse(state, 409, 'revoked', `machine ${uuid} is revoked here (serial ${gone.serial}): a revoked machine cannot be renamed. Enroll it again (\`machine join\` there, then \`machine admin approve\` here) and it takes the name it joins with. Nothing was signed`);
    }
    return refuse(state, 409, 'not-trusted', `machine ${uuid} is not a trusted peer of this machine (see the Machines page, or \`machine status\`): only a machine this one trusts can be renamed. Nothing was signed`);
  }
  return {
    state,
    answer: ok({
      ok: true,
      adminMachine: { uuid: state.admin.uuid, name: state.admin.name },
      adminPublicKey: state.admin.publicKey,
      adminKeyId: state.admin.keyId,
      machine: { uuid, name: peer.registration.body.name, serial: peer.registration.body.serial, keyId: peer.keyId },
      current: peer.registration,
      machines: machinesOf(state),
      aliases: localAliasesOf(state),
      networkAliases: networkMapOf(state),
      revokedUpTo: null,
      others: state.peers.filter((p) => p.registration.body.uuid !== uuid).map((p) => p.registration),
      // MOCK: the seeds hold no list of notice recipients; the page then signs `[this machine]`.
      noticeRecipients: null,
    }),
  };
}

const RENAME_RULE = 'expected exactly {"uuid": "<uuid>", "signed": <signed registration>, "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null>}, nothing else: reload the page and rename again';

function renameProblem(body: unknown): string | undefined {
  if (!isObject(body) || Object.keys(body).length !== 4 || !('uuid' in body) || !('signed' in body) || !('documents' in body) || !('noticeRecipients' in body)) return RENAME_RULE;
  if (typeof body['uuid'] !== 'string' || !UUID.test(body['uuid'])) return `"uuid" is not the uuid of the machine to rename: ${RENAME_RULE}`;
  if (!isObject(body['signed']) || !isObject(body['signed']['body'])) return `"signed" must be the signed registration: ${RENAME_RULE}`;
  if (!Array.isArray(body['documents']) || !body['documents'].every(isObject)) return `"documents" must be a list of signed documents: ${RENAME_RULE}`;
  if (body['noticeRecipients'] !== null && !isObject(body['noticeRecipients'])) return `"noticeRecipients" must be a signed list or null: ${RENAME_RULE}`;
  return undefined;
}

/** `POST /rename`: the daemon trusts the re-issued registration (the new name), then the planned delivery to the other peers and to the renamed machine. */
export function renameApply(state: MachinesState, body: RenameRequest): MachinesStep<RenameApplyAnswer> {
  const problem = renameProblem(body);
  if (problem !== undefined) return refuse(state, 400, 'bad_request', problem);
  if (body.uuid === state.admin.uuid) return refuse(state, 409, 'self', `"${state.admin.name}" is the admin machine itself: it cannot be renamed from this page. Nothing was installed`);
  const index = state.peers.findIndex((p) => p.registration.body.uuid === body.uuid);
  const peer = state.peers[index];
  if (peer === undefined) {
    return refuse(state, 409, 'not-trusted', `machine ${body.uuid} is not a trusted peer of this machine (see the Machines page, or \`machine status\`): only a machine this one trusts can be renamed. Nothing was installed`);
  }
  const { name, serial, uuid } = body.signed.body;
  const stale = ': reload the page and rename again. Nothing was installed';
  if (uuid !== body.uuid) return refuse(state, 422, 'bad-registration', `the registration the page signed is for machine ${String(uuid)}, not for ${body.uuid}${stale}`);
  if (typeof name !== 'string' || !NAME.test(name)) return refuse(state, 422, 'bad-registration', `the registration the page signed carries the name ${JSON.stringify(name)}, which is not a valid machine name${stale}`);
  if (serial !== peer.registration.body.serial + 1) {
    return refuse(state, 422, 'bad-registration', `the registration the page signed has serial ${String(serial)}, but this machine holds serial ${peer.registration.body.serial} for "${peer.registration.body.name}": it must be exactly one above${stale}`);
  }
  const taken = machinesOf(state).find((m) => m.uuid !== body.uuid && m.name.toLowerCase() === name);
  if (taken !== undefined) return refuse(state, 422, 'bad-registration', `the name "${name}" is already used by machine "${taken.name}" (${taken.uuid.slice(0, 8)})${stale}`);
  const renamed: PeerEntry = { ...peer, registration: { ...peer.registration, body: { ...peer.registration.body, name, serial }, signature: String(body.signed.signature) } };
  const peers = state.peers.map((p, i) => (i === index ? renamed : p));
  const told = [...state.peers.filter((_p, i) => i !== index).map((p) => ({ uuid: p.registration.body.uuid, name: p.registration.body.name })), { uuid: body.uuid, name }];
  const retry = renameRetry(name);
  const delivery = plannedFor(state.plan, told, 'the rename', retry, 'peer');
  const subject = { uuid: body.uuid, name };
  return { state: retained({ ...state, peers }, subject, { ...delivery, retry }), answer: ok({ ok: true, subject, retry, ...delivery }) };
}

/** `GET /aliases-context`. */
export function aliasesContext(state: MachinesState): MachinesStep<AliasesContextAnswer> {
  return {
    state,
    answer: ok({
      ok: true,
      adminMachine: { uuid: state.admin.uuid, name: state.admin.name },
      adminPublicKey: state.admin.publicKey,
      adminKeyId: state.admin.keyId,
      current: state.networkAliases ?? null,
      machines: machinesOf(state),
      revoked: state.revoked.map((e) => e.uuid),
      localAliases: localAliasesOf(state),
      recipients: state.peers.map((p) => p.registration),
    }),
  };
}

const ALIASES_RULE = 'expected exactly {"signed": <signed aliases list>, "documents": [<signed inbox document>...]}, nothing else: reload the page and try again';

function aliasesProblem(body: unknown): string | undefined {
  if (!isObject(body) || Object.keys(body).length !== 2 || !('signed' in body) || !('documents' in body)) return ALIASES_RULE;
  if (!isObject(body['signed']) || !isObject(body['signed']['body']) || !Array.isArray(body['signed']['body']['entries'])) return `"signed" must be the signed aliases list: ${ALIASES_RULE}`;
  if (!Array.isArray(body['documents']) || !body['documents'].every(isObject)) return `"documents" must be a list of signed documents: ${ALIASES_RULE}`;
  return undefined;
}

/** `POST /aliases`: the daemon keeps the list the page signed (exactly one alias added or removed, a higher serial), then the planned delivery to the peers. */
export function aliasesApply(state: MachinesState, body: AliasesRequest): MachinesStep<AliasesApplyAnswer> {
  const problem = aliasesProblem(body);
  if (problem !== undefined) return refuse(state, 400, 'bad_request', problem);
  const current = state.networkAliases ?? null;
  const incoming = body.signed;
  const stale = ': reload the page and try again. Nothing was installed';
  if (current !== null && !(incoming.body.serial > current.body.serial)) {
    return refuse(state, 409, 'stale-aliases', `the list the page signed (serial ${String(incoming.body.serial)}) does not replace the one held here (serial ${current.body.serial})${stale}`);
  }
  const before = new Map((current?.body.entries ?? []).map((e) => [e.alias, e.uuid]));
  const after = new Map(incoming.body.entries.map((e) => [e.alias, e.uuid]));
  const changed = [...after].filter(([a, u]) => before.get(a) !== u).length + [...before].filter(([a]) => !after.has(a)).length;
  if (changed !== 1) {
    return refuse(state, 422, 'bad-aliases', `the list the page signed differs from the held one by ${changed} alias(es), not by exactly one alias added or removed${stale}`);
  }
  const names = new Map(machinesOf(state).map((m) => [m.uuid, m.name]));
  const entries = incoming.body.entries.map((e) => (names.has(e.uuid) ? { alias: e.alias, uuid: e.uuid, name: names.get(e.uuid) as string } : { alias: e.alias, uuid: e.uuid }));
  const told = state.peers.map((p) => ({ uuid: p.registration.body.uuid, name: p.registration.body.name }));
  const delivery = plannedFor(state.plan, told, 'the network aliases list', ALIASES_RETRY, 'aliases');
  const subject = { uuid: ALIASES_SUBJECT_UUID, name: 'the network aliases' };
  const next = retained({ ...state, networkAliases: incoming }, subject, { ...delivery, retry: ALIASES_RETRY });
  return { state: next, answer: ok({ ok: true, serial: incoming.body.serial, entries, changed: true, retry: ALIASES_RETRY, ...delivery }) };
}
