import { entryFromText as coreEntryFromText, buildDocument as coreBuildDocument, documentId as coreDocumentId, nextPolicyBody as coreNext, nextPolicyBodyMany as coreMany, signPolicy as coreSignPolicy, DOCUMENT_RETENTION_SECONDS as CORE_RETENTION, verifyInboxDocument as coreVerifyDocument, verifyDocumentEnvelope, type PolicyBody, type PolicyChange, type PolicyEntry } from '@wadeck-app/machine-core';
import { keyId as coreKeyId } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, prng, uuid, webKeyFrom } from '../test-support/kit.js';
import { DEFAULT_APPLY_WINDOW_SECONDS, nextPolicyBody, nextPolicyBodyMany } from './policyEdit.js';
import { sealedPolicyDocument, signPolicy } from './documents.js';

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

  describe('typed entries, lifetimes, renewal, seeding, numbered removal (policy version 2)', () => {
    const T = (text: string, limits?: PolicyEntry['limits']): PolicyEntry => coreEntryFromText(text, 'sh', limits);
    const typedCases: Array<[string, PolicyBody | undefined, PolicyChange]> = [
      ['a typed entry from nothing', undefined, { kind: 'allow', entry: T('orch logs <j:name>') }],
      ['a typed entry on an exact v1 policy', base(2, [entry('sh', 'ls')]), { kind: 'allow', entry: T('orch logs <j:name>') }],
      ['an entry with calls', base(2, [entry('sh', 'ls')]), { kind: 'allow', entry: T('uptime', { maxCalls: 3 }) }],
      ['an entry with an end date', base(2, [entry('sh', 'ls')]), { kind: 'allow', entry: T('uptime', { expiresAt: NOW + 3600 }) }],
      ['a renewal with other limits', base(2, [entry('sh', 'ls', { maxCalls: 2 })]), { kind: 'allow', entry: T('ls', { maxCalls: 9 }) }],
      ['a renewal that makes it permanent', base(2, [entry('sh', 'ls', { maxCalls: 2 })]), { kind: 'allow', entry: T('ls') }],
      ['the same limits again', base(2, [entry('sh', 'ls', { maxCalls: 2 })]), { kind: 'allow', entry: T('ls', { maxCalls: 2 }) }],
      ['a typed renewal with another label', base(2, [T('x <p:int(1,5)>', { maxCalls: 1 })]), { kind: 'allow', entry: T('x <q:int(1,5)>', { maxCalls: 4 }) }],
      ['seeding a peer list from limited defaults', base(4, [entry('sh', 'ls'), entry('sh', 'uptime', { maxCalls: 3 }), entry('sh', 'df', { expiresAt: NOW + 5 })]), { kind: 'allow', entry: T('pwd'), peer }],
      ['seeding a peer list with a typed default', base(4, [T('x <n:int(1,5)>')]), { kind: 'allow', entry: T('pwd'), peer }],
      ['remove an ambiguous text', base(5, [entry('sh', 'ls'), entry('bash', 'ls')]), { kind: 'remove', command: 'ls' }],
      ['remove an ambiguous text narrowed by shell', base(5, [entry('sh', 'ls'), entry('bash', 'ls')]), { kind: 'remove', command: 'ls', shell: 'bash' }],
      ['remove by index', base(5, [entry('sh', 'ls'), T('x <n:int(1,5)>'), entry('sh', 'pwd')]), { kind: 'remove', index: 2 }],
      ['remove by an index out of the list', base(5, [entry('sh', 'ls')]), { kind: 'remove', index: 4 }],
      ['remove the last typed entry (back to v1)', base(5, [entry('sh', 'ls'), T('x <n:int(1,5)>')]), { kind: 'remove', command: 'x <n:int(1,5)>' }],
      ['remove a typed entry by its template', base(5, [T('x <n:int(1,5)>'), T('y <n:int(1,5)>')]), { kind: 'remove', command: 'y <n:int(1,5)>' }],
      ['remove by index in a peer list', base(5, [entry('sh', 'ls')], { [peer]: [entry('sh', 'id'), entry('sh', 'whoami')] }), { kind: 'remove', index: 1, peer }],
    ];
    it.each(typedCases)('%s: same result as machine-core', (_name, current, change) => {
      expect(nextPolicyBody(current, ctx, change)).toEqual(coreNext(current, ctx, change));
    });

    it('refuses an entry that cannot be signed with the same error as machine-core', () => {
      const messageOf = (run: () => unknown): string => {
        try {
          run();
        } catch (e) {
          return (e as Error).message;
        }
        return '';
      };
      for (const bad of [{ shell: 'sh', command: 'echo a > out' }, { shell: 'sh', template: 'orch logs' }, { shell: 'sh', command: 'orch logs <j:name>' }] as PolicyEntry[]) {
        const core = messageOf(() => coreNext(undefined, ctx, { kind: 'allow', entry: bad }));
        expect(core).not.toBe('');
        expect(messageOf(() => nextPolicyBody(undefined, ctx, { kind: 'allow', entry: bad }))).toBe(core);
      }
    });

    it('agrees with machine-core on 300 random edits that mix typed entries, limits, renewals, seeding and numbered removals', () => {
      const rand = prng(11);
      const shells = ['sh', 'bash'] as const;
      const pick = <U,>(list: readonly U[]): U => list[Math.floor(rand() * list.length)] as U;
      const texts = ['ls', 'pwd', 'x <a:int(1,5)>', 'x <b:int(1,5)>', 'x <a:int(1,6)>', 'y <n:name>', 'z <u:enum(p|q)>'];
      const limitsPool: Array<PolicyEntry['limits']> = [undefined, undefined, { maxCalls: 2 }, { maxCalls: 7 }, { expiresAt: NOW + 100 }];
      const make = (): PolicyEntry => coreEntryFromText(pick(texts), pick(shells), pick(limitsPool));
      for (let i = 0; i < 300; i++) {
        const list = (): PolicyEntry[] => {
          const out: PolicyEntry[] = [];
          for (let n = Math.floor(rand() * 5); n > 0; n--) {
            const e = make();
            if (!out.some((x) => JSON.stringify([x.shell, x.command ?? x.template]) === JSON.stringify([e.shell, e.command ?? e.template]))) {
              out.push(e);
            }
          }
          return out;
        };
        const defaults = list();
        const peers: Record<string, PolicyEntry[]> = rand() < 0.4 ? { [peer]: list() } : {};
        const hasTyped = [defaults, ...Object.values(peers)].some((l) => l.some((e) => e.template !== undefined));
        const current: PolicyBody | undefined = rand() < 0.15 ? undefined : { ...base(1 + Math.floor(rand() * 9), defaults, peers), v: hasTyped ? 2 : 1 };
        const forPeer = rand() < 0.3 ? { peer } : {};
        const change: PolicyChange =
          rand() < 0.55
            ? { kind: 'allow', entry: make(), ...forPeer }
            : rand() < 0.5
              ? { kind: 'remove', index: Math.floor(rand() * 7) - 1, ...forPeer }
              : { kind: 'remove', command: pick(texts), ...(rand() < 0.5 ? { shell: pick(shells) } : {}), ...forPeer };
        const run = (f: typeof nextPolicyBody): unknown => {
          try {
            return f(current, ctx, change);
          } catch (e) {
            return { threw: (e as Error).message };
          }
        };
        expect(run(nextPolicyBody), JSON.stringify({ current, change })).toEqual(run(coreNext));
      }
    });
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

describe('sealedPolicyDocument: the inbox document of a policy the page signed (sealed to the target, decision 78)', () => {
  // The seal is random, so the bytes differ between two builds: what must be equal is everything the rule decides (id, dates, kind, addressee) and
  // what the target reads once it opens the document with machine-core.
  const cases: Array<[string, boolean, PolicyChange]> = [
    ['an exact entry (policy version 1)', false, { kind: 'allow', entry: entry('sh', 'uptime') }],
    ['a typed entry (policy version 2)', true, { kind: 'allow', entry: coreEntryFromText('tail -n <n:int(1,500)> /var/log/syslog', 'sh') }],
    ['a typed entry with limits (policy version 2)', true, { kind: 'allow', entry: coreEntryFromText('ping -c <n:int(1,10)> <h:name(dot)>', 'sh', { maxCalls: 5, expiresAt: NOW + 86_400 }) }],
    ['an exact entry with limits (policy version 1)', false, { kind: 'allow', entry: entry('sh', 'uptime', { maxCalls: 3 }) }],
  ];

  for (const [name, typed, change] of cases) {
    it(`${name}: same id, dates and addressee as machine-core, and the target opens the very policy that was signed`, async () => {
      const admin = newPair();
      const target = newPair();
      const edit = coreNext(undefined, { target: TARGET, adminKeyId: coreKeyId(admin.publicKey), now: NOW }, change);
      if (!edit.changed) {
        throw new Error('expected a change');
      }
      expect(edit.body.v).toBe(typed ? 2 : 1);
      const signed = coreSignPolicy(edit.body, admin.privateKeyPkcs8);
      const key = await webKeyFrom(admin);
      const expected = coreBuildDocument(
        { kind: 'policy', to: TARGET, id: coreDocumentId(`v2:policy:${TARGET}:${signed.body.version}:${signed.signature}`), issuedAt: signed.body.issuedAt, expiresAt: Math.min(signed.body.issuedAt + CORE_RETENTION, signed.body.notAfter), payload: signed as never, recipientIdentityPublicKey: target.publicKey },
        admin.privateKeyPkcs8,
      );
      const document = await sealedPolicyDocument(signed, NOW, key, target.publicKey);
      const { payload: _web, ...webEnvelope } = document.body;
      const { payload: _core, ...coreEnvelope } = expected.body;
      expect(webEnvelope).toEqual(coreEnvelope);
      // The admin machine can check the envelope without opening it; the target opens it and finds the same policy.
      expect(verifyDocumentEnvelope(document, { adminPublicKey: admin.publicKey, now: NOW, selfUuid: TARGET }).ok).toBe(true);
      const opened = coreVerifyDocument(document, { adminPublicKey: admin.publicKey, now: NOW, selfUuid: TARGET, identityPrivateKeyPkcs8: target.privateKeyPkcs8 });
      expect(opened).toMatchObject({ ok: true });
      expect(opened.ok && opened.kind === 'policy' ? opened.policy : undefined).toEqual(signed);
      // A signature made in the browser is the same as the one of machine-core.
      expect(await signPolicy(edit.body, key)).toEqual(signed);
    });
  }

  it('refuses a policy whose apply window has passed, naming the fix', async () => {
    const admin = newPair();
    const edit = coreNext(undefined, { target: TARGET, adminKeyId: coreKeyId(admin.publicKey), now: NOW }, { kind: 'allow', entry: entry('sh', 'uptime') });
    if (!edit.changed) throw new Error('expected a change');
    const signed = coreSignPolicy(edit.body, admin.privateKeyPkcs8);
    await expect(sealedPolicyDocument(signed, signed.body.notAfter + 1, await webKeyFrom(admin), newPair().publicKey)).rejects.toThrow(/sign it again/);
  });
});

describe('nextPolicyBodyMany (copy of machine-core): several entries in one version', () => {
  const cases: Array<[string, PolicyBody | undefined, PolicyEntry[]]> = [
    ['three new entries on a policy', base(3, [entry('sh', 'ls')]), [entry('sh', 'a'), entry('sh', 'b'), entry('cmd', 'c')]],
    ['from nothing', undefined, [entry('sh', 'a'), entry('sh', 'b')]],
    ['a duplicate and an entry already there', base(3, [entry('sh', 'ls')]), [entry('sh', 'a'), entry('sh', 'a'), entry('sh', 'ls')]],
    ['everything already allowed', base(3, [entry('sh', 'ls')]), [entry('sh', 'ls')]],
    ['a renewal with other limits', base(3, [entry('sh', 'ls', { maxCalls: 1 })]), [entry('sh', 'ls', { maxCalls: 4 }), entry('sh', 'a')]],
    ['a typed entry among exact ones', base(3, [entry('sh', 'ls')]), [entry('sh', 'a'), coreEntryFromText('orch logs <j:name>', 'sh')]],
  ];
  it.each(cases)('%s: same result as machine-core', (_name, current, entries) => {
    expect(nextPolicyBodyMany(current, ctx, entries)).toEqual(coreMany(current, ctx, entries));
  });

  it('refuses an entry of the typed grammar and a full list with machine-core wording', () => {
    const messageOf = (run: () => unknown): string => { try { run(); } catch (e) { return (e as Error).message; } return ''; };
    const bad = [entry('sh', 'a'), entry('sh', 'echo <oops>')];
    expect(messageOf(() => nextPolicyBodyMany(base(1, []), ctx, bad))).not.toBe('');
    expect(messageOf(() => nextPolicyBodyMany(base(1, []), ctx, bad))).toBe(messageOf(() => coreMany(base(1, []), ctx, bad)));
    const full = base(1, Array.from({ length: 199 }, (_, i) => entry('sh', `c${i}`)));
    const two = [entry('sh', 'x'), entry('sh', 'y')];
    expect(messageOf(() => nextPolicyBodyMany(full, ctx, two))).toMatch(/at most 200/);
    expect(messageOf(() => nextPolicyBodyMany(full, ctx, two))).toBe(messageOf(() => coreMany(full, ctx, two)));
  });
});
