import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { candidacyCode, finalCode, keyId, signRegistration, type RegistrationBody } from '@wadeck-app/machine-core';
import { vi } from 'vitest';
import register from '../index.js';
import { makeTempDir, removeTempDir } from '../tempDir.testUtil.js';
import { candidacyTimeline } from '../candidacyTimeline.js';
// Test-only reach into machine-cli (the module never imports it): the delivery text and per-machine states of the seeds come from the REAL functions of the CLI.
import { deliveryMachines } from '../../../../machine-cli/src/deliveryMachines.js';
import { emptyReport, formatDistribution, type DistributionReport, type Recipient } from '../../../../machine-cli/src/distribute.js';
import type { CandidaciesState, RelayCandidacy } from '../../commons/candidaciesState.js';
import type { DistributeAnswer, ErrorBody, SignedRegistrationWire } from '../../commons/routeContracts.js';

// Builds the SEEDS (the initial states of the Candidacies mock) from deterministic FAKE material, and runs the REAL backend routes against a fake relay and a fake
// daemon so the seeds can be compared with what the backend really answers. Nothing here is a real key, uuid, address or token of any network:
//  - keys come from the seed bytes below (a key made of one repeated byte is obviously not random), the private halves are never written to a seed;
//  - uuids are 00000000-0000-4000-8000-00000000000N; addresses are in the documentation ranges 192.0.2.0/24 and 198.51.100.0/24.

/** 2026-11-28T10:00:00Z. The mock moves every date with `rebase`. */
export const NOW = Date.UTC(2026, 10, 28, 10, 0, 0) / 1000;
export const FIXTURE_CONFIG_DIR = '/home/user/.config/machine';

export const UUID = {
  midgard2: '00000000-0000-4000-8000-000000000001',
  thinkcentre: '00000000-0000-4000-8000-000000000002',
  macM2: '00000000-0000-4000-8000-000000000003',
} as const;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface FakeKey {
  publicKey: string;
  privateKeyPkcs8: Uint8Array;
}

