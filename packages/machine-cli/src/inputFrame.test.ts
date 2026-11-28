import { randomBytes } from 'node:crypto';
import { INPUT_MAX_BYTES_CEILING, applyPolicy, generateSigningKeyPair, keyId, signPolicy, type PolicyBody } from '@wadeck-app/machine-core';
import type { RunOptions, RunResult } from '@wadeck-app/machine-exec';
import { DEFAULT_MAX_FRAME_BYTES, connectToPeer } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { runOnPeer, startPeerListener } from './peerService.js';

// The hard ceiling of a payload is binding (decision 114): the payload travels base64-encoded in the SAME frame as the signed request, over the real mutual TLS
// channel with the default frame cap, so the largest payload plus its encoding and the request must fit ONE frame (no chunking exists).

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

async function target(run: (o: RunOptions) => Promise<RunResult>) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const now = 1_800_000_000;
  const body: PolicyBody = {
    v: 3,
    target: B,
    version: 1,
    baseVersion: 0,
    adminKeyId: keyId(admin.publicKey),
    issuedAt: now,
    notBefore: now - 10,
    notAfter: now + 100_000,
    defaults: [{ shell: SHELL as 'cmd', command: 'big', input: { format: 'text', maxBytes: INPUT_MAX_BYTES_CEILING, chars: ['utf8-text'] } }],
    peers: {},
  };
  const applied = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(body, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now, targetUuid: B });
  if (!applied.ok) throw new Error(applied.message);
  const listener = await startPeerListener(
    {
      self: { uuid: B, name: 'b', createdAt: '', identity: b },
      directory: { lookup: (key) => (key === a.publicKey ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
      policy: () => applied.body,
      usage: { count: () => 0, record: () => undefined },
      audit: { write: () => undefined },
      now: () => now,
      run,
      onProblem: () => undefined,
    },
    { host: '127.0.0.1', port: 0 },
  );
  closers.push(() => listener.close());
  const session = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret });
  closers.push(() => session.close());
  return { session, a, now };
}

describe('the largest payload fits one frame of the real channel', () => {
  it('the ceiling is 512 KiB and the default frame cap is 1 MiB: 4/3 of the ceiling plus the request is well under it', () => {
    expect(INPUT_MAX_BYTES_CEILING).toBe(512 * 1024);
    const frame = Math.ceil(INPUT_MAX_BYTES_CEILING / 3) * 4 + 4096;
    expect(frame).toBeLessThan(DEFAULT_MAX_FRAME_BYTES);
  });

  it('a 512 KiB payload crosses the mutual TLS channel in one frame and reaches the command whole', async () => {
    const seen: number[] = [];
    const t = await target(async (o) => {
      seen.push(o.stdin?.length ?? -1);
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 };
    });
    // Not compressible text with characters that JSON would escape if the payload were put in a string: base64 keeps the frame at 4/3 whatever the bytes are.
    const payload = Buffer.alloc(INPUT_MAX_BYTES_CEILING);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 7 === 0 ? 0x0a : 0x21 + (i % 90);
    const answer = await runOnPeer(t.session, { identity: t.a, source: A, target: B, shell: SHELL as 'cmd', command: 'big', now: t.now, input: payload });
    expect(answer).toMatchObject({ type: 'result', exitCode: 0 });
    expect(seen).toEqual([INPUT_MAX_BYTES_CEILING]);
  });

  it('a payload above the ceiling is refused by the caller before anything is sent, with the fix', async () => {
    const t = await target(async () => {
      throw new Error('must not run');
    });
    await expect(runOnPeer(t.session, { identity: t.a, source: A, target: B, shell: SHELL as 'cmd', command: 'big', now: t.now, input: Buffer.alloc(INPUT_MAX_BYTES_CEILING + 1) })).rejects.toThrow(/512 KiB/);
  });
});
