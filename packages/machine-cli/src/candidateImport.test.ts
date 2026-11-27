import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePairSecretV2, generateSigningKeyPair, keyId, newCandidacyRandom } from '@wadeck-app/machine-core';
import { buildApproval, type BuiltApproval } from '@wadeck-app/machine-webcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { approveContext, importCandidate } from './candidateImport.js';
import { makeCommands } from './commands.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork } from './network.js';
import { cli, fakeTiming, ok } from './testing.js';

// Approve from the page, lot 3: the daemon side that makes the admin machine trust a candidate. The BROWSER builds the payload (machine-webcrypto
// buildApproval); these tests build it the same way and check what the daemon accepts and refuses. Hard rule 4: only a registration signed by the
// pinned admin key is imported.

const MACHINE_CODE = '12345678';
const SECOND_CODE = '22223333';
const ADMIN_CODE = '87654321';
const NOW = () => Math.floor(Date.now() / 1000);
const yes = async () => 'y';

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let passphrase: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-candidateimport-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE], adminCode: ADMIN_CODE });
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

/** "desktop" holds the admin key and is enrolled; "laptop" is a second initialized machine, not yet enrolled. */
async function machines(): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
  const first = await cli(a, ['join', MACHINE_CODE, '--relay', relay.url], async () => passphrase, { timing: fakeTiming() });
  expect(first.code, first.err).toBe(0);
  await ok(b, ['init', '--name', 'laptop']);
}

/** What the page does after the passphrase: the unlocked key becomes a non-extractable WebCrypto key and the approval is built from the listed candidacy. */
async function pageBuilds(options: { candidateDir?: string; random?: string } = {}): Promise<{ built: BuiltApproval; random: string; candidateUuid: string }> {
  const pair = await unlockAdminKey(a, async () => passphrase);
  const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
  const candidate = readMachine(options.candidateDir ?? b);
  const admin = exportMachineInfo(a);
  const random = options.random ?? newCandidacyRandom();
  const built = await buildApproval({
    adminPrivateKey: key,
    adminPublicKey: pair.publicKey,
    adminKeyId: keyId(pair.publicKey),
    candidate: { uuid: candidate.uuid, name: candidate.name, identityPublicKey: candidate.identity.publicKey, random },
    adminMachine: { uuid: admin.uuid, name: admin.name, identityPublicKey: admin.identityPublicKey },
    now: NOW(),
    validForDays: 90,
  });
  return { built, random, candidateUuid: candidate.uuid };
}

const payloadOf = (built: BuiltApproval): Record<string, unknown> => {
  if (built.adminImport === null) throw new Error('test: nothing to import');
  return { ...built.adminImport };
};

describe('importCandidate: the admin machine trusts the candidate', () => {
  it('verifies the registration against the pinned admin key, opens the sealed pair secret and imports the peer (the pair secret V2 of machine-core)', async () => {
    await machines();
    const { built, candidateUuid } = await pageBuilds();
    const answer = await importCandidate(a, payloadOf(built), NOW());
    expect(answer).toMatchObject({ ok: true, candidate: { uuid: candidateUuid, name: 'laptop' } });
    expect(loadNetwork(a, NOW()).directory.find(candidateUuid)?.name).toBe('laptop');
    const stored = JSON.parse(readFileSync(join(a, '_secrets_', 'peers.json'), 'utf8')) as { peers: Array<{ registration: { body: { uuid: string; serial: number } }; pairSecret: string }> };
    const entry = stored.peers.find((p) => p.registration.body.uuid === candidateUuid);
    const admin = exportMachineInfo(a);
    const pair = await unlockAdminKey(a, async () => passphrase);
    expect(entry?.pairSecret).toBe(derivePairSecretV2(pair.privateKeyPkcs8, { uuid: candidateUuid, serial: entry!.registration.body.serial }, { uuid: admin.uuid, serial: entry!.registration.body.serial }));
  });

  it('is idempotent: the page retrying after a lost answer gets ok again and one entry', async () => {
    await machines();
    const { built, candidateUuid } = await pageBuilds();
    expect(await importCandidate(a, payloadOf(built), NOW())).toMatchObject({ ok: true });
    expect(await importCandidate(a, payloadOf(built), NOW())).toMatchObject({ ok: true });
    const stored = JSON.parse(readFileSync(join(a, '_secrets_', 'peers.json'), 'utf8')) as { peers: Array<{ registration: { body: { uuid: string } } }> };
    expect(stored.peers.filter((p) => p.registration.body.uuid === candidateUuid)).toHaveLength(1);
  });

  it('is reachable as the daemon command `importCandidate`, and the answer carries no secret', async () => {
    await machines();
    const { built } = await pageBuilds();
    const commands = makeCommands(a, '0.0.0-test');
    const answer = await commands.importCandidate(payloadOf(built));
    expect(answer).toMatchObject({ ok: true });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(built.adminImport!.sealedPairSecret);
    expect(text).not.toMatch(/pairSecret/i);
  });
});

