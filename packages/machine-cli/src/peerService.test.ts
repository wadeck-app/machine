import { randomBytes } from 'node:crypto';
import {
  applyPolicy,
  generateSigningKeyPair,
  keyId,
  newRequest,
  signPolicy,
  signRequest,
  type Json,
  type PolicyBody,
  type PolicyEntry,
} from '@wadeck-app/machine-core';
import { connectToPeer } from '@wadeck-app/machine-transport';
import { runCommand, type RunOptions, type RunResult } from '@wadeck-app/machine-exec';
import { afterEach, describe, expect, it } from 'vitest';
import { runOnPeer, startPeerListener, type PeerServiceDeps } from './peerService.js';

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const C = '8d6e2f30-4b5c-4d7e-9f80-bcdef0123456';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

class MemoryUsage {
  readonly counts = new Map<string, number>();
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  record(key: string): void {
    this.counts.set(key, this.count(key) + 1);
  }
}

class MemoryAudit {
  readonly entries: Array<Record<string, Json>> = [];
  write(entry: Record<string, Json>): void {
    this.entries.push(entry);
  }
  events(): string[] {
    return this.entries.map((e) => String(e.event));
  }
}

function okResult(stdout = 'out'): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 };
}

interface World {
  a: ReturnType<typeof generateSigningKeyPair>;
  b: ReturnType<typeof generateSigningKeyPair>;
  secret: Buffer;
  usage: MemoryUsage;
  audit: MemoryAudit;
  runs: RunOptions[];
  port: number;
  setPolicy: (entries: PolicyEntry[], peerEntries?: Record<string, PolicyEntry[]>) => void;
  connect: (secret?: Buffer) => ReturnType<typeof connectToPeer>;
  now: { value: number };
}

async function world(over: { run?: (o: RunOptions) => Promise<RunResult>; realRun?: boolean; maxConcurrent?: number; noPolicy?: boolean; onProblem?: (m: string) => void; maxRefusalsPerSession?: number } = {}): Promise<World> {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const usage = new MemoryUsage();
  const audit = new MemoryAudit();
  const runs: RunOptions[] = [];
  const now = { value: 1_800_000_000 };
  let policy: PolicyBody | undefined;
  const setPolicy = (entries: PolicyEntry[], peerEntries: Record<string, PolicyEntry[]> = {}) => {
    const body: PolicyBody = {
      v: 1,
      target: B,
      version: (policy?.version ?? 0) + 1,
      baseVersion: policy?.version ?? 0,
      adminKeyId: keyId(admin.publicKey),
      issuedAt: now.value,
      notBefore: now.value - 10,
      notAfter: now.value + 1000,
      defaults: entries,
      peers: peerEntries,
    };
    const applied = applyPolicy({ version: policy?.version ?? 0, highestSeen: policy?.version ?? 0 }, signPolicy(body, admin.privateKeyPkcs8), {
      adminPublicKey: admin.publicKey,
      now: now.value,
      targetUuid: B,
    });
    if (!applied.ok) throw new Error(applied.message);
    policy = applied.body;
  };
  if (!over.noPolicy) setPolicy([{ shell: SHELL, command: 'echo hello' }]);

  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: {
      lookup: (key) => (key === a.publicKey ? { peerId: A, name: 'a', pairSecret: secret } : undefined),
    },
    policy: () => policy,
    usage,
    audit,
    now: () => now.value,
    run: async (o) => {
      runs.push(o);
      if (over.realRun) return runCommand(o);
      return over.run ? over.run(o) : okResult();
    },
    ...(over.maxConcurrent !== undefined ? { maxConcurrent: over.maxConcurrent } : {}),
    ...(over.onProblem ? { onProblem: over.onProblem } : {}),
    ...(over.maxRefusalsPerSession !== undefined ? { maxRefusalsPerSession: over.maxRefusalsPerSession } : {}),
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  return {
    a,
    b,
    secret,
    usage,
    audit,
    runs,
    port: listener.port,
    setPolicy,
    now,
    connect: (s = secret) => connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: s }),
  };
}

async function ask(w: World, command: string, shell: string = SHELL, session?: Awaited<ReturnType<World['connect']>>) {
  const s = session ?? (await w.connect());
  if (!session) closers.push(() => s.close());
  return runOnPeer(s, { identity: w.a, source: A, target: B, shell: shell as 'cmd', command, now: w.now.value });
}

