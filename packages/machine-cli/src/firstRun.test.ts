import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPassphrase } from '@wadeck-app/machine-core';
import { adminKeyFile } from './admin.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { identityFile, readMachine } from './identity.js';
import { cli, ok } from './testing.js';

// First run of the CLI: names (decision 52) and the admin passphrase (decision 51). The flow of the first machine is in bootstrap.test.ts.

let root: string;
let a: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-firstrun-'));
  a = join(root, 'a');
  mkdirSync(a);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};

describe('machine name (decision 52)', () => {
  it('a typed name with uppercase letters is not an error: it is normalised and the CLI says so', async () => {
    const r = await cli(a, ['init', '--name', 'Midgard2']);
    expect(r.code, r.err).toBe(0);
    expect(readMachine(a).name).toBe('midgard2');
    expect(r.err).toMatch(/\[info\] using the name "midgard2" \(typed: "Midgard2"/);
    expect(r.out).toContain('"midgard2"');
  });

  it('an already valid typed name is kept without a note', async () => {
    const r = await cli(a, ['init', '--name', 'desktop']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
  });

  it('without --name the name comes from the computer name, normalised, with one note saying what was derived and how to label it', async () => {
    const r = await cli(a, ['init'], undefined, { hostname: () => 'Midgard2.local' });
    expect(r.code, r.err).toBe(0);
    expect(readMachine(a).name).toBe('midgard2');
    const notes = r.err.split('\n').filter((l) => l.startsWith('[info]'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/name "midgard2" .*computer name "Midgard2\.local"/);
    expect(notes[0]).toMatch(/machine alias set/);
  });

  it('a computer name that is hexadecimal only gets a prefix (it would look like a UUID prefix)', async () => {
    await ok(a, ['init']).catch(() => undefined);
    rmSync(a, { recursive: true, force: true });
    mkdirSync(a);
    const r = await cli(a, ['init'], undefined, { hostname: () => 'BEEF' });
    expect(r.code, r.err).toBe(0);
    expect(readMachine(a).name).toBe('host-beef');
  });

  it('a computer name with no letter or digit fails with the fix and creates nothing', async () => {
    const r = await cli(a, ['init'], undefined, { hostname: () => '---' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--name <name>/);
    expect(existsSync(identityFile(a))).toBe(false);
  });

  it('a typed name that is impossible fails with the fix', async () => {
    const r = await cli(a, ['init', '--name', '...']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--name <name>/);
    expect(existsSync(identityFile(a))).toBe(false);
  });

  it('init twice still refuses and keeps the identity', async () => {
    await ok(a, ['init', '--name', 'desktop']);
    const r = await cli(a, ['init'], undefined, { hostname: () => 'other' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already initialized as "desktop"/);
  });

  it('a friendly alias set later is shown by list (on this machine and on a peer) and accepted as a reference, whatever its case', async () => {
    await ok(a, ['init', '--name', 'midgard2']);
    const set = await cli(a, ['alias', 'set', 'Home', 'midgard2']);
    expect(set.code, set.err).toBe(0);
    expect(set.out).toContain('home ->');
    expect(set.err).toMatch(/alias stored as "home"/);
    const list = await ok(a, ['list']);
    expect(list.out).toMatch(/midgard2 \([0-9a-f-]{36}\) \[this machine\] aliases: home/);
    const resolved = await ok(a, ['resolve', 'HOME']);
    expect(resolved.out).toContain(readMachine(a).uuid);
    expect(resolved.out).toMatch(/via alias/);
    expect(JSON.parse((await ok(a, ['list', '--json'])).out)).toMatchObject({ self: { name: 'midgard2', aliases: ['home'] } });
    const removed = await cli(a, ['alias', 'rm', 'HOME']);
    expect(removed.code, removed.err).toBe(0);
  });

  describe('join creates the identity by itself', () => {
    let relay: FakeRelay;
    beforeEach(async () => {
      relay = await startFakeRelay({ code: '12345678' });
    });
    afterEach(async () => {
      await relay.close();
    });

    it('without identity, join derives the name from the computer name, says so, and posts that name', async () => {
      const r = await cli(a, ['join', '12345678', '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question'), hostname: () => 'Midgard2' });
      expect(r.code, r.err).toBe(0);
      expect(readMachine(a).name).toBe('midgard2');
      expect(r.out + r.err).toMatch(/name "midgard2" .*computer name "Midgard2"/);
      const posted = relay.requests.find((q) => q.method === 'POST' && q.path === '/api/machines/candidacies');
      expect((posted?.body as { name: string }).name).toBe('midgard2');
    });

    it('with an identity, join keeps it and says nothing about names', async () => {
      await ok(a, ['init', '--name', 'desktop']);
      const r = await cli(a, ['join', '12345678', '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question'), hostname: () => 'Midgard2' });
      expect(r.code, r.err).toBe(0);
      expect(readMachine(a).name).toBe('desktop');
      expect(r.out + r.err).not.toMatch(/computer name/);
    });

    it('--name on join names the new identity; on an existing identity it is refused, not ignored', async () => {
      const created = await cli(a, ['join', '12345678', '--relay', relay.url, '--no-wait', '--name', 'Work PC'], forbidden('a prompt'), { ask: forbidden('a question') });
      expect(created.code, created.err).toBe(0);
      expect(readMachine(a).name).toBe('work-pc');
      const again = await cli(a, ['join', '--resume', '--name', 'other'], forbidden('a prompt'), { ask: forbidden('a question') });
      expect(again.code).toBe(2);
      expect(again.err).toMatch(/already initialized as "work-pc".*--name/s);
    });

    it('a failure to name the machine happens before the one-shot code is spent', async () => {
      const r = await cli(a, ['join', '12345678', '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question'), hostname: () => '...' });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--name/);
      expect(relay.requests.filter((q) => q.path.includes('pairing') || q.path.includes('claim'))).toHaveLength(0);
    });
  });
});

describe('machine admin init chooses a passphrase (decision 51)', () => {
  const keyExists = () => existsSync(adminKeyFile(a));
  /** Scripted hidden prompt: the labels asked and the answers given in order. */
  function scripted(...answers: string[]) {
    const labels: string[] = [];
    const prompt = async (label: string): Promise<string> => {
      labels.push(label);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected prompt "${label}"`);
      return next;
    };
    return { prompt, labels };
  }
  const warnings = (text: string) => text.split('\n').filter((l) => l.startsWith('[warn]'));

  it('accepts a chosen passphrase typed twice, shows it nowhere, and the key opens with it', async () => {
    const chosen = 'correct horse battery staple';
    const s = scripted(chosen, chosen);
    const r = await cli(a, ['admin', 'init'], s.prompt);
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).not.toContain(chosen);
    expect(warnings(r.err)).toEqual([]);
    expect(s.labels).toHaveLength(2);
    expect(s.labels[0]).toMatch(/at least 12 characters/);
    expect(s.labels[0]).toMatch(/Enter.*random/);
    expect(s.labels[1]).toMatch(/again/i);
    expect(r.out).toMatch(/\[ok\] admin key created/);
    // The chosen passphrase really protects the key: a registration is signed with it.
    await ok(a, ['init', '--name', 'desktop']);
    await ok(a, ['peer', 'info', '--out', join(root, 'info.json')]);
    const signed = await cli(a, ['admin', 'register', join(root, 'info.json'), '--out', join(root, 'bundle.json')], async () => chosen);
    expect(signed.code, signed.err).toBe(0);
  });

  it('a chosen passphrase of 12 to 19 characters is accepted with exactly one clear warning line', async () => {
    const chosen = 'abcdef123456';
    const s = scripted(chosen, chosen);
    const r = await cli(a, ['admin', 'init'], s.prompt);
    expect(r.code, r.err).toBe(0);
    expect(keyExists()).toBe(true);
    const lines = warnings(r.err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/12 characters/);
    expect(lines[0]).toMatch(/stolen|steals/);
    expect(lines[0]).toMatch(/offline/);
    expect(lines[0]).toMatch(/longer/);
    expect(r.out + r.err).not.toContain(chosen);
  });

  it('refuses a chosen passphrase below the minimum with the rule and the way out, and creates nothing', async () => {
    const s = scripted('abcdef12345');
    const r = await cli(a, ['admin', 'init'], s.prompt);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/at least 12 characters/);
    expect(r.err).toMatch(/--generate/);
    expect(keyExists()).toBe(false);
    expect(s.labels).toHaveLength(1);
  });

  it.each([
    ['digits only', '123456789012', /digits only/],
    ['too few different characters', 'abcabcabcabc', /different characters/],
  ])('refuses %s', async (_name, chosen, message) => {
    const r = await cli(a, ['admin', 'init'], scripted(chosen).prompt);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect(keyExists()).toBe(false);
  });

  it('refuses two different entries, says nothing was created, and never prints either', async () => {
    const r = await cli(a, ['admin', 'init'], scripted('correct horse battery staple', 'correct horse battery stapel').prompt);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/do not match.*nothing was created/s);
    expect(r.err).not.toContain('correct horse');
    expect(keyExists()).toBe(false);
  });

  it('an empty answer generates the random passphrase (shown once on stderr), without asking a second time', async () => {
    const s = scripted('');
    const r = await cli(a, ['admin', 'init'], s.prompt);
    expect(r.code, r.err).toBe(0);
    expect(s.labels).toHaveLength(1);
    const generated = /shown only once[^\n]*\n\s*([A-Z0-9-]{20,})/i.exec(r.err)?.[1] ?? '';
    expect(checkPassphrase(generated).ok).toBe(true);
    expect(r.out).not.toContain(generated);
    expect(warnings(r.err)).toEqual([]);
  });

  it('--generate never asks anything and shows the random passphrase once on stderr', async () => {
    const r = await cli(a, ['admin', 'init', '--generate'], forbidden('a passphrase'));
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/shown only once/i);
    expect(keyExists()).toBe(true);
  });

  it('an existing admin key is reported before any passphrase is asked', async () => {
    await ok(a, ['admin', 'init', '--generate']);
    const r = await cli(a, ['admin', 'init'], forbidden('a passphrase'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
  });

  it('without a terminal it fails and names --generate', async () => {
    const r = await cli(a, ['admin', 'init'], async () => {
      throw new Error('a passphrase is only read from an interactive terminal: it is never taken from arguments, environment variables or pipes. Run this command in a terminal window');
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/interactive terminal/);
    expect(r.err).toMatch(/machine admin init --generate/);
    expect(keyExists()).toBe(false);
  });

  it('--json keeps the chosen passphrase and the warning out of stdout', async () => {
    const s = scripted('abcdef123456', 'abcdef123456');
    const r = await cli(a, ['admin', 'init', '--json'], s.prompt);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toHaveProperty('adminKeyId');
    expect(r.out).not.toContain('abcdef123456');
  });

  it('--generate is refused anywhere else, and --prompt-timeout is accepted by admin init', async () => {
    const other = await cli(a, ['status', '--generate']);
    expect(other.code).toBe(2);
    expect(other.err).toMatch(/--generate only applies to `machine admin init`/);
    const timed = await cli(a, ['admin', 'init', '--prompt-timeout', '30'], scripted('').prompt);
    expect(timed.code, timed.err).toBe(0);
  });

  it('the key file written with a 12 character passphrase is a normal envelope (no weaker format)', async () => {
    await cli(a, ['admin', 'init'], scripted('abcdef123456', 'abcdef123456').prompt);
    const file = JSON.parse(readFileSync(adminKeyFile(a), 'utf8')) as { v: number; kdf: { iterations: number } };
    expect(file.v).toBe(1);
    expect(file.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    writeFileSync(join(root, 'ok'), 'x');
  });
});