describe('importCandidate: refusals name the cause and the fix, nothing is stored', () => {
  // The file does not exist before the first peer: "absent" is then the state that must stay unchanged.
  const peersOnDisk = (): string => (existsSync(join(a, '_secrets_', 'peers.json')) ? readFileSync(join(a, '_secrets_', 'peers.json'), 'utf8') : '(absent)');

  it('a payload with any other field (a passphrase cannot be forwarded) or a missing one', async () => {
    await machines();
    const { built } = await pageBuilds();
    const before = peersOnDisk();
    expect(await importCandidate(a, { ...payloadOf(built), passphrase: 'x' }, NOW())).toMatchObject({ ok: false, reason: 'bad-payload' });
    const { random: _omitted, ...withoutRandom } = payloadOf(built);
    expect(await importCandidate(a, withoutRandom, NOW())).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(await importCandidate(a, undefined, NOW())).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(peersOnDisk()).toBe(before);
  });

  it('a registration NOT signed by the pinned admin key (another admin key): hard rule 4', async () => {
    await machines();
    const { built } = await pageBuilds();
    const other = generateSigningKeyPair();
    const otherKey = await crypto.subtle.importKey('pkcs8', other.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const candidate = readMachine(b);
    const admin = exportMachineInfo(a);
    const forged = await buildApproval({
      adminPrivateKey: otherKey,
      adminPublicKey: other.publicKey,
      adminKeyId: keyId(other.publicKey),
      candidate: { uuid: candidate.uuid, name: candidate.name, identityPublicKey: candidate.identity.publicKey, random: built.adminImport!.random },
      adminMachine: { uuid: admin.uuid, name: admin.name, identityPublicKey: admin.identityPublicKey },
      now: NOW(),
      validForDays: 90,
    });
    const before = peersOnDisk();
    const answer = await importCandidate(a, payloadOf(forged), NOW());
    expect(answer).toMatchObject({ ok: false, reason: 'bad-registration' });
    expect((answer as { message: string }).message).toMatch(/admin key pinned on this machine/);
    expect(peersOnDisk()).toBe(before);
  });

  it('a sealed pair secret made for another admin machine, another candidate or another candidacy (the contexts bind them)', async () => {
    await machines();
    const { built } = await pageBuilds();
    const before = peersOnDisk();
    const base = payloadOf(built);
    expect(await importCandidate(a, { ...base, random: newCandidacyRandom() }, NOW())).toMatchObject({ ok: false, reason: 'cannot-open' });
    // The candidate uuid of the payload is not the one of the registration.
    expect(await importCandidate(a, { ...base, candidateUuid: '33333333-3333-4333-8333-333333333333' }, NOW())).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(await importCandidate(a, { ...base, adminUuid: '33333333-3333-4333-8333-333333333333' }, NOW())).toMatchObject({ ok: false, reason: 'wrong-machine' });
    expect(peersOnDisk()).toBe(before);
  });

  it('a machine that does not hold the admin key', async () => {
    await machines();
    const { built } = await pageBuilds();
    const answer = await importCandidate(b, payloadOf(built), NOW());
    expect(answer).toMatchObject({ ok: false, reason: 'no-admin-key' });
    expect((answer as { message: string }).message).toMatch(/machine that holds the admin key/);
  });

  it('a uuid already trusted with ANOTHER identity key is not replaced here (the CLI asks for the rebind, the page does not)', async () => {
    await machines();
    const first = await pageBuilds();
    expect(await importCandidate(a, payloadOf(first.built), NOW())).toMatchObject({ ok: true });
    // The same uuid comes back with a new key: build a registration for it by hand with the real admin key.
    const pair = await unlockAdminKey(a, async () => passphrase);
    const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const admin = exportMachineInfo(a);
    const replaced = await buildApproval({
      adminPrivateKey: key,
      adminPublicKey: pair.publicKey,
      adminKeyId: keyId(pair.publicKey),
      candidate: { uuid: first.candidateUuid, name: 'laptop', identityPublicKey: generateSigningKeyPair().publicKey, random: newCandidacyRandom() },
      adminMachine: { uuid: admin.uuid, name: admin.name, identityPublicKey: admin.identityPublicKey },
      now: NOW() + 5,
      validForDays: 90,
    });
    const answer = await importCandidate(a, payloadOf(replaced), NOW() + 5);
    expect(answer).toMatchObject({ ok: false, reason: 'key-changed' });
    expect((answer as { message: string }).message).toMatch(/machine admin approve/);
  });
});

describe('approveContext: what the page needs before it asks the passphrase', () => {
  it('gives the admin machine, the pinned key and, for a candidate uuid, whether it is already trusted with another key', async () => {
    await machines();
    const admin = exportMachineInfo(a);
    const pair = await unlockAdminKey(a, async () => passphrase);
    const answer = approveContext(a, { candidateUuid: readMachine(b).uuid }, NOW());
    expect(answer).toMatchObject({ ok: true, adminMachine: { uuid: admin.uuid, name: 'desktop', identityPublicKey: admin.identityPublicKey }, adminPublicKey: pair.publicKey, adminKeyId: keyId(pair.publicKey), candidate: { trusted: false } });
    const { built } = await pageBuilds();
    await importCandidate(a, payloadOf(built), NOW());
    expect(approveContext(a, { candidateUuid: readMachine(b).uuid }, NOW())).toMatchObject({ ok: true, candidate: { trusted: true, name: 'laptop', identityPublicKey: readMachine(b).identity.publicKey } });
  });

  it('refuses a machine without the admin key, and a bad candidate uuid', async () => {
    await machines();
    expect(approveContext(b, { candidateUuid: readMachine(a).uuid }, NOW())).toMatchObject({ ok: false, reason: 'no-admin-key' });
    expect(approveContext(a, { candidateUuid: 'nope' }, NOW())).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(approveContext(a, { candidateUuid: readMachine(b).uuid, extra: 1 }, NOW())).toMatchObject({ ok: false, reason: 'bad-payload' });
  });
});