/** An Ed25519 key whose 32 seed bytes all equal `byte`. */
export function fakeKey(byte: number): FakeKey {
  const privateKeyPkcs8 = new Uint8Array(Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, byte)]));
  const jwk = createPublicKey(createPrivateKey({ key: Buffer.from(privateKeyPkcs8), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('fakeKey: the runtime returned no raw public key');
  return { publicKey: jwk.x, privateKeyPkcs8 };
}

export const KEYS = { admin: fakeKey(0xa1), midgard2: fakeKey(0xd4), thinkcentre: fakeKey(0xb2), macM2: fakeKey(0xc3) };
/** Every public key a seed may contain (the privacy scan refuses any other 43-character base64url string). */
export const ALLOWED_PUBLIC_KEYS: string[] = Object.values(KEYS).map((k) => k.publicKey);
const randomOf = (byte: number): string => Buffer.alloc(16, byte).toString('base64url');
export const RANDOMS = { macM2: randomOf(0x31), thinkcentre: randomOf(0x32) };
export const ALLOWED_RANDOMS: string[] = Object.values(RANDOMS);

/**
 * THROWAWAY SCENARIO ADMIN KEY: the file served by the scenarios. It is the encrypted envelope (public data) of `KEYS.admin` above (32 bytes of 0xa1: obviously fake,
 * trusted by no machine), locked with the PUBLISHED passphrase `SCENARIO_PASSPHRASE` of commons/scenarioList.ts, so the real code of the page can sign in a browser. It
 * is a literal, not computed, so that regenerating the seeds (WRITE_SEEDS=1) is deterministic (a fresh encryption draws a new salt and iv). It was produced once with
 * `encryptAdminKey(KEYS.admin, SCENARIO_PASSPHRASE, { iterations: 600000, hint })`; scenarioSigning.test.ts proves it still opens with the passphrase and holds KEYS.admin.
 */
export const SCENARIO_ADMIN_KEY_FILE = JSON.stringify({
  v: 2,
  publicKey: KEYS.admin.publicKey,
  hint: 'scenario key, trusted by nothing: its passphrase is in the scenario hint',
  kdf: { name: 'pbkdf2-sha256', iterations: 600000, salt: 'Lp2olVXgLwcZIDqCMmUuNw' },
  cipher: { name: 'aes-256-gcm', iv: 'GoGY3WA5PsbWx83o' },
  ciphertext: 'Qc6SBfH7H--t7Lyq9DawBNF5vvoE0t46Dk89MZ-phsul0iQR4pdJrH4Tfkn6zJPBui6lF_FGaPLaodfRbpf0mw',
});
/** EXPLICIT ALLOW-LIST of the privacy scan: the only key-like string of a seed that is the scenario key (the ciphertext of the throwaway key above). Nothing else is added without a comment. */
export const ALLOWED_SCENARIO_KEY_STRINGS: string[] = [(JSON.parse(SCENARIO_ADMIN_KEY_FILE) as { ciphertext: string }).ciphertext];

export function registrationOf(name: string, uuid: string, key: FakeKey, serial = 1): SignedRegistrationWire {
  const body: RegistrationBody = { v: 1, uuid, name, identityPublicKey: key.publicKey, serial, validFrom: NOW - 30 * 86_400, validTo: NOW + 3650 * 86_400, adminKeyId: keyId(KEYS.admin.publicKey) };
  return signRegistration(body, KEYS.admin.privateKeyPkcs8);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The real backend, driven in process.

type Handler = (req: unknown, reply: { code(status: number): unknown; send(body: unknown): unknown }) => unknown;

export interface RealOptions {
  now: number;
  relay: { kind: 'none' } | { kind: 'unreachable' } | { kind: 'list'; candidacies: unknown[]; decisionStatus?: number };
  /** What the daemon answers, by command (`{ result }`); absent: no daemon. */
  daemon?: Record<string, unknown>;
  /** The content of approval-codes.json (`approvals` only). */
  approvals?: Array<{ uuid: string; name: string; code: string; at: number }>;
}

export interface Real {
  call(key: string, req: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/** Replaces the temp config dir by the fixture one so a message names the same path on every machine. */
export const portable = <T>(value: T, configDir: string): T => JSON.parse(JSON.stringify(value).split(JSON.stringify(configDir).slice(1, -1)).join(FIXTURE_CONFIG_DIR).replaceAll('\\\\', '/')) as T;

export async function startReal(options: RealOptions): Promise<Real> {
  const configDir = makeTempDir('machine-seeds-');
  const previous = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(options.now * 1000);
  const servers: Server[] = [];

  if (options.relay.kind !== 'none') {
    mkdirSync(join(configDir, '_secrets_'), { recursive: true });
    writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl: 'https://relay.example.net', token: 'FAKE-ADMIN-TOKEN-NOT-A-SECRET', label: 'console', claimedAt: 'x' }));
    const relay = options.relay;
    vi.stubGlobal('fetch', async (_url: string, init: { method: string }): Promise<Response> => {
      if (relay.kind === 'unreachable') throw new TypeError('fetch failed');
      if (init.method === 'GET') return new Response(JSON.stringify({ candidacies: relay.candidacies }), { status: 200, headers: { 'content-type': 'application/json' } });
      const status = relay.decisionStatus ?? 204;
      return new Response(status === 204 ? null : '{}', { status });
    });
  }
  if (options.approvals !== undefined) writeFileSync(join(configDir, 'approval-codes.json'), JSON.stringify({ v: 1, approvals: options.approvals }));
  if (options.daemon !== undefined) {
    const answers = options.daemon;
    const daemon = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const command = (req.url ?? '').slice(1);
        const known = req.headers.authorization === 'Bearer FAKE-DAEMON-TOKEN' && command in answers;
        res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(known ? { result: answers[command] } : { error: `Unknown command: ${command}` }));
      });
    });
    servers.push(daemon);
    await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: (daemon.address() as { port: number }).port, peerPort: 1 }));
    writeFileSync(join(configDir, 'health_token'), 'FAKE-DAEMON-TOKEN');
  }

  const routes = new Map<string, Handler>();
  register({ registerRoute: (method: string, path: string, handler: Handler) => { routes.set(`${method} ${path}`, handler); } } as never);

  return {
    async call(key, req) {
      const handler = routes.get(key);
      if (handler === undefined) throw new Error(`route not registered: ${key}`);
      let status = 200;
      let sent: unknown;
      const reply = { code(s: number) { status = s; return reply; }, send(b: unknown) { sent = b; return b; } };
      await handler({ headers: req.headers ?? { 'x-machine-module': '1' }, params: req.params ?? {}, query: {}, body: req.body }, reply);
      return { status, body: portable(sent, configDir) };
    },
    async close() {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env['MACHINE_CONFIG_DIR'];
      else process.env['MACHINE_CONFIG_DIR'] = previous;
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      removeTempDir(configDir);
    },
  };
}

/** What the relay sends for a candidacy fact (the inverse of the review: absent facts are absent). */
export function rawOf(c: RelayCandidacy): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: c.id,
    name: c.name,
    hostname: c.hostname,
    observedIp: c.observedIp,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    status: c.status,
    identityPublicKey: c.identityPublicKey,
    random: c.random,
  };
  if (c.uuid !== undefined) raw['uuid'] = c.uuid;
  if (c.uuidBound !== undefined) raw['uuidBound'] = c.uuidBound;
  if (c.boundTokenLabel !== undefined) raw['boundTokenLabel'] = c.boundTokenLabel;
  if (c.boundToCandidateToken !== undefined) raw['boundToCandidateToken'] = c.boundToCandidateToken;
  return raw;
}

