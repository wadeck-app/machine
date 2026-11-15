import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidacyCode, finalCode, generateSigningKeyPair, newCandidacyRandom, openSealed } from '@wadeck-app/machine-core';
import { pairSecretContext } from './approval.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAdminPin } from './admin.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork } from './network.js';
import { createRelayClient } from './relayClient.js';
import { readRelayAdminConfig, relayAdminFile, writeRelayAdminConfig } from './relayStore.js';
import { cli, fakeTiming, makeAdmin, ok, type TestAdmin } from './testing.js';

let root: string;
let cand: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const ADMIN_CODE = '87654321';
const yes = async () => 'y';
const no = async () => 'n';
const noTty = async (): Promise<string> => {
  throw new Error('no tty');
};
const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};
// The candidacy code (base32, only with --verbose) and the security code (final code, 25 digits in five groups).
const lastCodeLine = (out: string): string => [...out.matchAll(/^ {2}([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})$/gm)].at(-1)?.[1] as string;
const lastSecurityCodeLine = (out: string): string => [...out.matchAll(/^ {2}(\d{5}(?: \d{5}){4})$/gm)].at(-1)?.[1] as string;
const login = () => cli(adminDir, ['admin', 'login', ADMIN_CODE, '--relay', relay.url]);
const approve = (args: string[] = [], io: { ask?: (l: string) => Promise<string>; prompt?: () => Promise<string> } = {}) =>
  cli(adminDir, ['admin', 'approve', ...args, '--relay', relay.url], io.prompt ?? (async () => admin.passphrase), { ask: io.ask ?? yes });
const decisions = () => relay.requests.filter((q) => q.method === 'PUT' && q.path.endsWith('/decision'));
const noToken = (...texts: string[]) => {
  for (const t of [relay.token, relay.adminToken]) expect(texts.join('\n')).not.toContain(t);
};

/** The candidate joins without waiting; the join itself sends its uuid (a candidacy without it is built by deleting the field). */
async function candidatePosts(withUuid = true): Promise<{ id: string; code: string }> {
  const joined = await ok(cand, ['join', '12345678', '--relay', relay.url, '--no-wait', '--verbose']);
  const id = [...relay.candidacies.keys()].at(-1) as string;
  // The relay stored the uuid the join sent.
  expect((relay.candidacies.get(id) as Record<string, unknown>).uuid).toBe(readMachine(cand).uuid);
  // An old entry: posted before the join sent the uuid.
  if (!withUuid) delete (relay.candidacies.get(id) as Record<string, unknown>).uuid;
  return { id, code: lastCodeLine(joined.out) };
}

/**
 * Another machine's candidacy, so that the admin has SEVERAL pending (with exactly one, `machine admin approve` goes straight to it, decision 53):
 * the tests of the list need a list.
 */
