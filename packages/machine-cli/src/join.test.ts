import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidacyCode } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { sanitizeHostname } from './join.js';
import { readRelayConfig, relayFile } from './relayStore.js';
import { cli, ok } from './testing.js';

let dir: string;
let relay: FakeRelay | undefined;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'machine-join-'))));
afterEach(async () => {
  await relay?.close();
  relay = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('sanitizeHostname', () => {
  it('keeps printable ASCII, 1 to 64 characters', () => {
    expect(sanitizeHostname('my-host')).toBe('my-host');
    expect(sanitizeHostname('héllo')).toBe('h?llo');
    expect(sanitizeHostname('x'.repeat(100))).toHaveLength(64);
    expect(sanitizeHostname('')).toBe('unknown');
  });
});

describe('machine join', () => {
  it('claims, stores the token, posts the candidacy and prints the code alone on a line, never the token', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    const r = await ok(dir, ['join', '12345678', '--relay', relay.url, '--no-wait']);

    expect(readRelayConfig(dir)).toMatchObject({ relayUrl: relay.url, token: relay.token, label: 'machine-pairing' });

    const posted = [...relay.candidacies.values()][0] as Record<string, string>;
    const me = readMachine(dir);
    expect(posted).toMatchObject({ name: 'laptop', identityPublicKey: me.identity.publicKey, uuid: me.uuid });
    expect(posted.uuid).toBe(posted.uuid?.toLowerCase());
    expect(posted.hostname).toMatch(/^[\x20-\x7e]{1,64}$/);
    const code = candidacyCode(me.identity.publicKey, posted.random as string);
    expect(r.out.split('\n')).toContain(`  ${code}`);
    expect(r.out).toContain([...relay.candidacies.keys()][0] as string);

    expect(r.out + r.err).not.toContain(relay.token);
    // The token is only in the secrets file.
    expect(readFileSync(relayFile(dir), 'utf8')).toContain(relay.token);
  });

  it('--json carries the code and id but not the token', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    const r = await ok(dir, ['join', '12345678', '--relay', relay.url, '--json', '--no-wait']);
    const parsed = JSON.parse(r.out) as Record<string, unknown>;
    expect(parsed.verificationCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(r.out).not.toContain(relay.token);
  });

  it('without init: actionable error, exit 1, the code is not spent', async () => {
    relay = await startFakeRelay();
    const r = await cli(dir, ['join', '12345678', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine init --name/);
    expect(relay.requests).toHaveLength(0);
  });

  it('twice: refused without --force, nothing sent', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    await ok(dir, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    const before = relay.requests.length;
    const again = await cli(dir, ['join', '12345678', '--relay', relay.url]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/--force/);
    expect(relay.requests).toHaveLength(before);
    expect(again.out + again.err).not.toContain(relay.token);
  });

  it('a wrong code fails with exit 1 and a fix, and stores nothing', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    const r = await cli(dir, ['join', '00000000', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/new code/);
    expect(readRelayConfig(dir)).toBeUndefined();
  });

  it('429 says how long to wait', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    relay.force('/api/pairings/claim', 429, { success: false, error: 'Too many attempts.', retryAfterSeconds: 30 }, { 'Retry-After': '30' });
    const r = await cli(dir, ['join', '12345678', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/wait 30 s/);
  });

  it('a full-access claim (scopes null) is refused and not stored', async () => {
    relay = await startFakeRelay({ scopes: null });
    await ok(dir, ['init', '--name', 'laptop']);
    const r = await cli(dir, ['join', '12345678', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(readRelayConfig(dir)).toBeUndefined();
    expect(r.out + r.err).not.toContain(relay.token);
  });

  it('a failed candidacy post tells the token was saved and what to do, without the token', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    relay.force('/api/machines/candidacies', 503, { success: false, error: 'store_unavailable', message: 'down' });
    const r = await cli(dir, ['join', '12345678', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/saved/);
    expect(r.err).toMatch(/--resume/);
    expect(r.err).not.toContain(relay.token);
  });

  it('a malformed relay.json is reported by file name, exit 1, nothing sent', async () => {
    relay = await startFakeRelay();
    await ok(dir, ['init', '--name', 'laptop']);
    mkdirSync(join(dir, '_secrets_'), { recursive: true });
    writeFileSync(relayFile(dir), 'garbage');
    const r = await cli(dir, ['join', '12345678', '--relay', relay.url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(relayFile(dir));
    expect(relay.requests).toHaveLength(0);
  });

  it('refuses a non-https relay and an extra argument', async () => {
    await ok(dir, ['init', '--name', 'laptop']);
    const insecure = await cli(dir, ['join', '1', '--relay', 'http://example.com']);
    expect(insecure.code).toBe(1);
    expect(insecure.err).toMatch(/https/);
    const extra = await cli(dir, ['join', '1', '2']);
    expect(extra.code).toBe(2);
  });

  it('an unreachable relay names the URL', async () => {
    await ok(dir, ['init', '--name', 'laptop']);
    const r = await cli(dir, ['join', '1', '--relay', 'http://127.0.0.1:1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('http://127.0.0.1:1');
  });
});