describe('peer service', () => {
  it('runs an allowed command and returns its output, auditing acceptance and completion', async () => {
    const w = await world();
    const answer = await ask(w, 'echo hello');
    expect(answer).toMatchObject({ type: 'result', exitCode: 0, stdout: 'out' });
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]).toMatchObject({ shell: SHELL, command: 'echo hello' });
    expect(w.audit.events()).toEqual(['accepted', 'completed']);
    expect(w.audit.entries[0]).toMatchObject({ source: A, command: 'echo hello' });
  });

  it('runs the real shell end to end: signed request, pinned TLS channel, policy, then the actual command', async () => {
    const w = await world({ realRun: true });
    const answer = await ask(w, 'echo hello');
    expect(answer).toMatchObject({ type: 'result', exitCode: 0 });
    expect((answer as { stdout: string }).stdout.trim()).toBe('hello');
  });

  it('refuses a command that is not in the policy, runs nothing and audits the refusal', async () => {
    const w = await world();
    const answer = await ask(w, 'echo hello && echo more');
    expect(answer).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect(w.runs).toHaveLength(0);
    expect(w.audit.events()).toEqual(['refused']);
    expect(w.audit.entries[0]).toMatchObject({ reason: 'not-listed' });
  });

  it('refuses everything, with the fix, when no policy is installed', async () => {
    const w = await world({ noPolicy: true });
    const answer = await ask(w, 'echo hello');
    expect(answer).toMatchObject({ type: 'refused', reason: 'no-policy' });
    expect((answer as { message: string }).message).toMatch(/admin/);
    expect(w.runs).toHaveLength(0);
  });

  it('refuses a replayed request and runs the command once', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    const signed = signRequest(newRequest({ source: A, target: B, shell: SHELL as 'cmd', command: 'echo hello', now: w.now.value }), w.a.privateKeyPkcs8);
    session.send({ type: 'run', request: signed });
    expect(await session.next()).toMatchObject({ type: 'result' });
    session.send({ type: 'run', request: signed });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'replay' });
    expect(w.runs).toHaveLength(1);
  });

  it('refuses a request that claims another source than the authenticated peer', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    const signed = signRequest(newRequest({ source: C, target: B, shell: SHELL as 'cmd', command: 'echo hello', now: w.now.value }), w.a.privateKeyPkcs8);
    session.send({ type: 'run', request: signed });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'source-mismatch' });
    expect(w.runs).toHaveLength(0);
  });

  it('refuses an expired request', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    const signed = signRequest(newRequest({ source: A, target: B, shell: SHELL as 'cmd', command: 'echo hello', now: w.now.value - 500 }), w.a.privateKeyPkcs8);
    session.send({ type: 'run', request: signed });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'expired' });
  });

  it('refuses a request addressed to another machine', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    const signed = signRequest(newRequest({ source: A, target: C, shell: SHELL as 'cmd', command: 'echo hello', now: w.now.value }), w.a.privateKeyPkcs8);
    session.send({ type: 'run', request: signed });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'wrong-target' });
  });

  it('enforces maxCalls across requests and records a call only when accepted', async () => {
    const w = await world();
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo hello', limits: { maxCalls: 2 } }]);
    expect(await ask(w, 'echo hello')).toMatchObject({ type: 'result' });
    expect(await ask(w, 'echo hello')).toMatchObject({ type: 'result' });
    expect(await ask(w, 'echo hello')).toMatchObject({ type: 'refused', reason: 'exhausted' });
    expect(await ask(w, 'echo nope')).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect([...w.usage.counts.values()]).toEqual([2]);
  });

  it('uses the peer-specific list instead of the default when there is one', async () => {
    const w = await world();
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo hello' }], { [A]: [{ shell: SHELL as 'cmd', command: 'echo only-for-a' }] });
    expect(await ask(w, 'echo hello')).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect(await ask(w, 'echo only-for-a')).toMatchObject({ type: 'result' });
  });

  it('answers an unknown message type with a refusal and keeps the session usable', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    session.send({ type: 'shutdown-everything' });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'unknown-message' });
    expect(await ask(w, 'echo hello', SHELL, session)).toMatchObject({ type: 'result' });
  });

  it('answers a malformed request with a refusal, not a crash', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    session.send({ type: 'run', request: { body: 'nope', signature: 5 } });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'malformed' });
  });

  it('refuses a second command while the global concurrency limit is reached', async () => {
    let release: (r: RunResult) => void = () => undefined;
    const w = await world({ maxConcurrent: 1, run: () => new Promise<RunResult>((resolve) => (release = resolve)) });
    w.setPolicy([
      { shell: SHELL as 'cmd', command: 'echo hello' },
      { shell: SHELL as 'cmd', command: 'echo second' },
    ]);
    const s1 = await w.connect();
    const s2 = await w.connect();
    closers.push(() => s1.close(), () => s2.close());
    const first = ask(w, 'echo hello', SHELL, s1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await ask(w, 'echo second', SHELL, s2)).toMatchObject({ type: 'refused', reason: 'busy' });
    release(okResult());
    expect(await first).toMatchObject({ type: 'result' });
  });

  it('reports a launch failure as a refusal with the cause, and audits it', async () => {
    const w = await world({
      run: async () => {
        throw new Error('cannot start shell "ps" (spawn pwsh ENOENT)');
      },
    });
    const answer = await ask(w, 'echo hello');
    expect(answer).toMatchObject({ type: 'refused', reason: 'cannot-run' });
    expect((answer as { message: string }).message).toMatch(/pwsh/);
    expect(w.audit.events()).toEqual(['accepted', 'failed']);
  });

  it('does not let a peer with a wrong pair secret reach the policy at all', async () => {
    const w = await world();
    await expect(w.connect(randomBytes(32))).rejects.toThrow(/pair secret/);
    expect(w.audit.events()).toEqual([]);
    expect(w.runs).toHaveLength(0);
  });
});