async function strayPosts(): Promise<string> {
  const pair = generateSigningKeyPair();
  const posted = await createRelayClient({ baseUrl: relay.url, token: relay.token }).postCandidacy({ name: 'stray', hostname: 'other', identityPublicKey: pair.publicKey, random: newCandidacyRandom(), uuid: randomUUID() });
  return posted.id;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-approve-'));
  cand = join(root, 'cand');
  adminDir = join(root, 'admin');
  mkdirSync(cand);
  mkdirSync(adminDir);
  relay = await startFakeRelay();
  await ok(cand, ['init', '--name', 'laptop']);
  await ok(adminDir, ['init', '--name', 'desktop']);
  admin = makeAdmin(adminDir);
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine admin login', () => {
  it('claims a full-access pairing, stores the token privately, never prints it', async () => {
    const r = await login();
    expect(r.code, r.err).toBe(0);
    const stored = readRelayAdminConfig(adminDir);
    expect(stored?.token).toBe(relay.adminToken);
    expect(stored?.relayUrl).toBe(relay.url);
    expect(stored?.label).toBe('admin-pairing');
    expect(stored?.claimedAt).toMatch(/^20\d\d-/);
    noToken(r.out, r.err);
    expect(r.out).toContain('admin-pairing');
    if (process.platform !== 'win32') expect(statSync(relayAdminFile(adminDir)).mode & 0o077).toBe(0);
    // Kept apart from the machine token.
    expect(existsSync(join(adminDir, '_secrets_', 'relay.json'))).toBe(false);
  });

  it('refuses a machine-scoped token with the fix, stores nothing, never prints it', async () => {
    await relay.close();
    relay = await startFakeRelay({ adminScopes: ['machine'] });
    const r = await login();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/limited to scopes/);
    expect(r.err).toMatch(/WITHOUT "Limited to scopes"/);
    // The reason comes with the click path: the admin is told WHY a full-access token is needed.
    expect(r.err).toMatch(/approving a machine needs a full-access relay token \(the machines themselves only get a limited one\)/);
    expect(r.err).toMatch(/NOT saved/);
    expect(existsSync(relayAdminFile(adminDir))).toBe(false);
    noToken(r.out, r.err);
  });

  it('an existing admin token is kept: refused before the code is spent unless --force', async () => {
    expect((await login()).code).toBe(0);
    const claims = () => relay.requests.filter((q) => q.path === '/api/pairings/claim').length;
    const before = claims();
    const again = await login();
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/--force/);
    expect(claims()).toBe(before);
    expect(readRelayAdminConfig(adminDir)?.token).toBe(relay.adminToken);
  });

  it('a wrong code is explained with the admin advice, not the join one', async () => {
    const r = await cli(adminDir, ['admin', 'login', '00000000', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine admin login <code>/);
    expect(r.err).not.toMatch(/machine join/);
  });

  it('join still refuses a full-access token (the check was not weakened)', async () => {
    await relay.close();
    relay = await startFakeRelay({ scopes: null });
    const r = await cli(cand, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/full-access/);
    expect(existsSync(join(cand, '_secrets_', 'relay.json'))).toBe(false);
  });

  it('a relay that predates the full-access login and no terminal: usage error naming both ways', async () => {
    await relay.close();
    relay = await startFakeRelay({ fullLogin: 'rejects' });
    const r = await cli(adminDir, ['admin', 'login', '--relay', relay.url], async () => {
      throw new Error('no tty');
    });
    expect(r.code).toBe(2);
    expect(r.err + r.out).toContain("[warn] this relay does not support the full-access login yet");
    expect(r.err).toMatch(/machine admin login <code>/);
    expect(r.err).toMatch(/WITHOUT "Limited to scopes"/);
  });
});

describe('machine admin approve: preconditions', () => {
  it('without a token from `admin login`: names the command', async () => {
    const r = await approve();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine admin login/);
    expect(relay.requests).toHaveLength(0);
  });

  it('on a machine without admin key: names `machine admin init`, sends nothing', async () => {
    writeRelayAdminConfig(cand, { relayUrl: relay.url, token: relay.adminToken, label: 'x', claimedAt: new Date().toISOString() }, false);
    const r = await cli(cand, ['admin', 'approve', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine admin init/);
    expect(relay.requests).toHaveLength(0);
  });

  it('a machine-scoped token saved as admin token: the relay refuses, the message says how to log in again', async () => {
    writeRelayAdminConfig(adminDir, { relayUrl: relay.url, token: relay.token, label: 'x', claimedAt: new Date().toISOString() }, false);
    const r = await approve();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a full-access token/);
    expect(r.err).toMatch(/machine admin login <code> --force/);
    noToken(r.out, r.err);
  });

  it('a revoked admin token (401) says how to replace it', async () => {
    await login();
    relay.force('/api/machines/candidacies', 401, { success: false, error: 'unauthorized', message: 'revoked' }, {}, 'GET');
    const r = await approve();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refused the admin token/);
    expect(r.err).toMatch(/machine admin login <code> --force/);
    noToken(r.out, r.err);
  });

  it('another --relay than the saved token: refused', async () => {
    await login();
    const r = await cli(adminDir, ['admin', 'approve', '--relay', 'https://other.example'], async () => admin.passphrase, { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toContain(relay.url);
  });

  it('usage errors: --reject without id, an extra argument, a bad --days', async () => {
    await login();
    expect((await approve(['--reject'])).code).toBe(2);
    expect((await approve(['a', 'b'])).code).toBe(2);
    expect((await approve(['a', '--days', '0'])).code).toBe(2);
    expect((await approve(['a', '--days', 'x'])).code).toBe(2);
  });
});

