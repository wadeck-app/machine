import { describe, expect, it } from 'vitest';
import { assertPolicyBody, type PolicyBody, type PolicyEntry } from './policy.js';
import { entryFromText, nextPolicyBody, type PolicyChange } from './policyEdit.js';
import { TemplateError } from './typedParams.js';

// Typed entries, lifetimes, renewal, seeding and `--remove` of the policy edit (typed-parameters.md).

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const KEY = 'a'.repeat(32);
const ctx = { target: TARGET, adminKeyId: KEY, now: NOW };

const E = (shell: PolicyEntry['shell'], text: string, limits?: PolicyEntry['limits']): PolicyEntry => entryFromText(text, shell, limits);
function base(version: number, defaults: PolicyEntry[], peers: Record<string, PolicyEntry[]> = {}, v: 1 | 2 = 1): PolicyBody {
  return { v, target: TARGET, version, baseVersion: version - 1, adminKeyId: KEY, issuedAt: NOW - 100, notBefore: NOW - 100, notAfter: NOW + 1000, defaults, peers };
}
const changed = (current: PolicyBody | undefined, change: PolicyChange) => {
  const edit = nextPolicyBody(current, ctx, change);
  if (!edit.changed) {
    throw new Error(`expected a change, got ${edit.reason}`);
  }
  return edit;
};

describe('entryFromText: the entry of a signing request', () => {
  it('builds an exact entry from a text without angle bracket, a typed one from a template', () => {
    expect(entryFromText('uptime', 'sh')).toEqual({ shell: 'sh', command: 'uptime' });
    expect(entryFromText('orch logs <j:name>', 'sh')).toEqual({ shell: 'sh', template: 'orch logs <j:name>' });
    expect(entryFromText('uptime', 'sh', { maxCalls: 3 })).toEqual({ shell: 'sh', command: 'uptime', limits: { maxCalls: 3 } });
  });
  it('refuses a malformed placeholder instead of keeping it as an exact entry', () => {
    for (const text of ['orch logs <j', 'echo a > out', 'orch <j:frob>', 'a  b <j:name>']) expect(() => entryFromText(text, 'sh'), text).toThrow(TemplateError);
  });
});

describe('policy version: v2 only when a typed entry exists', () => {
  it('an exact-only policy stays v1', () => {
    const edit = changed(undefined, { kind: 'allow', entry: E('sh', 'uptime') });
    expect(edit.body.v).toBe(1);
    const again = changed(edit.body, { kind: 'allow', entry: E('sh', 'ls', { maxCalls: 2 }) });
    expect(again.body.v).toBe(1);
  });

  it('adding a typed entry makes the next version v2, keeping the exact entries', () => {
    const v1 = changed(undefined, { kind: 'allow', entry: E('sh', 'uptime') }).body;
    const edit = changed(v1, { kind: 'allow', entry: E('sh', 'orch logs <j:name>') });
    expect(edit.body.v).toBe(2);
    expect(edit.body.defaults).toEqual([E('sh', 'uptime'), E('sh', 'orch logs <j:name>')]);
    expect(() => assertPolicyBody(edit.body)).not.toThrow();
  });

  it('a typed entry in a peer list makes it v2 too; removing the last typed entry goes back to v1', () => {
    const edit = changed(base(1, [E('sh', 'ls')]), { kind: 'allow', entry: E('sh', 'orch logs <j:name>'), peer: PEER });
    expect(edit.body.v).toBe(2);
    const back = changed(edit.body, { kind: 'remove', command: 'orch logs <j:name>', peer: PEER });
    expect(back.body.v).toBe(1);
  });

  it('refuses to sign an entry whose text is not valid, naming the cause', () => {
    expect(() => nextPolicyBody(undefined, ctx, { kind: 'allow', entry: { shell: 'sh', command: 'echo a > out' } })).toThrow(TemplateError);
    expect(() => nextPolicyBody(undefined, ctx, { kind: 'allow', entry: { shell: 'sh', template: 'orch logs' } })).toThrow(/no placeholder/);
    expect(() => nextPolicyBody(undefined, ctx, { kind: 'allow', entry: { shell: 'sh', command: 'orch logs <j:name>' } })).toThrow(TemplateError);
  });
});

