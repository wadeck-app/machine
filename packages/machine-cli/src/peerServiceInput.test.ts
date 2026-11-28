import { randomBytes } from 'node:crypto';
import { HoldTable, applyPolicy, generateSigningKeyPair, inputDigest, keyId, newRequest, signPolicy, signRequest, type InputDeclaration, type Json, type PolicyBody, type PolicyEntry } from '@wadeck-app/machine-core';
import type { RunOptions, RunResult } from '@wadeck-app/machine-exec';
import { connectToPeer, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { runOnPeer, startPeerListener, type PeerAnswer, type PeerServiceDeps } from './peerService.js';

// A payload on stdin (stdin-input.md, decision 114): the target checks, in order, that the entry declares an input, the size and the hash of the signed request,
// the whitelist union and the format, then writes the payload to the pipe of the command and records only its size and hash.

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const COMMAND = 'task remote-call';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

const JSON_INPUT: InputDeclaration = { format: 'json', maxBytes: 4096, chars: ['letters', 'digits', 'space', 'punct', 'json'] };
const entry = (input?: InputDeclaration, command = COMMAND, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell: SHELL as 'cmd', command, ...(input !== undefined ? { input } : {}), ...(limits !== undefined ? { limits } : {}) });
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const okResult = (): RunResult => ({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 });

async function until(what: string, condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function world(entries: PolicyEntry[]) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const counts = new Map<string, number>();
  const audit: Array<Record<string, Json>> = [];
  const runs: RunOptions[] = [];
  const now = { value: 1_800_000_000 };
  const table = new HoldTable();
  let policy: PolicyBody | undefined;
  const setPolicy = (list: PolicyEntry[]) => {
    const body: PolicyBody = {
      v: list.some((e) => e.input !== undefined) ? 3 : 1,
      target: B,
      version: (policy?.version ?? 0) + 1,
      baseVersion: policy?.version ?? 0,
      adminKeyId: keyId(admin.publicKey),
      issuedAt: now.value,
      notBefore: now.value - 10,
      notAfter: now.value + 100_000,
      defaults: list,
      peers: {},
    };
    const applied = applyPolicy({ version: policy?.version ?? 0, highestSeen: policy?.version ?? 0 }, signPolicy(body, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: now.value, targetUuid: B });
    if (!applied.ok) throw new Error(applied.message);
    policy = applied.body;
  };
  setPolicy(entries);
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: { lookup: (key) => (key === a.publicKey ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
    policy: () => policy,
    usage: { count: (k) => counts.get(k) ?? 0, record: (k) => void counts.set(k, (counts.get(k) ?? 0) + 1) },
    audit: { write: (e) => void audit.push(e) },
    now: () => now.value,
    run: async (o) => {
      runs.push(o);
      return okResult();
    },
    holds: { table, pollMs: 3 },
    onProblem: () => undefined,
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  const connect = async (): Promise<PeerSession> => {
    const s = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret });
    closers.push(() => s.close());
    return s;
  };
  const run = async (session: PeerSession, input: Uint8Array | undefined, over: { command?: string; waitSeconds?: number } = {}): Promise<PeerAnswer> =>
    runOnPeer(session, { identity: a, source: A, target: B, shell: SHELL as 'cmd', command: over.command ?? COMMAND, now: now.value, ...(input !== undefined ? { input } : {}), ...(over.waitSeconds !== undefined ? { waitSeconds: over.waitSeconds } : {}) });
  /** A frame built by hand: the signed digest and the bytes that travel can differ. */
  const sendRaw = async (session: PeerSession, signedFor: Uint8Array | undefined, travels: Uint8Array | undefined): Promise<PeerAnswer> => {
    const body = newRequest({ source: A, target: B, shell: SHELL as 'cmd', command: COMMAND, now: now.value, ...(signedFor !== undefined ? { input: inputDigest(signedFor) } : {}) });
    session.send({ type: 'run', request: signRequest(body, a.privateKeyPkcs8), ...(travels !== undefined ? { input: Buffer.from(travels).toString('base64') } : {}) });
    return (await session.next()) as PeerAnswer;
  };
  return { a, audit, runs, table, setPolicy, connect, run, sendRaw, now, counts };
}