describe('machine admin approve: listing', () => {
  beforeEach(async () => {
    await login();
  });

  it('no pending candidacy is not an error', async () => {
    const r = await approve();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no pending candidacy/);
  });

  it('one candidacy: id, name, hostname, address and age; the candidacy code is NOT shown by default (decision 55), --verbose shows it, equal to the candidate screen', async () => {
    const { id, code } = await candidatePosts();
    await strayPosts();
    const r = await approve();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(id);
    expect(r.out).toContain('laptop');
    expect(r.out).toContain('127.0.0.1');
    expect(r.out).toMatch(/age \d+ s/);
    expect(r.out).not.toContain(code);
    expect(r.out).not.toMatch(/\bcode [0-9A-Z]{4}-/);
    const verbose = await approve(['--verbose']);
    expect(verbose.code, verbose.err).toBe(0);
    expect(verbose.out).toContain(code);
    const posted = relay.candidacies.get(id) as unknown as { identityPublicKey: string; random: string };
    expect(code).toBe(candidacyCode(posted.identityPublicKey, posted.random));
    noToken(r.out, r.err);
  });

  it('--json lists the candidacies with the recomputed code', async () => {
    const { id, code } = await candidatePosts();
    await strayPosts();
    const r = await cli(adminDir, ['admin', 'approve', '--json', '--relay', relay.url]);
    expect(r.code, r.err).toBe(0);
    const parsed = JSON.parse(r.out) as { id: string; code: string; blockers: string[] }[];
    const mine = parsed.find((c) => c.id === id);
    expect(parsed).toHaveLength(2);
    expect(mine?.id).toBe(id);
    expect(mine?.code).toBe(code);
    expect(mine?.blockers).toEqual([]);
  });

  it('a candidacy without uuid is listed with a warning (old entry)', async () => {
    await candidatePosts(false);
    await strayPosts();
    const r = await approve();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[warn\] cannot be approved: .*carries no uuid.*machine join --resume/);
  });

  it('a relay code that differs from the code of the key and random it sent: listed with the real code, exit 1', async () => {
    const { id, code } = await candidatePosts();
    await strayPosts();
    (relay.candidacies.get(id) as Record<string, unknown>).code = 'AAAA-AAAA-AAAA-AAAA';
    const r = await approve();
    expect(r.code).toBe(1);
    expect(r.out).toContain(code);
    expect(r.out).toMatch(/does not match the key and random/);
  });
});