describe('peer service resilience', () => {
  it('survives a store that throws: answers internal-error, runs nothing, keeps serving', async () => {
    const w = await world();
    let fail = true;
    const original = w.usage.record.bind(w.usage);
    w.usage.record = (key: string) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      original(key);
    };
    const session = await w.connect();
    closers.push(() => session.close());
    expect(await ask(w, 'echo hello', SHELL, session)).toMatchObject({ type: 'refused', reason: 'internal-error' });
    expect(w.runs).toHaveLength(0);
    expect(await ask(w, 'echo hello', SHELL, session)).toMatchObject({ type: 'result' });
  });

  it('does not run a command it cannot audit (no audit, no execution)', async () => {
    const w = await world();
    const original = w.audit.write.bind(w.audit);
    w.audit.write = (entry) => {
      if (entry.event === 'accepted') throw new Error('audit disk unavailable');
      original(entry);
    };
    const answer = await ask(w, 'echo hello');
    expect(answer).toMatchObject({ type: 'refused', reason: 'audit-unavailable' });
    expect(w.runs).toHaveLength(0);
    expect([...w.usage.counts.values()]).toEqual([]);
  });

  it('still returns the result of a command that ran when the completion audit fails, and reports the problem', async () => {
    const problems: string[] = [];
    const w = await world({ onProblem: (m) => problems.push(m) });
    const original = w.audit.write.bind(w.audit);
    w.audit.write = (entry) => {
      if (entry.event === 'completed') throw new Error('audit disk unavailable');
      original(entry);
    };
    expect(await ask(w, 'echo hello')).toMatchObject({ type: 'result', exitCode: 0 });
    expect(problems.join('\n')).toMatch(/completion.*audit disk unavailable/);
  });

  it('refuses a request issued before this daemon started, so a restart cannot be used to replay it', async () => {
    const w = await world();
    const session = await w.connect();
    closers.push(() => session.close());
    const signed = signRequest(newRequest({ source: A, target: B, shell: SHELL as 'cmd', command: 'echo hello', now: w.now.value - 5 }), w.a.privateKeyPkcs8);
    session.send({ type: 'run', request: signed });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'predates-start' });
    expect(w.runs).toHaveLength(0);
  });

  it('closes a session that keeps getting refused, and audits it', async () => {
    const w = await world({ maxRefusalsPerSession: 2 });
    const session = await w.connect();
    closers.push(() => session.close());
    for (let i = 0; i < 3; i++) expect(await ask(w, `echo nope ${i}`, SHELL, session)).toMatchObject({ type: 'refused', reason: 'not-listed' });
    await expect(session.next()).rejects.toThrow();
    expect(w.audit.events()).toContain('session-closed');
  });

  it('gives up waiting for an answer after the client deadline, with an actionable message', async () => {
    const hanging = { peerPublicKey: 'k', peerId: 'p', send: () => undefined, next: () => new Promise<unknown>(() => undefined), close: () => undefined };
    const w = await world();
    await expect(runOnPeer(hanging, { identity: w.a, source: A, target: B, shell: SHELL as 'cmd', command: 'echo hello', now: w.now.value, timeoutMs: 50 })).rejects.toThrow(/no answer.*50 ms.*peer/s);
  });
});
