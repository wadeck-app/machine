import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom, signPolicy, type SignedDocument } from '@wadeck-app/machine-core';
import { unlockAdminKey } from './admin.js';
import type { DirectAttempt, DirectDelivery } from './directDelivery.js';
import { adminMachineUuid, adminRelayAccess, distributePolicy, formatDistribution, putNoticeRecipients, type DistributionReport, type Sender } from './distribute.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { signNoticeRecipientsFor } from './noticeRecipientsStore.js';
import { readAdminPin } from './admin.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Direct delivery first (decision 86): every `put` of distribute.ts tries the peer channel before the relay inbox, with the SAME document.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const pass = async () => admin.passphrase;
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const policyPuts = (kind: string) => relay.requests.filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path) && (q.body as { body?: { kind?: string } } | undefined)?.body?.kind === kind);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-direct-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
  const info = exportMachineInfo(dirOf('laptop'));
  relay.addCandidacy('cand-laptop', { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const approved = await cli(adminDir, ['admin', 'approve', 'cand-laptop', '--relay', relay.url], pass, { ask: async () => 'y' });
  if (approved.code !== 0) {
    throw new Error(approved.err);
  }
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

async function senderWith(direct: DirectDelivery | undefined): Promise<{ sender: Sender; sent: SignedDocument[] }> {
  const key = await unlockAdminKey(adminDir, pass);
  const access = adminRelayAccess(adminDir);
  if (access === undefined) {
    throw new Error('no admin token');
  }
  const sent: SignedDocument[] = [];
  const wrapped: DirectDelivery | undefined = direct === undefined ? undefined : async (to, document) => (sent.push(document), await direct(to, document));
  return { sender: { client: access.client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: adminMachineUuid(adminDir), now: nowSeconds, configDir: adminDir, ...(wrapped ? { direct: wrapped } : {}) }, sent };
}

async function signedPolicy() {
  const key = await unlockAdminKey(adminDir, pass);
  const now = nowSeconds();
  return signPolicy({ v: 1, target: uuidOf('laptop'), version: 1, baseVersion: 0, adminKeyId: admin.adminKeyId, issuedAt: now, notBefore: now - 5, notAfter: now + 100_000, defaults: [{ shell: 'sh', command: 'echo hi' }], peers: {} }, key.privateKeyPkcs8);
}

const delivered = (ms = 412): DirectDelivery => async () => ({ ok: true, outcome: 'installed', ms });
const failing = (attempt: Omit<Extract<DirectAttempt, { ok: false }>, 'ok' | 'ms'>): DirectDelivery => async () => ({ ok: false, ms: 3000, ...attempt });
const nameOf = (report: DistributionReport) => report.direct?.[0]?.toName;

describe('direct delivery first', () => {
  it('a policy delivered directly is NOT put in the inbox, and the report says how long it took', async () => {
    const { sender, sent } = await senderWith(delivered());
    const listsBefore = policyPuts('notice-recipients').length;
    const report = await distributePolicy(await signedPolicy(), sender);
    // The policy, then the list of notice recipients that rides every distribution: both straight to the target, none in the inbox.
    expect(sent.map((d) => d.body.kind)).toEqual(['policy', 'notice-recipients']);
    expect(policyPuts('policy')).toHaveLength(0);
    expect(policyPuts('notice-recipients')).toHaveLength(listsBefore);
    expect(report.failures).toEqual([]);
    expect(report.direct).toEqual([{ toUuid: uuidOf('laptop'), toName: 'laptop', kind: 'policy', outcome: 'installed', ms: 412 }]);
    expect(report.delivered).toBe(0);
    expect(nameOf(report)).toBe('laptop');
  });

  it('when the target cannot be reached the SAME document goes to the inbox and the report keeps the cause', async () => {
    const { sender, sent } = await senderWith(failing({ code: 'unreachable', cause: 'connect timed out' }));
    const report = await distributePolicy(await signedPolicy(), sender);
    const stored = policyPuts('policy');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toEqual(sent.find((d) => d.body.kind === 'policy'));
    expect(report.delivered).toBe(1);
    expect(report.fallbacks?.map((f) => f.kind)).toEqual(['policy', 'notice-recipients']);
    expect(report.fallbacks?.[0]).toMatchObject({ toUuid: uuidOf('laptop'), toName: 'laptop', code: 'unreachable', cause: 'connect timed out' });
  });

  it('a refusal of the target is also a fallback to the inbox, with its reason', async () => {
    const { sender } = await senderWith(failing({ code: 'refused', cause: 'laptop refused the document (install-refused): policy refused (rollback)' }));
    const report = await distributePolicy(await signedPolicy(), sender);
    expect(policyPuts('policy')).toHaveLength(1);
    expect(report.fallbacks?.[0]?.cause).toMatch(/install-refused/);
  });

  it('warns, once per machine, when the clock the target reported differs by more than 30 s (the delivery itself still counts)', async () => {
    const skewed: DirectDelivery = async () => ({ ok: true, outcome: 'installed', ms: 10, peerNow: nowSeconds() - 200 });
    const { sender } = await senderWith(skewed);
    const report = await distributePolicy(await signedPolicy(), sender);
    expect(report.direct?.length).toBeGreaterThan(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings?.[0]).toMatch(/laptop's clock is 3 min 2\d s behind this machine .*fix its time sync/);
    const text = formatDistribution(report, 'the policy', 'retry');
    expect(text.out).toMatch(/\[warn\] laptop's clock is/);
  });

  it('says nothing for a skew of a few seconds, or when the target reported no clock', async () => {
    for (const peerNow of [nowSeconds() - 5, undefined]) {
      const direct: DirectDelivery = async () => ({ ok: true, outcome: 'installed', ms: 10, ...(peerNow !== undefined ? { peerNow } : {}) });
      const { sender } = await senderWith(direct);
      const report = await distributePolicy(await signedPolicy(), sender);
      expect(report.warnings).toBeUndefined();
    }
  });

  it('without a direct delivery everything is as before (the inbox only)', async () => {
    const { sender } = await senderWith(undefined);
    const report = await distributePolicy(await signedPolicy(), sender);
    expect(policyPuts('policy')).toHaveLength(1);
    expect(report.direct).toBeUndefined();
    expect(report.fallbacks).toBeUndefined();
  });

  it('the list of notice recipients goes the same way: direct when possible, never also to the inbox', async () => {
    const { sender, sent } = await senderWith(delivered(30));
    const key = await unlockAdminKey(adminDir, pass);
    const signed = signNoticeRecipientsFor(adminDir, { adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminPublicKey: readAdminPin(adminDir).adminPublicKey, selfUuid: uuidOf('desktop'), now: nowSeconds() });
    const before = policyPuts('notice-recipients').length;
    const report: DistributionReport = { delivered: 0, alreadyThere: 0, failures: [], aborted: false, machines: 1 };
    await putNoticeRecipients(sender, report, signed, [{ uuid: uuidOf('laptop'), name: 'laptop' }]);
    expect(sent.map((d) => d.body.kind)).toEqual(['notice-recipients']);
    expect(policyPuts('notice-recipients')).toHaveLength(before);
    expect(report.noticeLists).toBe(1);
    expect(report.noticeDirectNames).toEqual(['laptop']);
    expect(report.noticeNames).toBeUndefined();
  });
});

describe('what the admin is told (formatDistribution)', () => {
  const base: DistributionReport = { delivered: 0, alreadyThere: 0, failures: [], aborted: false, machines: 1 };

  it('a direct delivery is one success line with the outcome and the time', () => {
    const text = formatDistribution({ ...base, direct: [{ toUuid: 'u', toName: 'thinkcentre', kind: 'policy', outcome: 'installed', ms: 412 }] }, 'the policy', 'retry');
    expect(text.failed).toBe(false);
    expect(text.out).toContain('[ok] Delivered directly to thinkcentre (installed, 0.4 s)');
    // Nothing was stored by the relay: no claim of it, and no older-build notice about sealed documents.
    expect(text.out).not.toMatch(/stored by the relay/);
    expect(text.out).not.toMatch(/older build/);
  });

  it('a fallback says which path was used and why, one line per machine, in the warning form', () => {
    const text = formatDistribution(
      {
        ...base,
        delivered: 2,
        fallbacks: [
          { toUuid: 'u', toName: 'thinkcentre', kind: 'policy', code: 'unreachable', cause: 'connect timed out', ms: 3000 },
          { toUuid: 'u', toName: 'thinkcentre', kind: 'notice-recipients', code: 'unreachable', cause: 'connect timed out', ms: 0 },
        ],
      },
      'the policy',
      'retry',
    );
    const lines = text.out.split('\n').filter((l) => l.includes('thinkcentre'));
    expect(lines).toEqual(['[warn] thinkcentre is not reachable directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: connect timed out']);
    expect(text.out).toMatch(/2 document\(s\) stored by the relay/);
  });

  it('an older build is told to update', () => {
    const text = formatDistribution({ ...base, delivered: 1, fallbacks: [{ toUuid: 'u', toName: 'old', kind: 'policy', code: 'peer-too-old', cause: 'old runs an older build: run `machine cli update` on old', ms: 5 }] }, 'the policy', 'retry');
    expect(text.out).toMatch(/old did not take the document directly: stored in the relay inbox/);
    expect(text.out).toMatch(/machine cli update/);
  });

  it('a list delivered directly is said as such, not as stored by the relay', () => {
    const text = formatDistribution({ ...base, noticeLists: 1, noticeDirectNames: ['thinkcentre'] }, 'the list', 'retry');
    expect(text.out).toContain('[ok] request notices list delivered directly to thinkcentre');
    expect(text.out).not.toMatch(/stored by the relay/);
  });
});