describe('renewal: signing an entry that exists with other limits replaces its limits', () => {
  it('reports the renewal, not already-allowed', () => {
    const current = base(2, [E('sh', 'ls', { maxCalls: 2 })]);
    const edit = changed(current, { kind: 'allow', entry: E('sh', 'ls', { maxCalls: 9 }) });
    expect(edit.body.defaults).toEqual([E('sh', 'ls', { maxCalls: 9 })]);
    expect(edit.added).toEqual([]);
    expect(edit.renewed).toEqual([{ before: E('sh', 'ls', { maxCalls: 2 }), after: E('sh', 'ls', { maxCalls: 9 }) }]);
    expect(edit.body.version).toBe(3);
  });

  it('can make a limited entry permanent, and a permanent one limited', () => {
    expect(changed(base(2, [E('sh', 'ls', { maxCalls: 2 })]), { kind: 'allow', entry: E('sh', 'ls') }).body.defaults).toEqual([E('sh', 'ls')]);
    expect(changed(base(2, [E('sh', 'ls')]), { kind: 'allow', entry: E('sh', 'ls', { expiresAt: NOW + 60 }) }).body.defaults).toEqual([E('sh', 'ls', { expiresAt: NOW + 60 })]);
  });

  it('the same limits again is already-allowed', () => {
    expect(nextPolicyBody(base(2, [E('sh', 'ls', { maxCalls: 2 })]), ctx, { kind: 'allow', entry: E('sh', 'ls', { maxCalls: 2 }) })).toEqual({ changed: false, reason: 'already-allowed' });
    expect(nextPolicyBody(base(2, [E('sh', 'ls')]), ctx, { kind: 'allow', entry: E('sh', 'ls') })).toEqual({ changed: false, reason: 'already-allowed' });
  });

  it('a typed entry is the same entry whatever its labels: it is renewed in place, with the new text', () => {
    const current = base(2, [E('sh', 'a'), E('sh', 'x <p:int(1,5)>', { maxCalls: 1 }), E('sh', 'z')], {}, 2);
    const edit = changed(current, { kind: 'allow', entry: E('sh', 'x <other:int(1,5)>', { maxCalls: 4 }) });
    expect(edit.body.defaults).toEqual([E('sh', 'a'), E('sh', 'x <other:int(1,5)>', { maxCalls: 4 }), E('sh', 'z')]);
    expect(nextPolicyBody(current, ctx, { kind: 'allow', entry: E('sh', 'x <q:int(1,5)>', { maxCalls: 1 }) })).toEqual({ changed: false, reason: 'already-allowed' });
  });

  it('a different bound is a different entry, added next to the first', () => {
    const edit = changed(base(2, [E('sh', 'x <p:int(1,5)>')], {}, 2), { kind: 'allow', entry: E('sh', 'x <p:int(1,6)>') });
    expect(edit.body.defaults).toHaveLength(2);
    expect(edit.added).toHaveLength(1);
  });
});