describe('an entry that declares an input', () => {
  it('writes the payload to the command byte for byte, and the audit log keeps only its size and hash', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    const payload = enc('{"op": "get", "note": "café (ok)"}\n');
    const r = await w.run(s, payload);
    expect(r).toMatchObject({ type: 'result', exitCode: 0 });
    expect(w.runs).toHaveLength(1);
    expect(Buffer.from(w.runs[0]?.stdin as Uint8Array).equals(Buffer.from(payload))).toBe(true);
    // R1: the command line is the signed text, nothing of the payload travels in it
    expect(w.runs[0]?.command).toBe(COMMAND);
    expect(w.audit.find((e) => e.event === 'accepted')).toMatchObject({ command: COMMAND, input: inputDigest(payload) });
    // R4: no content anywhere in the audit log
    expect(JSON.stringify(w.audit)).not.toContain('caf');
    expect(JSON.stringify(w.audit)).not.toContain('"op"');
  });

  it('a request without payload runs with an empty stdin (declared, but nothing sent)', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    expect(await w.run(s, undefined)).toMatchObject({ type: 'result' });
    expect(w.runs[0]?.stdin).toBeDefined();
    expect((w.runs[0]?.stdin as Uint8Array).length).toBe(0);
  });

  it('refuses a payload larger than the declaration (input-too-large), runs nothing, counts nothing', async () => {
    const w = await world([entry({ ...JSON_INPUT, maxBytes: 16 }, COMMAND, { maxCalls: 1 })]);
    const s = await w.connect();
    const r = await w.run(s, enc('{"a":"aaaaaaaaaaaaaaaaaaaaaaaa"}'));
    expect(r).toMatchObject({ type: 'refused', reason: 'input-too-large' });
    expect((r as { message: string }).message).toMatch(/at most 16 bytes/);
    expect(w.runs).toHaveLength(0);
    expect(w.counts.size).toBe(0);
    expect(w.audit.find((e) => e.event === 'refused')).toMatchObject({ reason: 'input-too-large', input: { bytes: 32 } });
  });

  it.each([
    ['a character outside the union', '{"a":"x;y"}', 'input-chars'],
    ['NUL', '{"a":"x\u0000y"}', 'input-chars'],
    ['a bidi control', '{"a":"x\u202ey"}', 'input-chars'],
    ['not JSON', '{"a":', 'input-format'],
    ['a duplicate key', '{"a":1,"a":2}', 'input-format'],
    ['a prototype key', '{"__proto__":1}', 'input-format'],
    ['too deep', `${'['.repeat(33)}${']'.repeat(33)}`, 'input-format'],
  ])('refuses %s (%s)', async (_name, text, reason) => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    const r = await w.run(s, enc(text));
    expect(r).toMatchObject({ type: 'refused', reason });
    expect(w.runs).toHaveLength(0);
    expect(w.counts.size).toBe(0);
  });

  it('refuses bytes that are not UTF-8 (input-format)', async () => {
    const w = await world([entry({ format: 'text', maxBytes: 100, chars: ['utf8-text'] })]);
    const s = await w.connect();
    expect(await w.run(s, new Uint8Array([0x61, 0xff]))).toMatchObject({ type: 'refused', reason: 'input-format' });
  });

  it('the refusal of a character names its code point and place, never the character or the payload', async () => {
    const w = await world([entry({ format: 'text', maxBytes: 100, chars: ['letters'] })]);
    const s = await w.connect();
    const r = (await w.run(s, enc('abc;def'))) as { message: string };
    expect(r.message).toMatch(/U\+003B/);
    expect(r.message).not.toContain('abc');
    expect(JSON.stringify(w.audit)).not.toContain('abc');
  });

  it('a payload made of shell metacharacters and newlines is accepted by utf8-text and reaches stdin untouched', async () => {
    const w = await world([entry({ format: 'text', maxBytes: 200, chars: ['utf8-text'] })]);
    const s = await w.connect();
    const payload = enc('$(id) `x` ; & | > < " \' %PATH%\nline 2 é日\n');
    expect(await w.run(s, payload)).toMatchObject({ type: 'result' });
    expect(Buffer.from(w.runs[0]?.stdin as Uint8Array).equals(Buffer.from(payload))).toBe(true);
    expect(w.runs[0]?.command).toBe(COMMAND);
  });
});

describe('an entry that declares no input', () => {
  it('refuses a payload (input-not-allowed): no declaration, no input', async () => {
    const w = await world([entry(undefined)]);
    const s = await w.connect();
    const r = await w.run(s, enc('{}'));
    expect(r).toMatchObject({ type: 'refused', reason: 'input-not-allowed' });
    expect((r as { message: string }).message).toMatch(/--stdin/);
    expect(w.runs).toHaveLength(0);
    expect(w.counts.size).toBe(0);
  });
  it('a request without payload runs with stdin closed, as before', async () => {
    const w = await world([entry(undefined)]);
    const s = await w.connect();
    expect(await w.run(s, undefined)).toMatchObject({ type: 'result' });
    expect(w.runs[0]?.stdin).toBeUndefined();
    expect(w.audit.find((e) => e.event === 'accepted')?.input).toBeUndefined();
  });
  it('a command that is not listed stays not-listed whatever it carries', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    expect(await w.run(s, enc('{}'), { command: 'other thing' })).toMatchObject({ type: 'refused', reason: 'not-listed' });
  });
});