export const FAKE_DAEMON_IMPORT = (uuid: string, name: string): Record<string, unknown> => ({ importCandidate: { ok: true, candidate: { uuid, name }, serial: 1, warnings: [] } });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The seeds.

const AGE_STEPS = (): Array<{ id: string; title: string; info: string }> => candidacyTimeline([], NOW).steps.map((s) => ({ id: s.id, title: s.title, info: s.info }));

interface CandidateSpec {
  name: string;
  uuid: string | undefined;
  key: FakeKey;
  random: string;
  ageSeconds: number;
  ip: string;
  over?: Partial<RelayCandidacy>;
}

function candidate(spec: CandidateSpec): RelayCandidacy {
  const createdAt = NOW - spec.ageSeconds;
  return {
    id: `cand-${spec.name}-01`,
    name: spec.name,
    hostname: `${spec.name}.lan`,
    observedIp: spec.ip,
    ...(spec.uuid === undefined ? {} : { uuid: spec.uuid }),
    createdAt,
    expiresAt: createdAt + 900,
    status: 'pending',
    uuidBound: false,
    identityPublicKey: spec.key.publicKey,
    random: spec.random,
    code: candidacyCode(spec.key.publicKey, spec.random),
    problems: [],
    ...spec.over,
  };
}

const mac = (ageSeconds: number, over?: Partial<RelayCandidacy>): RelayCandidacy => candidate({ name: 'mac-m2', uuid: UUID.macM2, key: KEYS.macM2, random: RANDOMS.macM2, ageSeconds, ip: '192.0.2.10', ...(over === undefined ? {} : { over }) });
const think = (ageSeconds: number, over?: Partial<RelayCandidacy>): RelayCandidacy => candidate({ name: 'thinkcentre', uuid: UUID.thinkcentre, key: KEYS.thinkcentre, random: RANDOMS.thinkcentre, ageSeconds, ip: '198.51.100.20', ...(over === undefined ? {} : { over }) });

const emptyState = (): CandidaciesState => ({
  now: NOW,
  relayError: null,
  adminKeyFile: SCENARIO_ADMIN_KEY_FILE,
  admin: { uuid: UUID.midgard2, name: 'midgard2', identityPublicKey: KEYS.midgard2.publicKey, publicKey: KEYS.admin.publicKey, keyId: keyId(KEYS.admin.publicKey) },
  trusted: [],
  revoked: {},
  candidacies: [],
  approvals: [],
  approvalsProblem: '',
  timelineSteps: AGE_STEPS(),
  distributions: {},
});

export type DeliveryPlan = 'delivered' | 'partial' | 'failed';

/**
 * The answer of `approveDistribute` for approving `subject` while `others` are trusted. The report is hand-built (its counts are an approximation of a real run); the
 * text and the per-machine states come from the REAL `formatDistribution` and `deliveryMachines` of the CLI, so their wording cannot drift.
 */
export function distributionAnswer(plan: DeliveryPlan, subject: { uuid: string; name: string }, others: Array<{ uuid: string; name: string }>): DistributeAnswer {
  const retry = `machine admin distribute ${subject.uuid}`;
  const told: Recipient[] = [];
  for (const other of others) told.push(other);
  told.push(subject);
  const report: DistributionReport = emptyReport();
  report.machines = told.length;
  report.direct = [];
  report.fallbacks = [];
  report.noticeDirectNames = [];
  for (const to of told) {
    const waits = plan === 'partial' && to.uuid !== subject.uuid;
    if (plan === 'failed') {
      report.failures.push({ toUuid: to.uuid, toName: to.name, kind: 'peer', id: undefined, message: 'the relay answered 503 to the store of the document (relay_unavailable): check the relay, then retry' });
    } else if (waits) {
      report.delivered += 2;
      report.noticeLists = (report.noticeLists ?? 0) + 1;
      report.noticeNames = [...(report.noticeNames ?? []), to.name];
      report.fallbacks.push({ toUuid: to.uuid, toName: to.name, kind: 'peer', code: 'unreachable', cause: 'no connection in 3 s', ms: 3000 });
    } else {
      report.direct.push({ toUuid: to.uuid, toName: to.name, kind: 'peer', outcome: 'installed', ms: 120 });
      report.noticeDirectNames.push(to.name);
    }
  }
  if (plan === 'failed') report.aborted = true;
  const text = formatDistribution(report, 'the approval', retry);
  return { ok: true, subject, failed: text.failed, report, text: { out: text.out, err: text.err }, machines: deliveryMachines(report, told, retry), retry };
}

