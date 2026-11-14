import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPolicy, checkPassphrase, generatePassphrase, keyId, type PolicyBody } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminInit, readAdminPin, signPolicyFile } from './admin.js';

const TARGET = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const PEER = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const NOW = 1_800_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-admin-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function policyDraft(extra: Record<string, unknown> = {}): string {
  const file = join(dir, 'draft.json');
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      target: TARGET,
      version: 1,
      baseVersion: 0,
      defaults: [{ shell: 'cmd', command: 'ipconfig' }],
      peers: { [PEER]: [{ shell: 'ps', command: 'ls', limits: { maxCalls: 5 } }] },
      ...extra,
    }),
  );
  return file;
}

describe('adminInit', () => {
  it('creates the encrypted key under _secrets_, pins the public key and returns a strong passphrase once', () => {
    const r = adminInit(dir);
    expect(checkPassphrase(r.passphrase).ok).toBe(true);
    expect(existsSync(join(dir, '_secrets_', 'admin.key.json'))).toBe(true);
    const pin = readAdminPin(dir);
    expect(pin.adminPublicKey).toBe(r.adminPublicKey);
    expect(pin.adminKeyId).toBe(keyId(r.adminPublicKey));
    // The passphrase and the private key are in no stored file.
    for (const f of [join(dir, '_secrets_', 'admin.key.json'), join(dir, 'admin.json')]) {
      expect(readFileSync(f, 'utf8')).not.toContain(r.passphrase);
    }
  });

  it('refuses a second init and names the file, because a second admin key would orphan every signature', () => {
    adminInit(dir);
    expect(() => adminInit(dir)).toThrow(/admin key already exists.*admin\.key\.json/);
  });
});

describe('readAdminPin', () => {
  it('tells what to do when no admin key is known', () => {
    expect(() => readAdminPin(dir)).toThrow(/no admin key.*machine admin init/s);
  });
});

describe('signPolicyFile', () => {
  it('signs a draft after the passphrase prompt; the result is accepted by the target machine logic', async () => {
    const { passphrase, adminPublicKey } = adminInit(dir);
    const asked: string[] = [];
    const r = await signPolicyFile(dir, policyDraft(), {
      now: NOW,
      prompt: async (label) => {
        asked.push(label);
        return passphrase;
      },
    });
    expect(asked).toHaveLength(1);
    const applied = applyPolicy({ version: 0, highestSeen: 0 }, r.signed, { adminPublicKey, now: NOW + 5, targetUuid: TARGET });
    expect(applied.ok).toBe(true);
  });

  it('fills adminKeyId, issuedAt and the application window, keeping what the draft states', async () => {
    const { passphrase } = adminInit(dir);
    const r = await signPolicyFile(dir, policyDraft({ notBefore: NOW - 10 }), { now: NOW, prompt: async () => passphrase });
    const body: PolicyBody = r.signed.body;
    expect(body.adminKeyId).toBe(readAdminPin(dir).adminKeyId);
    expect(body.issuedAt).toBe(NOW);
    expect(body.notBefore).toBe(NOW - 10);
    expect(body.notAfter).toBeGreaterThan(NOW);
  });

  it('shows every entry exactly as signed (escaped), the target and the versions before asking for the passphrase', async () => {
    const { passphrase } = adminInit(dir);
    const r = await signPolicyFile(dir, policyDraft(), { now: NOW, prompt: async () => passphrase });
    expect(r.summary).toContain(TARGET);
    expect(r.summary).toContain('version 1');
    expect(r.summary).toContain(JSON.stringify('ipconfig'));
    expect(r.summary).toContain(PEER);
    expect(r.summary).toContain('maxCalls');
  });

  it('refuses a wrong passphrase with a clear message and signs nothing', async () => {
    adminInit(dir);
    const wrong = generatePassphrase();
    await expect(signPolicyFile(dir, policyDraft(), { now: NOW, prompt: async () => wrong })).rejects.toThrow(/wrong passphrase/);
  });

  it('refuses an invalid draft before prompting, naming the problem', async () => {
    adminInit(dir);
    let prompted = false;
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ v: 1, target: 'nope', version: 1, baseVersion: 0, defaults: [], peers: {} }));
    await expect(signPolicyFile(dir, file, { now: NOW, prompt: async () => ((prompted = true), 'x') })).rejects.toThrow(/policy/);
    expect(prompted).toBe(false);
  });

  it('names the file when the draft is not JSON', async () => {
    adminInit(dir);
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{oops');
    await expect(signPolicyFile(dir, file, { now: NOW, prompt: async () => 'x' })).rejects.toThrow(/broken\.json.*JSON/);
  });

  it('tells the user to init the admin key first when there is none', async () => {
    await expect(signPolicyFile(dir, policyDraft(), { now: NOW, prompt: async () => 'x' })).rejects.toThrow(/machine admin init/);
  });
});

describe('adminInit and the pin (review hardening)', () => {
  it('refuses to start over a pinned admin key it does not hold, and names the pin file', () => {
    writeFileSync(join(dir, 'admin.json'), '{}');
    expect(() => adminInit(dir)).toThrow(/admin\.json/);
    expect(existsSync(join(dir, '_secrets_', 'admin.key.json'))).toBe(false);
  });

  it('reports a wrong-shaped key file as corrupt instead of crashing inside the decryption', async () => {
    const { passphrase } = adminInit(dir);
    writeFileSync(join(dir, '_secrets_', 'admin.key.json'), 'null');
    await expect(signPolicyFile(dir, policyDraft(), { now: NOW, prompt: async () => passphrase })).rejects.toThrow(/admin\.key\.json.*(corrupt|invalid)/);
  });
});