describe('what is signed and what travels must agree', () => {
  it('a payload swapped after signing (same size, other bytes) is refused: the hash is in the signed body', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    const r = await w.sendRaw(s, enc('{"op":"get"}'), enc('{"op":"del"}'));
    expect(r).toMatchObject({ type: 'refused', reason: 'input-format' });
    expect((r as { message: string }).message).toMatch(/does not match the size and hash/);
    expect(w.runs).toHaveLength(0);
  });
  it('a payload of another size than signed is refused', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    expect(await w.sendRaw(s, enc('{"op":"get"}'), enc('{"op":"get"} '))).toMatchObject({ type: 'refused', reason: 'input-format' });
  });
  it('a signed input with no payload, and a payload the signed body does not declare, are refused', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    expect(await w.sendRaw(s, enc('{}'), undefined)).toMatchObject({ type: 'refused', reason: 'input-format' });
    expect(await w.sendRaw(s, undefined, enc('{}'))).toMatchObject({ type: 'refused', reason: 'input-format' });
    expect(w.runs).toHaveLength(0);
  });
  it('a payload that is not base64 is refused', async () => {
    const w = await world([entry(JSON_INPUT)]);
    const s = await w.connect();
    const payload = enc('{}');
    const body = newRequest({ source: A, target: B, shell: SHELL as 'cmd', command: COMMAND, now: w.now.value, input: inputDigest(payload) });
    // correctly signed: only the field of the frame is corrupt
    s.send({ type: 'run', request: signRequest(body, w.a.privateKeyPkcs8), input: '***not base64***' });
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'input-format' });
    expect(w.runs).toHaveLength(0);
  });
});

describe('a held request keeps its payload in memory only', () => {
  it('holds it, shows size and hash in the audit log, and releases it to the command once an Allow declares the input', async () => {
    const w = await world([entry(undefined, 'something else')]);
    const s = await w.connect();
    const payload = enc('{"op":"get"}');
    const pending = w.run(s, payload, { waitSeconds: 600 });
    await until('the hold', () => w.table.list().length === 1);
    const hold = w.table.list()[0] as { id: string; input?: { bytes: number; sha256: string } };
    expect(hold.input).toEqual(inputDigest(payload));
    expect(Buffer.from(w.table.inputOf(hold.id) as Uint8Array).equals(Buffer.from(payload))).toBe(true);
    const held = w.audit.find((e) => e.event === 'held');
    expect(held).toMatchObject({ input: inputDigest(payload) });
    expect(JSON.stringify(w.audit)).not.toContain('"op"');
    w.setPolicy([entry(JSON_INPUT)]);
    expect(await pending).toMatchObject({ type: 'result' });
    expect(Buffer.from(w.runs[0]?.stdin as Uint8Array).equals(Buffer.from(payload))).toBe(true);
    expect(w.table.inputOf(hold.id)).toBeUndefined();
  });

  it('an Allow that lists the command WITHOUT an input declaration refuses the held payload (input-not-allowed), nothing runs, the bytes are gone', async () => {
    const w = await world([entry(undefined, 'something else')]);
    const s = await w.connect();
    const pending = w.run(s, enc('{"op":"get"}'), { waitSeconds: 600 });
    await until('the hold', () => w.table.list().length === 1);
    const id = (w.table.list()[0] as { id: string }).id;
    w.setPolicy([entry(undefined)]);
    const r = await pending;
    expect(r).toMatchObject({ type: 'refused', reason: 'input-not-allowed' });
    expect(w.runs).toHaveLength(0);
    expect(w.table.inputOf(id)).toBeUndefined();
  });

  it('a Deny drops the payload with the hold', async () => {
    const w = await world([entry(undefined, 'something else')]);
    const s = await w.connect();
    const pending = w.run(s, enc('{}'), { waitSeconds: 600 });
    await until('the hold', () => w.table.list().length === 1);
    const id = (w.table.list()[0] as { id: string }).id;
    w.table.deny(id, 'no');
    expect(await pending).toMatchObject({ type: 'refused', reason: 'denied' });
    expect(w.table.inputOf(id)).toBeUndefined();
  });
});