describe('seeding a per-peer list from the defaults copies the permanent entries only', () => {
  const defaults = [E('sh', 'ls'), E('sh', 'uptime', { maxCalls: 3 }), E('sh', 'df', { expiresAt: NOW + 100 }), E('sh', 'id')];

  it('leaves the limited entries out and says which', () => {
    const edit = changed(base(4, defaults), { kind: 'allow', entry: E('sh', 'pwd'), peer: PEER });
    expect(edit.seededPeerList).toBe(true);
    expect(edit.body.peers[PEER]).toEqual([E('sh', 'ls'), E('sh', 'id'), E('sh', 'pwd')]);
    expect(edit.leftOut).toEqual([E('sh', 'uptime', { maxCalls: 3 }), E('sh', 'df', { expiresAt: NOW + 100 })]);
    // The default list is untouched, with its limits.
    expect(edit.body.defaults).toEqual(defaults);
  });

  it('nothing is left out when every default entry is permanent, or when the peer already has a list', () => {
    expect(changed(base(4, [E('sh', 'ls')]), { kind: 'allow', entry: E('sh', 'pwd'), peer: PEER }).leftOut).toEqual([]);
    expect(changed(base(4, defaults, { [PEER]: [E('sh', 'ls')] }), { kind: 'allow', entry: E('sh', 'pwd'), peer: PEER }).leftOut).toEqual([]);
    expect(changed(base(4, defaults), { kind: 'allow', entry: E('sh', 'pwd') }).leftOut).toEqual([]);
  });

  it('allowing for a peer an entry the defaults hold with limits adds it permanently (it was left out)', () => {
    const edit = changed(base(4, defaults), { kind: 'allow', entry: E('sh', 'uptime'), peer: PEER });
    expect(edit.body.peers[PEER]).toContainEqual(E('sh', 'ls'));
    expect(edit.body.peers[PEER]).toContainEqual(E('sh', 'uptime'));
    expect(edit.renewed).toEqual([]);
  });

  it('seeds typed entries too, and the peer list makes the body v2', () => {
    const edit = changed(base(4, [E('sh', 'x <n:int(1,5)>')], {}, 2), { kind: 'allow', entry: E('sh', 'pwd'), peer: PEER });
    expect(edit.body.peers[PEER]).toEqual([E('sh', 'x <n:int(1,5)>'), E('sh', 'pwd')]);
    expect(edit.body.v).toBe(2);
  });
});

describe('--remove: by text, by index, refusing and listing when ambiguous', () => {
  const list = [E('sh', 'ls'), E('bash', 'ls'), E('sh', 'x <n:int(1,5)>'), E('sh', 'pwd')];
  const current = base(5, list, {}, 2);

  it('removes the only entry that has this text', () => {
    expect(changed(current, { kind: 'remove', command: 'pwd' }).body.defaults).toEqual(list.slice(0, 3));
    expect(changed(current, { kind: 'remove', command: 'x <n:int(1,5)>' }).removed).toEqual([E('sh', 'x <n:int(1,5)>')]);
  });

  it('several entries share the text: refuses and lists them with their index', () => {
    expect(nextPolicyBody(current, ctx, { kind: 'remove', command: 'ls' })).toEqual({
      changed: false,
      reason: 'ambiguous',
      candidates: [{ index: 1, entry: E('sh', 'ls') }, { index: 2, entry: E('bash', 'ls') }],
    });
  });

  it('the shell narrows it down', () => {
    expect(changed(current, { kind: 'remove', command: 'ls', shell: 'bash' }).removed).toEqual([E('bash', 'ls')]);
  });

  it('the index (1-based, as `machine allowed` shows it) removes that entry', () => {
    expect(changed(current, { kind: 'remove', index: 2 }).removed).toEqual([E('bash', 'ls')]);
    expect(changed(current, { kind: 'remove', index: 3 }).removed).toEqual([E('sh', 'x <n:int(1,5)>')]);
  });

  it('an index out of the list changes nothing', () => {
    for (const index of [0, 5, -1, 1.5]) expect(nextPolicyBody(current, ctx, { kind: 'remove', index }), String(index)).toEqual({ changed: false, reason: 'bad-index' });
  });

  it('a text that is not there changes nothing', () => {
    expect(nextPolicyBody(current, ctx, { kind: 'remove', command: 'nothing' })).toEqual({ changed: false, reason: 'not-allowed' });
  });

  it('the index of a per-peer list is the index in that list', () => {
    const withPeer = base(5, list, { [PEER]: [E('sh', 'id'), E('sh', 'whoami')] }, 2);
    expect(changed(withPeer, { kind: 'remove', index: 2, peer: PEER }).removed).toEqual([E('sh', 'whoami')]);
    expect(nextPolicyBody(base(5, list, {}, 2), ctx, { kind: 'remove', index: 1, peer: PEER })).toEqual({ changed: false, reason: 'not-allowed' });
  });
});