const MACHINE_OF = (c: RelayCandidacy): { uuid: string; name: string } => ({ uuid: c.uuid as string, name: c.name });

export async function buildSeeds(): Promise<Record<string, CandidaciesState>> {
  const thinkTrusted = registrationOf('thinkcentre', UUID.thinkcentre, KEYS.thinkcentre);
  const thinkPeer = { uuid: UUID.thinkcentre, name: 'thinkcentre' };
  const seeds: Record<string, CandidaciesState> = {};

  seeds['empty'] = emptyState();

  const onePending = mac(4 * 60);
  seeds['one-pending'] = { ...emptyState(), candidacies: [onePending], distributions: { [UUID.macM2]: distributionAnswer('delivered', MACHINE_OF(onePending), []) } };

  // The oldest is followed by the timeline; the younger one is the machine of another token (a rebind).
  const oldest = mac(12 * 60);
  const younger = think(5 * 60, { uuidBound: true, boundTokenLabel: '(revoked token)', boundToCandidateToken: false });
  seeds['several-pending'] = {
    ...emptyState(),
    candidacies: [younger, oldest],
    distributions: { [UUID.macM2]: distributionAnswer('delivered', MACHINE_OF(oldest), []), [UUID.thinkcentre]: distributionAnswer('delivered', MACHINE_OF(younger), []) },
  };

  const revoked = mac(3 * 60);
  seeds['pending-revoked-earlier'] = { ...emptyState(), candidacies: [revoked], revoked: { [UUID.macM2]: 3 }, distributions: { [UUID.macM2]: distributionAnswer('delivered', MACHINE_OF(revoked), []) } };

  // The problem text is the one the REAL review produces for a candidacy the relay sent without a uuid.
  const { uuid: _dropped, ...noUuid } = think(5 * 60);
  const probe = await startReal({ now: NOW, relay: { kind: 'list', candidacies: [rawOf(noUuid)] } });
  const probed = (await probe.call('GET /candidacies', {})).body as { candidacies: Array<{ problems: string[] }> };
  await probe.close();
  seeds['pending-with-problems'] = { ...emptyState(), candidacies: [{ ...noUuid, problems: probed.candidacies[0]?.problems ?? [] }] };

  const notConfigured = await startReal({ now: NOW, relay: { kind: 'none' } });
  const notConfiguredBody = (await notConfigured.call('GET /candidacies', {})).body as ErrorBody;
  await notConfigured.close();
  seeds['relay-error-503'] = { ...emptyState(), relayError: notConfiguredBody };

  const unreachable = await startReal({ now: NOW, relay: { kind: 'unreachable' } });
  const unreachableBody = (await unreachable.call('GET /candidacies', {})).body as ErrorBody;
  await unreachable.close();
  seeds['relay-unreachable-502'] = { ...emptyState(), relayError: unreachableBody };

  for (const [name, plan] of [['approve-result-delivered', 'delivered'], ['approve-result-partial', 'partial'], ['approve-result-failed', 'failed']] as const) {
    const pending = mac(4 * 60);
    seeds[name] = { ...emptyState(), trusted: [thinkTrusted], candidacies: [pending], distributions: { [UUID.macM2]: distributionAnswer(plan, MACHINE_OF(pending), [thinkPeer]) } };
  }

  // Approved 4 minutes ago from the page: the relay purged the random, only the kept code can show it again. A second reminder belongs to a machine long gone from the list.
  const approved = mac(9 * 60, { status: 'approved' });
  const macFinal = finalCode(KEYS.macM2.publicKey, KEYS.admin.publicKey, RANDOMS.macM2);
  const thinkFinal = finalCode(KEYS.thinkcentre.publicKey, KEYS.admin.publicKey, RANDOMS.thinkcentre);
  seeds['approval-codes-recallable'] = {
    ...emptyState(),
    trusted: [thinkTrusted, registrationOf('mac-m2', UUID.macM2, KEYS.macM2)],
    candidacies: [approved],
    approvals: [{ uuid: UUID.macM2, name: 'mac-m2', code: macFinal, at: NOW - 4 * 60 }, { uuid: UUID.thinkcentre, name: 'thinkcentre', code: thinkFinal, at: NOW - 2 * 86_400 }],
  };

  // Posted 20 minutes ago, expired for 5: the relay still lists it, with the problem the review adds.
  const expired = mac(20 * 60);
  seeds['candidate-expired'] = { ...emptyState(), candidacies: [expired] };

  return seeds;
}