describe('machine admin approve: deciding', () => {
  let id: string;
  let candidateCode: string;
  beforeEach(async () => {
    await login();
    ({ id, code: candidateCode } = await candidatePosts());
  });

  it('end to end with the real join: code compared, passphrase typed once, registration signed, final codes equal on both sides', async () => {
    const asked: string[] = [];
    let typed = 0;
    const approved = await approve([id.slice(0, 6)], {
      ask: async (label) => (asked.push(label), 'y'),
      prompt: async () => (typed++, admin.passphrase),
    });
    expect(approved.code, approved.err).toBe(0);
    expect(typed).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('laptop');
    // A plain confirmation on name, hostname and address: no code to compare before signing (decision 50).
    expect(asked[0]).toContain('127.0.0.1');
    expect(asked[0]).toContain('hostname');
    expect(asked[0]).not.toMatch(/code/i);
    // The candidacy code is no longer shown (decision 55); the details say where the one comparison happens.
    expect(approved.out).toMatch(/After you sign, a security code .* "laptop"/s);
    expect(approved.out).not.toContain(candidateCode);
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]?.authorization).toBe(`Bearer ${relay.adminToken}`);
    const body = decisions()[0]?.body as { decision: string; approval: { v: number; self: unknown; admin: { adminKeyId: string }; peers: unknown[] } };
    expect(body.decision).toBe('approve');
    expect(body.approval.admin.adminKeyId).toBe(admin.adminKeyId);
    expect(body.approval.peers).toHaveLength(1);
    noToken(approved.out, approved.err);

    const random = (relay.candidacies.get(id) as unknown as { random: string }).random;
    const expectedFinal = finalCode(readMachine(cand).identity.publicKey, admin.adminPublicKey, random);
    expect(approved.out.split('\n')).toContain(`  ${expectedFinal}`);
    expect(expectedFinal).toMatch(/^\d{5}( \d{5}){4}$/);
    expect(approved.out).toContain('Security code of "laptop"');
    expect(approved.out).toContain('It must read exactly the same on "laptop". If it differs, run: machine admin revoke laptop');
    // The final code comes after the decision, in the output.
    expect(approved.out.indexOf(expectedFinal)).toBeGreaterThan(approved.out.indexOf('approved for'));

    // The candidate side, the existing code: it shows the same final code, pins, imports the admin machine as a peer.
    const candidateAsked: string[] = [];
    const joined = await cli(cand, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: async (l) => (candidateAsked.push(l), 'y') });
    expect(joined.code, joined.err).toBe(0);
    expect(lastSecurityCodeLine(joined.out.split('[ok] enrolled')[0] as string)).toBe(expectedFinal);
    expect(joined.out).toContain('Security code of "laptop" (this machine)');
    expect(joined.out).toContain('It must read exactly the same on "desktop"');
    expect(candidateAsked[0]).toContain('"desktop"');
    expect(readAdminPin(cand).adminKeyId).toBe(admin.adminKeyId);
    expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines().map((m) => m.name)).toEqual(['desktop']);
    // And the admin machine trusts the candidate with the same pair secret.
    const adminPeer = loadNetwork(adminDir, Math.floor(Date.now() / 1000)).directory.machines();
    expect(adminPeer.map((m) => m.name)).toEqual(['laptop']);
    noToken(joined.out, joined.err);
  });

  it('the pair secrets travel sealed to the identity key of the candidate, bound to admin, candidate, candidacy random and slot', async () => {
    const r = await approve([id]);
    expect(r.code, r.err).toBe(0);
    const approval = decisions()[0]?.body as unknown as { approval: { adminUuid: string; random: string; self: Record<string, unknown>; peers: Record<string, unknown>[] } };
    const sent = approval.approval;
    const adminUuid = readMachine(adminDir).uuid;
    const candidateUuid = readMachine(cand).uuid;
    const adminKeyOfCandidate = (JSON.parse(readFileSync(join(adminDir, '_secrets_', 'peers.json'), 'utf8')) as { peers: { pairSecret: string }[] }).peers[0] as { pairSecret: string };

    // Nothing in clear in what the relay receives.
    expect(JSON.stringify(sent)).not.toContain(adminKeyOfCandidate.pairSecret);
    expect(sent.self).not.toHaveProperty('pairSecret');
    expect(sent.peers[0]).not.toHaveProperty('pairSecret');
    expect(sent.adminUuid).toBe(adminUuid);
    expect(sent.random).toBe(relay.candidacies.get(id)?.random);

    const key = readMachine(cand).identity.privateKeyPkcs8;
    const context = (slot: string) => pairSecretContext({ adminUuid, candidateUuid, random: sent.random, slot });
    const open = (sealed: unknown, slot: string) => Buffer.from(openSealed(key, sealed as string, context(slot))).toString('base64url');
    expect(open(sent.self.sealedPairSecret, 'self')).toBe(adminKeyOfCandidate.pairSecret);
    expect(open(sent.peers[0]?.sealedPairSecret, `peer:${adminUuid}`)).toBe(adminKeyOfCandidate.pairSecret);
    // Another slot, another random, another admin or another key cannot open it.
    expect(() => open(sent.self.sealedPairSecret, `peer:${adminUuid}`)).toThrow(/cannot open/);
    expect(() => openSealed(key, sent.self.sealedPairSecret as string, pairSecretContext({ adminUuid, candidateUuid, random: 'AAAAAAAAAAAAAAAAAAAAAA', slot: 'self' }))).toThrow(/cannot open/);
    expect(() => openSealed(readMachine(adminDir).identity.privateKeyPkcs8, sent.self.sealedPairSecret as string, context('self'))).toThrow(/cannot open/);
  });

  it('an answer other than y: nothing signed, no passphrase asked, nothing sent', async () => {
    const r = await approve([id], { ask: no, prompt: forbidden('the passphrase') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not approved/);
    expect(decisions()).toHaveLength(0);
    expect(relay.pendingIds()).toEqual([id]);
  });

  it("no terminal: fails with the fix (a person must confirm, no flag skips it), nothing sent", async () => {
    const r = await approve([id], { ask: noTty, prompt: forbidden('the passphrase') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no terminal/);
    expect(r.err).toMatch(/needs a person at a terminal/);
    expect(decisions()).toHaveLength(0);
    // No option exists to skip the comparison.
    expect((await cli(adminDir, ['admin', 'approve', id, '--yes', '--relay', relay.url])).code).toBe(2);
    const skip = await cli(adminDir, ['admin', 'approve', id, '--yes-final-code', 'AAAA', '--relay', relay.url]);
    expect(skip.code).toBe(2);
    expect(skip.err).toMatch(/no option to skip/);
  });

  it('a wrong passphrase: nothing sent, the candidacy stays pending', async () => {
    const r = await approve([id], { prompt: async () => 'not the right passphrase at all' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/passphrase|decrypt/i);
    expect(decisions()).toHaveLength(0);
    expect(relay.pendingIds()).toEqual([id]);
    expect(loadNetwork(adminDir, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
  });

  it('a prompt without terminal: nothing sent, passphrase never taken elsewhere', async () => {
    const r = await approve([id], {
      prompt: async () => {
        throw new Error('a passphrase is only read from an interactive terminal');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/interactive terminal/);
    expect(decisions()).toHaveLength(0);
  });

  it('reject: no question, no passphrase, the candidate learns it', async () => {
    const r = await approve([id, '--reject'], { ask: forbidden('a confirmation'), prompt: forbidden('the passphrase') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/rejected/);
    expect((decisions()[0]?.body as { decision: string }).decision).toBe('reject');
    const candidate = await cli(cand, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes });
    expect(candidate.code).toBe(1);
    expect(candidate.err).toMatch(/rejected/);
  });

  it('a relay that swaps the key but keeps its code: refused, nothing signed, and the shown code is not the candidate one', async () => {
    const other = readMachine(adminDir).identity.publicKey;
    const entry = relay.candidacies.get(id) as Record<string, unknown>;
    entry.code = candidateCode;
    entry.identityPublicKey = other;
    const r = await approve([id, '--verbose'], { ask: forbidden('a confirmation'), prompt: forbidden('the passphrase') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not match the key and random/);
    expect(r.err).toMatch(/do NOT approve/);
    // What the admin is shown is what the relay's key gives: it differs from the candidate screen.
    const shown = lastCodeLine(r.out);
    expect(shown).not.toBe(candidateCode);
    expect(shown).toBe(candidacyCode(other, entry.random as string));
    expect(decisions()).toHaveLength(0);
  });

  it('a relay that swaps the key and says nothing else: the admin sees another code than the candidate', async () => {
    const other = readMachine(adminDir).identity.publicKey;
    (relay.candidacies.get(id) as Record<string, unknown>).identityPublicKey = other;
    const asked: string[] = [];
    const r = await approve([id, '--verbose'], { ask: async (l) => (asked.push(l), 'n') });
    expect(r.code).toBe(1);
    expect(lastCodeLine(r.out)).not.toBe(candidateCode);
    expect(decisions()).toHaveLength(0);
  });

  it('a candidacy without uuid: refused loudly, nothing invented, nothing signed', async () => {
    delete (relay.candidacies.get(id) as Record<string, unknown>).uuid;
    const r = await approve([id], { ask: forbidden('a confirmation'), prompt: forbidden('the passphrase') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/carries no uuid/);
    expect(r.err).toMatch(/machine join --resume/);
    expect(decisions()).toHaveLength(0);
    // Rejecting stays possible.
    expect((await approve([id, '--reject'])).code).toBe(0);
  });

  it('an invalid uuid or an expired candidacy: refused', async () => {
    const entry = relay.candidacies.get(id) as Record<string, unknown>;
    entry.uuid = 'not-a-uuid';
    const bad = await approve([id], { ask: forbidden('a confirmation'), prompt: forbidden('the passphrase') });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/not a lower-case UUID/);
    entry.uuid = readMachine(cand).uuid;
    entry.expiresAt = Math.floor(Date.now() / 1000) - 5;
    const old = await approve([id], { ask: forbidden('a confirmation'), prompt: forbidden('the passphrase') });
    expect(old.code).toBe(1);
    expect(old.err).toMatch(/expired/);
    expect(decisions()).toHaveLength(0);
  });

  it('the relay refuses the decision (409): says so, the candidate is not approved', async () => {
    relay.force('/api/machines/candidacies/', 409, { success: false, error: 'not_pending', message: 'already decided' }, {}, 'PUT');
    const r = await approve([id]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT approved/);
    expect(r.err).toMatch(/no longer pending/);
  });
});

describe('machine admin approve: ids', () => {
  beforeEach(async () => {
    await login();
  });

  const plant = (id: string) =>
    relay.addCandidacy(id, { name: `m-${id.slice(-1)}`, hostname: 'h', identityPublicKey: readMachine(cand).identity.publicKey, random: newCandidacyRandom(), uuid: readMachine(cand).uuid });

  it('an ambiguous prefix lists the candidates and decides nothing; a unique prefix or the full id works', async () => {
    plant('abcd1111');
    plant('abcd2222');
    const ambiguous = await approve(['abcd', '--reject']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('abcd1111');
    expect(ambiguous.err).toContain('abcd2222');
    expect(decisions()).toHaveLength(0);

    const unique = await approve(['abcd1', '--reject']);
    expect(unique.code, unique.err).toBe(0);
    expect(decisions().map((d) => d.path)).toEqual(['/api/machines/candidacies/abcd1111/decision']);
    const exact = await approve(['abcd2222', '--reject']);
    expect(exact.code, exact.err).toBe(0);
  });

  it('an unknown id: says how to list', async () => {
    plant('abcd1111');
    const r = await approve(['zzzz']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no pending candidacy matches "zzzz"/);
    expect(decisions()).toHaveLength(0);
  });

  it('relay text is shown as printable ASCII only (no escape sequence reaches the terminal)', async () => {
    relay.addCandidacy('esc00001', { name: 'laptop', hostname: 'evil\u001b[2Jhost', identityPublicKey: readMachine(cand).identity.publicKey, random: newCandidacyRandom(), uuid: readMachine(cand).uuid });
    const r = await approve(['esc00001', '--reject']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain('\u001b');
    expect(r.out).toContain('evil?[2Jhost');
  });
});

describe('the stored admin token', () => {
  it('is mode 0600 content only: url, token, label, claimedAt', async () => {
    await login();
    const raw = JSON.parse(readFileSync(relayAdminFile(adminDir), 'utf8')) as Record<string, string>;
    expect(Object.keys(raw).sort()).toEqual(['claimedAt', 'label', 'relayUrl', 'token']);
  });
});

describe('machine admin revoke', () => {
  const revoke = (args: string[], io: { ask?: (l: string) => Promise<string>; prompt?: () => Promise<string> } = {}) =>
    cli(adminDir, ['admin', 'revoke', ...args], io.prompt ?? (async () => admin.passphrase), { ask: io.ask ?? yes });
  const trusted = () => loadNetwork(adminDir, Math.floor(Date.now() / 1000)).directory.machines().map((m) => m.name);

  // The admin approved "laptop": it is now a peer of the admin machine.
  beforeEach(async () => {
    await login();
    const { id } = await candidatePosts();
    const r = await approve([id]);
    expect(r.code, r.err).toBe(0);
    expect(trusted()).toEqual(['laptop']);
  });

  it('end to end: shows what is revoked, asks, signs, installs; the machine leaves the directory and `run` refuses it; the relay is told', async () => {
    const asked: string[] = [];
    let typed = 0;
    const r = await revoke(['laptop'], { ask: async (l) => (asked.push(l), 'y'), prompt: async () => (typed++, admin.passphrase) });
    expect(r.code, r.err).toBe(0);
    expect(typed).toBe(1);
    expect(asked).toHaveLength(1);
    expect(r.out).toContain(readMachine(cand).uuid);
    expect(r.out).toMatch(/serial\s+\d+/);
    expect(r.out).not.toMatch(/KNOWN LIMIT/);
    expect(r.out).toMatch(/no other peer to inform/);
    expect(relay.requests.some((q) => q.method === 'DELETE' && q.path === `/api/machines/${readMachine(cand).uuid}`)).toBe(true);
    expect(trusted()).toEqual([]);
    const run = await cli(adminDir, ['run', 'laptop', '--address', '127.0.0.1:1', '--', 'echo']);
    expect(run.code).toBe(255);
    expect(run.err).toMatch(/laptop/);
    noToken(r.out, r.err);
  });

  it('a unique uuid prefix works as a reference', async () => {
    const r = await revoke([readMachine(cand).uuid.slice(0, 8)]);
    expect(r.code, r.err).toBe(0);
    expect(trusted()).toEqual([]);
  });

  it('an unknown reference: exit 3, nothing asked, nothing signed', async () => {
    const r = await revoke(['ghost'], { ask: forbidden('a confirmation'), prompt: forbidden('the passphrase') });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/unknown machine "ghost"/);
    expect(trusted()).toEqual(['laptop']);
  });

  it('a wrong passphrase: nothing installed', async () => {
    const r = await revoke(['laptop'], { prompt: async () => 'not the right passphrase at all' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/passphrase|decrypt/i);
    expect(trusted()).toEqual(['laptop']);
  });

  it('no terminal: fails with the fix, no passphrase asked, nothing installed', async () => {
    const r = await revoke(['laptop'], { ask: noTty, prompt: forbidden('the passphrase') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no terminal/);
    expect(trusted()).toEqual(['laptop']);
  });

  it('an answer other than y: nothing signed', async () => {
    const r = await revoke(['laptop'], { ask: no, prompt: forbidden('the passphrase') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not revoked/);
    expect(trusted()).toEqual(['laptop']);
  });

  it('usage: no reference, --days (a revocation does not expire), no admin key', async () => {
    expect((await revoke([])).code).toBe(2);
    const days = await revoke(['laptop', '--days', '5']);
    expect(days.code).toBe(2);
    expect(days.err).toMatch(/does not expire/);
    const noKey = await cli(cand, ['admin', 'revoke', 'desktop']);
    expect(noKey.code).toBe(1);
    expect(noKey.err).toMatch(/machine admin init/);
  });

  it('HELP says that revoke informs the other peers and names distribute', async () => {
    const r = await cli(adminDir, ['--help']);
    expect(r.out).toMatch(/admin distribute <machine\|uuid>/);
    expect(r.out).toMatch(/admin distribute --policy/);
    expect(r.out).not.toMatch(/KNOWN LIMIT/);
  });
});

describe('machine admin approve: a uuid already bound to a token (deployed relay, poc-owner 719f36f)', () => {
  const SECOND = '22223333';
  let firstId: string;
  beforeEach(async () => {
    await relay.close();
    relay = await startFakeRelay({ moreCodes: [SECOND] });
    await login();
    ({ id: firstId } = await candidatePosts());
  });
  /** The same machine joins again with another token (a new pairing): same uuid, new candidacy. */
  async function secondTokenPosts(): Promise<string> {
    await ok(cand, ['join', SECOND, '--relay', relay.url, '--no-wait', '--force']);
    return relay.pendingIds().at(-1) as string;
  }

  it('the first approval of a uuid carries no warning: the question is the plain one', async () => {
    const asked: string[] = [];
    const r = await approve([firstId], { ask: async (l) => (asked.push(l), 'y') });
    expect(r.code, r.err).toBe(0);
    expect(asked[0]).not.toMatch(/already bound|replaces/);
    expect(r.out).not.toMatch(/already bound/);
  });

  it('the list and the detail say that the uuid is bound, to which token label, and that approving replaces it', async () => {
    expect((await approve([firstId])).code).toBe(0);
    const second = await secondTokenPosts();
    await strayPosts();
    const list = await approve();
    expect(list.out).toMatch(/\[warn\] the uuid is already bound to the token labelled "machine-pairing": approving replaces that binding/);
    const asked: string[] = [];
    const r = await approve([second], { ask: async (l) => (asked.push(l), 'n') });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/uuid .*already bound to the token labelled "machine-pairing"/);
    // The y/N question itself carries the warning: the person answering reads it where the decision is taken.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('already bound to the token labelled "machine-pairing"');
    expect(asked[0]).toMatch(/approving replaces it/);
    expect(asked[0]).toMatch(/\[y\/N\] $/);
    // Refused: nothing signed, no second decision.
    expect(decisions()).toHaveLength(1);
  });

  /** The same machine posts a new candidacy with the SAME token (a resume): the uuid is bound to the candidate token. */
  async function sameTokenPosts(): Promise<string> {
    const info = exportMachineInfo(cand);
    const posted = await createRelayClient({ baseUrl: relay.url, token: relay.token }).postCandidacy({ name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
    return posted.id;
  }

  it('a uuid bound to the token of the candidacy itself (re-approval) carries NO rebind warning, in the list, the detail and the question; the detail says it quietly', async () => {
    expect((await approve([firstId])).code).toBe(0);
    const again = await sameTokenPosts();
    await strayPosts();
    const list = await approve();
    expect(list.out).not.toMatch(/already bound|replaces/);
    const asked: string[] = [];
    const r = await approve([again], { ask: async (l) => (asked.push(l), 'y') });
    expect(r.code, r.err).toBe(0);
    expect(asked[0]).not.toMatch(/already bound|replaces|WARNING/);
    expect(r.out).not.toMatch(/\[warn\].*bound/);
    expect(r.out).toMatch(/same token as this candidacy: a re-approval, nothing is rebound/);
  });

  it('a uuid bound to another token whose label is "(revoked token)" is still a rebind warning, naming the placeholder', async () => {
    expect((await approve([firstId])).code).toBe(0);
    const second = await secondTokenPosts();
    relay.revokeMachineToken(relay.token);
    const asked: string[] = [];
    const r = await approve([second], { ask: async (l) => (asked.push(l), 'n') });
    expect(r.code).toBe(1);
    expect(asked[0]).toContain('already bound to the token labelled "(revoked token)"');
  });

  it('a relay that says uuidBound without boundToCandidateToken is treated as a rebind (the safe reading)', async () => {
    expect((await approve([firstId])).code).toBe(0);
    const second = await secondTokenPosts();
    delete (relay.candidacies.get(second) as Record<string, unknown>).boundToCandidateToken;
    const r = await approve([second], { ask: async () => 'n' });
    expect(r.out).toMatch(/already bound to/);
  });

  it('an invalid boundToCandidateToken blocks the approval, loudly', async () => {
    expect((await approve([firstId])).code).toBe(0);
    const second = await secondTokenPosts();
    (relay.candidacies.get(second) as Record<string, unknown>).boundToCandidateToken = 'yes';
    const r = await approve([second], { ask: forbidden('the question') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid "boundToCandidateToken"/);
  });

  it('429 too_many_machines at the decision: nothing approved, the candidacy is still pending, the limit is quoted and forget-relay-record is named', async () => {
    relay.force('/api/machines/candidacies', 429, { success: false, error: 'too_many_machines', limit: 10, message: 'This token already owns the maximum number of machines (10).' }, {}, 'PUT');
    const r = await approve([firstId]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/still pending/);
    expect(r.err).toContain('this token already owns the maximum (10) machines');
    expect(r.err).toContain('machine admin forget-relay-record <machine|uuid>');
    expect(r.err).toContain('This token already owns the maximum number of machines (10).');
    expect(relay.pendingIds()).toContain(firstId);
    // After the room is made, the same command goes through.
    expect((await approve([firstId])).code).toBe(0);
  });

  it('--json carries uuidBound, boundTokenLabel and boundToCandidateToken', async () => {
    expect((await approve([firstId])).code).toBe(0);
    await secondTokenPosts();
    await strayPosts();
    const r = await cli(adminDir, ['admin', 'approve', '--json', '--relay', relay.url]);
    const parsed = JSON.parse(r.out) as { uuidBound: boolean; boundTokenLabel?: string }[];
    expect(parsed.filter((c) => c.uuidBound)).toMatchObject([{ uuidBound: true, boundTokenLabel: 'machine-pairing', boundToCandidateToken: false }]);
  });

  it('confirmed: the binding moves to the new token; text from the relay is shown as printable ASCII', async () => {
    expect((await approve([firstId])).code).toBe(0);
    const second = await secondTokenPosts();
    // A tampered label: what the relay says is shown as printable ASCII.
    (relay.candidacies.get(second) as Record<string, unknown>).boundTokenLabel = 'ev\u001b[31mil';
    const asked: string[] = [];
    const r = await approve([second], { ask: async (l) => (asked.push(l), 'y') });
    expect(r.code, r.err).toBe(0);
    expect(asked[0]).toContain('"ev?[31mil"');
    expect(asked[0]).not.toContain('\u001b');
    expect(decisions()).toHaveLength(2);
  });
});

// A candidacy id is 128 random bits in base64url: about 1 in 4096 starts with "--", which the option parser took for an option.
describe('a candidacy id that starts with "--"', () => {
  beforeEach(async () => {
    await login();
  });

  it('is taken as the id when it names a pending candidacy (and is approved)', async () => {
    await candidatePosts();
    const real = [...relay.candidacies.keys()].at(-1) as string;
    const dashed = `--${real.slice(2)}`;
    const entry = relay.candidacies.get(real) as Record<string, unknown>;
    relay.candidacies.delete(real);
    relay.candidacies.set(dashed, entry as never);
    const r = await approve([dashed]);
    expect(r.code, r.err).toBe(0);
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]?.path).toContain(encodeURIComponent(dashed));
  });

  it('a prefix that starts with "--" works too, and --reject with such an id', async () => {
    await candidatePosts();
    const real = [...relay.candidacies.keys()].at(-1) as string;
    const dashed = `--${real.slice(2)}`;
    relay.candidacies.set(dashed, relay.candidacies.get(real) as never);
    relay.candidacies.delete(real);
    const r = await cli(adminDir, ['admin', 'approve', dashed.slice(0, 8), '--reject', '--relay', relay.url], async () => admin.passphrase, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/rejected/);
  });

  it('an unknown "--word" is still an unknown option (a typo is not taken for an id), saying that no candidacy matches either', async () => {
    await candidatePosts();
    const r = await approve(['--rejct']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown option "--rejct"/);
    expect(r.err).toMatch(/not the id of a pending candidacy/);
    expect(decisions()).toHaveLength(0);
  });

  it('on any other command an unknown option is refused as before', async () => {
    const r = await cli(adminDir, ['status', '--wat']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown option "--wat"/);
  });
});

describe('approving a machine that was revoked here earlier', () => {
  beforeEach(async () => {
    await login();
  });

  it('the detail says so, with the old serial, before the question (the machine comes back with a new registration)', async () => {
    await candidatePosts();
    expect((await approve()).code).toBe(0);
    const enrolled = await cli(cand, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes });
    expect(enrolled.code, enrolled.err).toBe(0);
    const revoked = await cli(adminDir, ['admin', 'revoke', 'laptop'], async () => admin.passphrase, { ask: yes });
    expect(revoked.code, revoked.err).toBe(0);
    const again = await cli(cand, ['join', '--resume', '--no-wait'], undefined, { timing: fakeTiming(), ask: yes });
    expect(again.code, again.err).toBe(0);
    const asked: string[] = [];
    const r = await approve([], { ask: async (l) => (asked.push(l), 'y') });
    expect(r.out).toMatch(/\[warn\] this machine was REVOKED on this machine earlier \(serial \d+\)/);
    expect(r.out).toMatch(/new registration/);
    expect(asked[0]).toMatch(/revoked here earlier/);
  });
});
