import { buildDocument as coreBuildDocument, documentId as coreDocumentId, nextPolicyBody as coreNext, signPolicy as coreSignPolicy, DOCUMENT_RETENTION_SECONDS as CORE_RETENTION, verifyInboxDocument, type PolicyBody, type PolicyChange, type PolicyEntry } from '@wadeck-app/machine-core';
import { keyId as coreKeyId } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, prng, uuid, webKeyFrom } from '../test-support/kit.js';
import { DEFAULT_APPLY_WINDOW_SECONDS, nextPolicyBody, policyDocumentFor } from './policyEdit.js';
import { signPolicy } from './documents.js';

// The browser builds the next policy itself (the page must not sign a body that a hostile backend wrote), so its rule is a copy of machine-core
// policyEdit.ts. These tests prove the copy gives the same answer on the same inputs, and that the document built from it is byte for byte the one
// `machine admin allow` sends (Ed25519 is deterministic).

const NOW = 1_800_000_000;
const TARGET = uuid();
const KEY_ID = coreKeyId(newPair().publicKey);

const entry = (shell: PolicyEntry['shell'], command: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell, command, ...(limits ? { limits } : {}) });

function base(version: number, defaults: PolicyEntry[], peers: Record<string, PolicyEntry[]> = {}): PolicyBody {
  return { v: 1, target: TARGET, version, baseVersion: version - 1, adminKeyId: KEY_ID, issuedAt: NOW - 100, notBefore: NOW - 100, notAfter: NOW + 1000, defaults, peers };
}

const ctx = { target: TARGET, adminKeyId: KEY_ID, now: NOW };

describe('nextPolicyBody (copy of machine-core policyEdit.ts)', () => {
  it('has the same default window', () => {
    expect(DEFAULT_APPLY_WINDOW_SECONDS).toBe(7 * 24 * 3600);
  });

  const peer = uuid();
  const other = uuid();
  const cases: Array<[string, PolicyBody | undefined, PolicyChange]> = [
    ['allow from nothing', undefined, { kind: 'allow', entry: entry('sh', 'uptime') }],
    ['allow on a policy', base(3, [entry('sh', 'ls')]), { kind: 'allow', entry: entry('cmd', 'dir') }],
    ['allow already there', base(3, [entry('sh', 'ls')]), { kind: 'allow', entry: entry('sh', 'ls') }],
    ['same command, other shell', base(3, [entry('sh', 'ls')]), { kind: 'allow', entry: entry('bash', 'ls') }],
    ['allow keeps the limits of the others', base(2, [entry('sh', 'ls', { maxCalls: 3 })]), { kind: 'allow', entry: entry('sh', 'pwd') }],
    ['allow with peers holding their own list', base(4, [entry('sh', 'ls')], { [peer]: [entry('sh', 'ls')] }), { kind: 'allow', entry: entry('sh', 'pwd') }],
    ['allow for a peer without a list', base(4, [entry('sh', 'ls')]), { kind: 'allow', entry: entry('sh', 'pwd'), peer }],
    ['allow for a peer with a list', base(4, [entry('sh', 'ls')], { [peer]: [entry('sh', 'id')] }), { kind: 'allow', entry: entry('sh', 'pwd'), peer }],
    ['remove one', base(5, [entry('sh', 'ls'), entry('sh', 'pwd')]), { kind: 'remove', command: 'ls' }],
    ['remove in one shell only', base(5, [entry('sh', 'ls'), entry('bash', 'ls')]), { kind: 'remove', command: 'ls', shell: 'bash' }],
    ['remove in every shell', base(5, [entry('sh', 'ls'), entry('bash', 'ls')]), { kind: 'remove', command: 'ls' }],
    ['remove what is not there', base(5, [entry('sh', 'ls')]), { kind: 'remove', command: 'pwd' }],
    ['remove from nothing', undefined, { kind: 'remove', command: 'pwd' }],
    ['remove for a peer without list', base(5, [entry('sh', 'ls')]), { kind: 'remove', command: 'ls', peer }],
    ['remove for a peer', base(5, [entry('sh', 'ls')], { [peer]: [entry('sh', 'ls'), entry('sh', 'id')], [other]: [] }), { kind: 'remove', command: 'id', peer }],
  ];

  it.each(cases)('%s: same result as machine-core', (_name, current, change) => {
    expect(nextPolicyBody(current, ctx, change)).toEqual(coreNext(current, ctx, change));
  });

  it('honours a custom window like machine-core', () => {
    const change: PolicyChange = { kind: 'allow', entry: entry('sh', 'ls') };
    expect(nextPolicyBody(undefined, { ...ctx, windowSeconds: 60 }, change)).toEqual(coreNext(undefined, { ...ctx, windowSeconds: 60 }, change));
  });

  it('agrees with machine-core on 200 random edits', () => {
    const rand = prng(7);
    const shells = ['cmd', 'ps', 'bash', 'sh'] as const;
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
    for (let i = 0; i < 200; i++) {
      const list = (): PolicyEntry[] => {
        const out: PolicyEntry[] = [];
        for (let n = Math.floor(rand() * 4); n > 0; n--) {
          const e = entry(pick(shells), `cmd${Math.floor(rand() * 5)}`);
          if (!out.some((x) => x.shell === e.shell && x.command === e.command)) out.push(e);
        }
        return out;
      };
      const peers: Record<string, PolicyEntry[]> = rand() < 0.5 ? { [peer]: list() } : {};
      const current = rand() < 0.2 ? undefined : base(1 + Math.floor(rand() * 9), list(), peers);
      const forPeer = rand() < 0.3 ? { peer } : {};
      const change: PolicyChange = rand() < 0.5 ? { kind: 'allow', entry: entry(pick(shells), `cmd${Math.floor(rand() * 5)}`), ...forPeer } : { kind: 'remove', command: `cmd${Math.floor(rand() * 5)}`, ...(rand() < 0.5 ? { shell: pick(shells) } : {}), ...forPeer };
      expect(nextPolicyBody(current, ctx, change), JSON.stringify({ current, change })).toEqual(coreNext(current, ctx, change));
    }
  });

  it('refuses a current policy written for another machine, with machine-core wording', () => {
    const foreign = { ...base(2, []), target: uuid() };
    const web = () => nextPolicyBody(foreign, ctx, { kind: 'allow', entry: entry('sh', 'ls') });
    const core = () => coreNext(foreign, ctx, { kind: 'allow', entry: entry('sh', 'ls') });
    expect(web).toThrow();
    expect((() => { try { web(); } catch (e) { return (e as Error).message; } return ''; })()).toBe((() => { try { core(); } catch (e) { return (e as Error).message; } return ''; })());
  });
});

describe('policyDocumentFor: the inbox document of a signed policy', () => {
  it('is byte for byte the document that machine-core builds for the same policy and key (same id, dates, signature)', async () => {
    const admin = newPair();
    const edit = coreNext(undefined, { target: TARGET, adminKeyId: coreKeyId(admin.publicKey), now: NOW }, { kind: 'allow', entry: entry('sh', 'uptime') });
    if (!edit.changed) throw new Error('expected a change');
    const signed = coreSignPolicy(edit.body, admin.privateKeyPkcs8);
    const key = await webKeyFrom(admin);
    // The same rule as `distributePolicy` of machine-cli.
    const expected = coreBuildDocument(
      { kind: 'policy', to: TARGET, id: coreDocumentId(`policy:${TARGET}:${signed.body.version}:${signed.signature}`), issuedAt: signed.body.issuedAt, expiresAt: Math.min(signed.body.issuedAt + CORE_RETENTION, signed.body.notAfter), payload: signed as never },
      admin.privateKeyPkcs8,
    );
    const document = await policyDocumentFor(signed, NOW, key);
    expect(document).toEqual(expected);
    expect(verifyInboxDocument(document, { adminPublicKey: admin.publicKey, now: NOW, selfUuid: TARGET }).ok).toBe(true);
    // A signature made in the browser is the same as the one of machine-core.
    expect(await signPolicy(edit.body, key)).toEqual(signed);
  });

  it('refuses a policy whose apply window has passed, naming the fix', async () => {
    const admin = newPair();
    const edit = coreNext(undefined, { target: TARGET, adminKeyId: coreKeyId(admin.publicKey), now: NOW }, { kind: 'allow', entry: entry('sh', 'uptime') });
    if (!edit.changed) throw new Error('expected a change');
    const signed = coreSignPolicy(edit.body, admin.privateKeyPkcs8);
    await expect(policyDocumentFor(signed, signed.body.notAfter + 1, await webKeyFrom(admin))).rejects.toThrow(/sign it again/);
  });
});
