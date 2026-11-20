import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalCode, openSealed } from '@wadeck-app/machine-core';
import { pairSecretContext } from './approval.js';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { readRelayAdminConfig, readRelayConfig } from './relayStore.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { cli, fakeTiming, ok } from './testing.js';

// Bootstrap of a network: the very first machine is also the admin machine (candidate == admin), then a second machine
// joins and is approved by the first. Everything through the command line, one fake relay, no shortcut.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const MACHINE_CODE = '12345678';
const SECOND_CODE = '22223333';
const THIRD_CODE = '33334444';
const ADMIN_CODE = '87654321';
const yes = async () => 'y';
const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let passphrase: string;
let stub: OrchStub;
const daemons: RunningDaemon[] = [];

const decisions = () => relay.requests.filter((q) => q.method === 'PUT' && q.path.endsWith('/decision'));
const peersOf = (dir: string): { registration: { body: { uuid: string } }; pairSecret: string }[] => {
  const file = join(dir, '_secrets_', 'peers.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { peers: { registration: { body: { uuid: string } }; pairSecret: string }[] }).peers : [];
};
const approve = (dir: string, id: string, ask: (l: string) => Promise<string> = yes) => cli(dir, ['admin', 'approve', id, '--relay', relay.url], async () => passphrase, { ask });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-bootstrap-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  stub = makeOrchStub();
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE, THIRD_CODE], adminCode: ADMIN_CODE });
});
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stub.dir, { recursive: true, force: true });
});

// State of the two machines, printed with a failing assertion so that a rare failure explains itself (status of both, peers of both, the decisions seen by the relay, the clock).
async function diagnose(): Promise<string> {
  const statusOf = async (dir: string) => {
    const r = await cli(dir, ['status', '--json']);
    return `code ${r.code} out ${r.out.trim()} err ${r.err.trim()}`;
  };
  const peers = (dir: string) => peersOf(dir).map((p) => ({ uuid: p.registration.body.uuid, registration: p.registration, pairSecretLength: p.pairSecret.length }));
  return JSON.stringify(
    {
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      uuids: { a: readMachine(a).uuid, b: readMachine(b).uuid },
      statusA: await statusOf(a),
      statusB: await statusOf(b),
      peersA: peers(a),
      peersB: peers(b),
      decisions: decisions().map((d) => d.path),
      pending: relay.pendingIds(),
    },
    null,
    1,
  );
}

/** init, admin init, admin login, join (token and candidacy). Returns the id of the candidacy of the first machine. */
async function firstMachinePosts(): Promise<string> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  expect(passphrase).not.toBe('');
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
  await ok(a, ['join', MACHINE_CODE, '--relay', relay.url, '--no-wait']);
  return relay.pendingIds()[0] as string;
}

/** The admin machine before it joins: identity, admin key, admin relay token. No candidacy yet. */
async function adminMachineReady(): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  expect(passphrase).not.toBe('');
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
}
const deviceRequests = () => relay.requests.filter((q) => q.path.startsWith('/api/device-login/'));
// The person at the relay console: approves every login request that is waiting (setup sends the admin login first, then the machine login).
const consoleApprovesAll = (): void => {
  for (;;) {
    try {
      relay.deviceApprove();
    } catch {
      return;
    }
  }
};

// One command per machine (decision 53).
describe('one command per machine', () => {
  describe('the admin machine: `machine join <relay>` completes the whole enrollment', () => {
    it('device login, candidacy, self-approval (one passphrase, no id, no y/N) and enrollment, with nothing to compare and nothing left to resume', async () => {
      await adminMachineReady();
      const prompts: string[] = [];
      const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
      const r = await cli(a, ['join', relay.url], async (label) => (prompts.push(label), passphrase), { timing, ask: forbidden('a question') });
      expect(r.code, r.err).toBe(0);
      expect(prompts).toHaveLength(1);
      expect(decisions()).toHaveLength(1);
      expect(r.out).toContain(`[ok] enrolled "desktop" (${readMachine(a).uuid})`);
      expect(r.out).toMatch(/already pinned/);
      expect(r.out).not.toMatch(/Is this the code|Security code|On the admin machine run|join --resume|Waiting for the admin/);
      expect(r.out).toMatch(/no other machine yet: this machine is the first of the network/);
      expect(r.out).toContain(`machine join ${relay.url}`);
      expect(r.out).toMatch(/machine admin allow/);
      expect(r.out).toMatch(/To start machine at login run: machine startup enable/);
      expect(r.err).toBe('');
      expect(existsSync(join(a, '_secrets_', 'candidacy.json'))).toBe(false);
      expect(peersOf(a)).toEqual([]);
      expect(JSON.parse((await ok(a, ['status', '--json'])).out)).toMatchObject({ enrolled: true, peers: 0, problems: [] });
    });

    it('a pairing code works the same way', async () => {
      await adminMachineReady();
      const r = await cli(a, ['join', MACHINE_CODE, '--relay', relay.url], async () => passphrase, { timing: fakeTiming(), ask: forbidden('a question') });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain('[ok] enrolled "desktop"');
    });

    it('without the admin relay token it says which step is missing and the exact command, before any device login starts', async () => {
      await ok(a, ['init', '--name', 'desktop']);
      await ok(a, ['admin', 'init', '--generate']);
      const r = await cli(a, ['join', relay.url], async () => passphrase, { timing: fakeTiming(), ask: forbidden('a question') });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/holds the admin key/);
      expect(r.err).toContain(`machine admin login --relay ${relay.url}`);
      expect(r.err).toContain(`machine admin login <code> --relay ${relay.url}`);
      expect(r.err).toMatch(/Add token, "Limited to scopes", machine-admin/);
      expect(r.err).toMatch(/needs the admin relay token \(limited to machine rights, it cannot manage tokens\)/);
      expect(r.err).not.toMatch(/WITHOUT|full-access/);
      expect(deviceRequests()).toHaveLength(0);
      expect(readRelayConfig(a)).toBeUndefined();
    });

    it('a wrong passphrase leaves the candidacy valid and says `join --resume`; the resume finishes it', async () => {
      await adminMachineReady();
      const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
      const wrong = await cli(a, ['join', relay.url], async () => 'not the passphrase at all', { timing, ask: forbidden('a question') });
      expect(wrong.code).toBe(1);
      expect(wrong.err).toMatch(/wrong passphrase/);
      expect(wrong.err).toMatch(/machine join --resume/);
      expect(decisions()).toHaveLength(0);
      const resumed = await cli(a, ['join', '--resume'], async () => passphrase, { timing: fakeTiming(), ask: forbidden('a question') });
      expect(resumed.code, resumed.err).toBe(0);
      expect(resumed.out).toContain('[ok] enrolled "desktop"');
      expect(decisions()).toHaveLength(1);
    });

    it('--no-wait keeps the manual path (the candidacy waits for `machine admin approve`)', async () => {
      await adminMachineReady();
      const r = await cli(a, ['join', MACHINE_CODE, '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question') });
      expect(r.code, r.err).toBe(0);
      expect(decisions()).toHaveLength(0);
      expect(r.out).toMatch(/next: on the admin machine run `machine admin approve`/);
    });
  });

  describe('the first machine: `machine setup <relay>` is the only command', () => {
    const chosen = 'correct horse battery staple';
    /** Hidden prompts answer with `chosen` (typed as many times as asked); visible questions answer in order. */
    function human(...answers: string[]) {
      const hidden: string[] = [];
      const visible: string[] = [];
      return {
        hidden,
        visible,
        prompt: async (label: string) => (hidden.push(label), chosen),
        ask: async (label: string) => {
          visible.push(label);
          const next = answers.shift();
          if (next === undefined) throw new Error(`unexpected question "${label}"`);
          return next;
        },
      };
    }

    it('creates the identity (computer name), the admin key (chosen passphrase, typed twice), does ONE login confirmed in the relay console (machine-admin, no second request), approves itself and enrolls', async () => {
      // The only question is the hint of the passphrase (Enter = none): no pairing code is asked, the single relay request is confirmed in the console.
      const h = human('');
      const timing = fakeTiming(consoleApprovesAll);
      const r = await cli(a, ['setup', relay.url], h.prompt, { timing, ask: h.ask, hostname: () => 'Midgard2.local' });
      expect(r.code, r.err).toBe(0);
      expect(readMachine(a).name).toBe('midgard2');
      // The passphrase is typed twice (choice and confirmation) and signs the enrollment without being asked a third time.
      expect(h.hidden).toHaveLength(2);
      expect(h.visible).toHaveLength(1);
      expect(h.visible[0]).toMatch(/Hint to help you remember it/);
      // One request, access machine-admin, labelled with the machine name: the console shows it as MACHINE ADMIN.
      expect(deviceRequests().filter((q) => q.path.endsWith('/start')).map((q) => q.body)).toEqual([{ label: 'midgard2', access: 'machine-admin' }]);
      expect(r.out).toMatch(/\n\nRelay login on \S+ \(MACHINE ADMIN: can approve machines, cannot manage tokens\): one confirmation gives this machine its relay token and the admin rights to approve machines\.\n\nCode to compare in the relay console[^\n]*\n\n {2}ADMN-7K42\n\n/);
      expect(r.out).toContain("Compare this code with the one in the relay console (the Tokens page lists the request \"midgard2\", marked MACHINE ADMIN)");
      expect(r.out).toMatch(/\[ok\] machine admin access approved\n\[ok\] relay token "midgard2" saved for \S+: it is the token of this machine and its admin token \(MACHINE ADMIN: it cannot manage tokens\)\n\n/);
      expect(r.out + r.err).not.toMatch(/pairing code|FULL ACCESS|WITHOUT|Relay login code for|\[warn\]/i);
      expect(r.out).toMatch(/\[ok\] admin key created \(id [0-9a-f]+\)\n\n/);
      // The self-approval is said once (no candidacy id, no "Enter the admin passphrase" before "Signing with ...").
      expect(r.out).toContain('\nSigning with the admin passphrase you just set.\n');
      expect(r.out).not.toMatch(/Candidacy \S+ posted|Enter the admin passphrase to sign/);
      expect(r.out).toMatch(/\[ok\] enrolled "midgard2"[^\n]*\n[^\n]*\n[^\n]*\nallow list: managed by the admin \(policy mode admin\)\n\nnext:/);
      expect(r.out).toMatch(/To start machine at login run: machine startup enable/);
      expect(r.out).toContain(`another machine: run \`machine join ${relay.url}\``);
      expect(r.out + r.err).not.toContain(chosen);
      expect(existsSync(join(a, '_secrets_', 'admin.key.json'))).toBe(true);
      expect(decisions()).toHaveLength(1);
      expect(JSON.parse((await ok(a, ['status', '--json'])).out)).toMatchObject({ enrolled: true, peers: 0, problems: [] });
      // The same token is the machine token (relay.json) and the admin token (relay-admin.json); it is never printed.
      const machineToken = readRelayConfig(a);
      const adminToken = readRelayAdminConfig(a);
      expect(machineToken?.token).toBe(relay.machineAdminToken);
      expect(adminToken?.token).toBe(relay.machineAdminToken);
      expect(machineToken?.label).toBe('midgard2');
      expect(r.out + r.err).not.toContain(relay.machineAdminToken);
      // It was the token that posted the candidacy: the uuid is bound to it, and the relay says its scopes are machine-admin only.
      expect(((await fetch(`${relay.url}/api/whoami`, { headers: { authorization: `Bearer ${relay.machineAdminToken}` } }).then((x) => x.json())) as { scopes: unknown }).scopes).toEqual(['machine-admin']);
      expect((await fetch(`${relay.url}/api/tokens`, { headers: { authorization: `Bearer ${relay.machineAdminToken}` } })).status).toBe(403);
      // The chosen passphrase really is the admin passphrase.
      const again = await cli(a, ['admin', 'distribute', 'midgard2'], async () => chosen);
      expect(again.err).not.toMatch(/wrong passphrase/);
    });

    it('--generate shows the random passphrase once on stderr, never asks for one, and the whole enrollment needs the human only in the relay console', async () => {
      const h = human();
      const r = await cli(a, ['setup', relay.url, '--generate'], forbidden('a hidden prompt'), { timing: fakeTiming(consoleApprovesAll), ask: h.ask, hostname: () => 'desktop' });
      expect(r.code, r.err).toBe(0);
      expect(r.err).toMatch(/shown only once/i);
      expect(r.out).toContain('[ok] enrolled "desktop"');
      expect(h.visible).toHaveLength(0);
    });

    it('a login denied in the console stops setup; what was created is kept and the re-run asks only what is missing', async () => {
      const h = human('');
      const failed = await cli(a, ['setup', relay.url], h.prompt, { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceDeny()), ask: h.ask, hostname: () => 'desktop' });
      expect(failed.code).toBe(1);
      expect(failed.err).toMatch(/denied in the relay console/);
      expect(failed.err).toMatch(/machine setup/);
      expect(failed.err).toMatch(/what was created is kept/);
      expect(existsSync(join(a, '_secrets_', 'admin.key.json'))).toBe(true);
      expect(existsSync(join(a, '_secrets_', 'relay-admin.json'))).toBe(false);
      expect(existsSync(join(a, '_secrets_', 'relay.json'))).toBe(false);
      expect(deviceRequests().filter((q) => q.path.endsWith('/start'))).toHaveLength(1);

      const h2 = human();
      const again = await cli(a, ['setup', relay.url], h2.prompt, { timing: fakeTiming(consoleApprovesAll), ask: h2.ask, hostname: () => 'desktop' });
      expect(again.code, again.err).toBe(0);
      // Decision 67: what exists is one "(already done)" line, the total stays 6 (the "Allow list" step of decision 69 included).
      expect(again.out).toContain('Step 2/6: Admin passphrase (already done)');
      // The key already exists: the passphrase is asked once, to sign (no choice, no confirmation).
      expect(h2.hidden).toHaveLength(1);
      expect(h2.visible).toHaveLength(0);
      expect(again.out).toContain('[ok] enrolled "desktop"');
    });

    it('a wrong click in the console denies the setup login: nothing saved, the message says to run setup again and click the code shown; the re-run works', async () => {
      const h = human('');
      const decoy = () => relay.deviceClick(relay.deviceChoices().find((c) => c !== 'ADMN-7K42') as string);
      const failed = await cli(a, ['setup', relay.url], h.prompt, { timing: fakeTiming((_ms, n) => n === 1 && decoy()), ask: h.ask, hostname: () => 'desktop' });
      expect(failed.code).toBe(1);
      expect(failed.err).toMatch(/a different code was chosen/);
      expect(failed.err).toMatch(/run `machine setup` again/);
      expect(existsSync(join(a, '_secrets_', 'relay.json'))).toBe(false);
      expect(existsSync(join(a, '_secrets_', 'relay-admin.json'))).toBe(false);
      const again = await cli(a, ['setup', relay.url], async () => chosen, { timing: fakeTiming(consoleApprovesAll), ask: human().ask, hostname: () => 'desktop' });
      expect(again.code, again.err).toBe(0);
    });

    it('an interruption after the login (the candidacy could not be posted): the token is saved, the re-run reuses it, no second login', async () => {
      const h = human('');
      relay.force('/api/machines/candidacies', 503, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'POST');
      const failed = await cli(a, ['setup', relay.url], h.prompt, { timing: fakeTiming(consoleApprovesAll), ask: h.ask, hostname: () => 'desktop' });
      expect(failed.code).toBe(1);
      expect(failed.err).toMatch(/The relay token of this machine is saved: run `machine setup` again, it is reused \(no new login\)/);
      expect(readRelayConfig(a)?.token).toBe(relay.machineAdminToken);
      expect(readRelayAdminConfig(a)?.token).toBe(relay.machineAdminToken);

      const h2 = human();
      const again = await cli(a, ['setup', relay.url], h2.prompt, { timing: fakeTiming(consoleApprovesAll), ask: h2.ask, hostname: () => 'desktop' });
      expect(again.code, again.err).toBe(0);
      expect(again.out).toContain('[ok] enrolled "desktop"');
      expect(again.out).not.toMatch(/Code to compare/);
      expect(deviceRequests().filter((q) => q.path.endsWith('/start'))).toHaveLength(1);
    });

    describe('a relay that predates the machine-admin scope', () => {
      beforeEach(async () => {
        await relay.close();
        relay = await startFakeRelay({ machineAdminLogin: 'rejects', adminCode: ADMIN_CODE });
      });

      it('fails loudly, names the scope and the relay commit, offers the explicit choices, asks no pairing code, keeps what was created, requests no full access', async () => {
        const h = human('');
        const r = await cli(a, ['setup', relay.url], h.prompt, { timing: fakeTiming(consoleApprovesAll), ask: h.ask, hostname: () => 'desktop' });
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/predates the `machine-admin` scope \(poc-node 78fe5b2\)/);
        expect(r.err).toMatch(/update and redeploy it/);
        expect(r.err).toContain('`machine admin login --full-access');
        expect(r.err).toMatch(/Then run `machine setup \S+` again: it keeps the admin token and asks for the machine login separately/);
        expect(r.err).toMatch(/What was created \(identity, admin key\) is kept/);
        expect(h.visible).toHaveLength(1);
        expect(existsSync(join(a, '_secrets_', 'admin.key.json'))).toBe(true);
        expect(existsSync(join(a, '_secrets_', 'relay.json'))).toBe(false);
        expect(existsSync(join(a, '_secrets_', 'relay-admin.json'))).toBe(false);
        expect(deviceRequests().filter((q) => q.path.endsWith('/start')).map((q) => (q.body as { access?: string }).access)).toEqual(['machine-admin']);
      });

      it('the documented way out: `admin login --full-access`, then `setup` again asks the machine login separately and completes', async () => {
        const h = human('');
        await cli(a, ['setup', relay.url], h.prompt, { timing: fakeTiming(consoleApprovesAll), ask: h.ask, hostname: () => 'desktop' });
        const full = await cli(a, ['admin', 'login', '--full-access', '--relay', relay.url], forbidden('a prompt'), { timing: fakeTiming(consoleApprovesAll), ask: forbidden('a question') });
        expect(full.code, full.err).toBe(0);
        expect(full.out).toMatch(/\[warn\] this admin token has FULL ACCESS/);
        const h2 = human();
        const again = await cli(a, ['setup', relay.url], h2.prompt, { timing: fakeTiming(consoleApprovesAll), ask: h2.ask, hostname: () => 'desktop' });
        expect(again.code, again.err).toBe(0);
        expect(again.out).toContain('[ok] enrolled "desktop"');
        // Two different tokens, as before: the machine token is the plain one.
        expect(readRelayConfig(a)?.token).toBe(relay.token);
        expect(readRelayAdminConfig(a)?.token).toBe(relay.adminToken);
      });
    });

    it('with an admin token already there (a full-access file of the old flow), no admin login: only the machine login is asked, as a plain machine request', async () => {
      await adminMachineReady();
      const h = human();
      const r = await cli(a, ['setup', relay.url], async () => passphrase, { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()), ask: h.ask });
      expect(r.code, r.err).toBe(0);
      expect(h.visible).toHaveLength(0);
      expect(deviceRequests().filter((q) => q.path.endsWith('/start')).map((q) => (q.body as { access?: string }).access)).toEqual([undefined]);
    });
    it.each([
      [['setup', '--resume'], /no --resume/],
      [['setup', 'x.example.test', '--no-wait'], /--no-wait does not apply/],
      [['setup', '12345678'], /takes the relay, not a pairing code/],
      [['setup', 'x.example.test', '--yes-final-code', 'AAAA'], /--yes-final-code does not apply/],
    ])('refuses %j', async (args, message) => {
      const r = await cli(a, args, forbidden('a prompt'), { ask: forbidden('a question') });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(message);
      expect(existsSync(join(a, '_secrets_', 'identity.json'))).toBe(false);
    });

    it('without a relay it says how to name it, before creating anything', async () => {
      const r = await cli(a, ['setup'], forbidden('a prompt'), { ask: forbidden('a question') });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/machine setup needs the relay: `machine setup <host>`/);
      expect(existsSync(join(a, '_secrets_'))).toBe(false);
    });
  });

  describe('`machine admin approve` without an id', () => {
    it('zero pending: says so and names the command of the new machine', async () => {
      await adminMachineReady();
      const r = await cli(a, ['admin', 'approve', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/no pending candidacy.*machine join <relay>/);
    });

    it('exactly one pending goes straight to the details, the y/N, the passphrase and the final code', async () => {
      const id = await firstMachinePosts();
      const asked: string[] = [];
      const r = await cli(a, ['admin', 'approve', '--relay', relay.url], async () => passphrase, { ask: async (l) => (asked.push(l), 'y') });
      expect(r.code, r.err).toBe(0);
      expect(asked).toHaveLength(1);
      expect(r.out).toContain(`Candidacy ${id}`);
      expect(r.out).toMatch(/One pending candidacy/);
      expect(r.out).toMatch(/Security code of /);
      expect(decisions()).toHaveLength(1);
    });

    it('several pending: lists them, says to pass the id, asks nothing', async () => {
      await firstMachinePosts();
      await ok(b, ['init', '--name', 'laptop']);
      await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
      const r = await cli(a, ['admin', 'approve', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/2 pending candidacy\(ies\); approve one with `machine admin approve <id>`/);
      expect(decisions()).toHaveLength(0);
    });
  });

  describe('another machine: `machine join <relay>` waits and finishes by itself', () => {
    it('tells at the start what the admin runs, and at the end which code to compare; creates its identity from the computer name', async () => {
      await adminMachineReady();
      const first = await cli(a, ['join', relay.url], async () => passphrase, { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()), ask: forbidden('a question') });
      expect(first.code, first.err).toBe(0);

      // The admin machine approves while the new machine waits (the approval happens inside the first sleep of its wait).
      let approvedOnce = false;
      const timing = {
        ...fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()),
        sleep: async () => {
          if (relay.pendingIds().length > 0 && !approvedOnce) {
            approvedOnce = true;
            const id = relay.pendingIds()[0] as string;
            const approved = await approve(a, id);
            expect(approved.code, approved.err).toBe(0);
          } else if (relay.deviceLogins.size > 0 && !approvedOnce) {
            relay.deviceApprove();
          }
        },
      };
      const asked: string[] = [];
      const r = await cli(b, ['join', relay.url], forbidden('a prompt'), { timing, ask: async (l) => (asked.push(l), 'y'), hostname: () => 'Laptop' });
      expect(r.code, r.err).toBe(0);
      expect(readMachine(b).name).toBe('laptop');
      // At the start: what to run on the admin machine; at the end: the code to compare, asked once.
      expect(r.out.indexOf('machine admin approve')).toBeGreaterThan(-1);
      expect(r.out).toMatch(/On the admin machine run: machine admin approve/);
      expect(r.out).toMatch(/security code.*compare/is);
      expect(r.out).toMatch(/Security code of "[a-z0-9-]+" \(this machine\).*must read exactly the same on /s);
      expect(asked).toHaveLength(1);
      expect(r.out).toContain('[ok] enrolled "laptop"');
      expect(r.out).toMatch(/machine admin allow <this machine> -- <command>/);
      expect(peersOf(b)).toHaveLength(1);
    });
  });
});

// The fake relay models the deployed relay: ownership bound at approval (the legacy first-writer relay is gone).
describe('relay with ownership bound at approval', () => {
  describe('the first machine of a network is also its admin machine', () => {
    it('approves its own candidacy: no passphrase typed twice, no error, nothing about a peer', async () => {
      const id = await firstMachinePosts();
      const asked: string[] = [];
      const r = await approve(a, id, async (l) => (asked.push(l), 'y'));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toBe('');
      expect(asked).toHaveLength(1);
      expect(decisions()).toHaveLength(1);
      // The approval carries the registration of this machine and no peer at all (a machine is not its own peer).
      const sent = (decisions()[0]?.body as { approval: { adminUuid: string; self: { registration: { body: { uuid: string } } }; peers: unknown[] } }).approval;
      expect(sent.peers).toEqual([]);
      expect(sent.self.registration.body.uuid).toBe(readMachine(a).uuid);
      expect(sent.adminUuid).toBe(readMachine(a).uuid);
      // Nothing is stored as a peer of itself, and the output says why nothing is compared nor distributed.
      expect(peersOf(a)).toEqual([]);
      expect(r.out).toMatch(/this machine is the admin machine/i);
      expect(r.out).not.toMatch(/machine admin revoke/);
      expect(r.out).not.toMatch(/other peer/);
    });

    it('the final code is shown by approve; join pins nothing a second time and asks nothing; the daemon of the first machine is not told anything', async () => {
      const id = await firstMachinePosts();
      const approved = await approve(a, id);
      expect(approved.code, approved.err).toBe(0);
      const random = (relay.candidacies.get(id) as unknown as { random: string }).random;
      const adminPin = JSON.parse(readFileSync(join(a, 'admin.json'), 'utf8')) as { adminPublicKey: string };
      expect(approved.out).toContain(finalCode(readMachine(a).identity.publicKey, adminPin.adminPublicKey, random));

      const before = readFileSync(join(a, 'admin.json'), 'utf8');
      const joined = await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') });
      expect(joined.code, joined.err).toBe(0);
      expect(joined.out).toContain(`[ok] enrolled "desktop" (${readMachine(a).uuid})`);
      // The admin key was created here: it is already pinned, nothing to compare, and the output says so instead of staying silent.
      expect(joined.out).toMatch(/already pinned/);
      expect(joined.out).not.toMatch(/Security code of/);
      expect(readFileSync(join(a, 'admin.json'), 'utf8')).toBe(before);
      expect(joined.out).toMatch(/no other machine yet: this machine is the first of the network/);
      expect(joined.out).not.toMatch(/peers trusted: none|the admin included none/);
      // The candidacy file is gone: nothing left to resume.
      expect(existsSync(join(a, '_secrets_', 'candidacy.json'))).toBe(false);
    });

    it('status shows enrolled with no peer; list shows only itself; startup status behaves the same before and after', async () => {
      const id = await firstMachinePosts();
      stub.script({ show: { code: 3 } });
      const startupStatus = () => cli(a, ['startup', 'status'], undefined, { startup: { orch: stub.orch, daemon: { platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/opt/machine.cjs' }, platform: 'linux' } });
      const before = await startupStatus();
      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') })).code).toBe(0);
      const status = await ok(a, ['status', '--json']);
      expect(JSON.parse(status.out)).toMatchObject({ enrolled: true, peers: 0, problems: [] });
      const list = await ok(a, ['list', '--json']);
      expect((JSON.parse(list.out) as { peers: unknown[] }).peers).toEqual([]);
      const after = await startupStatus();
      expect(after.code).toBe(before.code);
      expect(after.out).toBe(before.out);
      // Neither the approval nor the join touched the startup job: the only orch calls are the two status reads.
      expect(stub.calls().map((c) => c[0])).toEqual(['show', 'list', 'show', 'list']);
    });

    it('a machine cannot run on itself: it is not in its own peer list', async () => {
      const id = await firstMachinePosts();
      await approve(a, id);
      const r = await cli(a, ['run', 'desktop', '--address', '127.0.0.1:1', '--shell', SHELL, '--', 'echo', 'x']);
      expect(r.code).toBe(255);
      expect(r.err).toMatch(/this machine/);
    });
  });

  /** A daemon of the first machine, started before its approval, with a manual timer. */
  async function daemonBeforeApproval() {
    const logs: string[] = [];
    const pending = new Map<number, () => void>();
    let next = 0;
    const timer = { set: (fn: () => void) => (pending.set(++next, fn), next), clear: (h: unknown) => void pending.delete(h as number) };
    const daemon = await startMachineDaemon(a, { port: 0, version: 'bootstrap', peerPort: 0, peerHost: '127.0.0.1', advertise: [{ host: '127.0.0.1' }], log: (l) => logs.push(l), inbox: { timer } });
    daemons.push(daemon);
    await daemon.inbox?.ready;
    return { daemon, logs, pending, text: () => logs.join(' | ') };
  }

  {
    it('a daemon started before the approval says what to do, keeps no backoff, and publishes by itself in the next round after the approval', async () => {
      const id = await firstMachinePosts();
      const { daemon, logs, pending, text } = await daemonBeforeApproval();
      expect(text()).toMatch(/address record NOT published:.*this machine is not approved yet: run machine join and ask the admin to approve it/s);
      expect(text()).toMatch(/inbox: .*this machine is not approved yet: run machine join and ask the admin to approve it/s);
      // Said once, not at every round.
      await daemon.inbox?.runOnce();
      expect(logs.filter((l) => /not approved yet/.test(l))).toHaveLength(2);
      // The loop is not slowed down: the next round is one heartbeat away, not an exponential backoff.
      expect(pending.size).toBe(1);

      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') })).code).toBe(0);
      await daemon.inbox?.runOnce();
      expect(text()).toMatch(/address record published/);
      expect(text()).toMatch(/inbox: this machine is approved on the relay now/);
      const entry = await relay.inbox(readMachine(a).uuid);
      expect(entry).toEqual([]);
    });
  }

  describe('the second machine joins and is approved by the first', () => {
    /** The first machine is enrolled; the second one joins with its own token and is approved. Returns the id of the second candidacy. */
    async function bothEnrolled(): Promise<void> {
      const id = await firstMachinePosts();
      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes })).code).toBe(0);
      await ok(b, ['init', '--name', 'laptop']);
      await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
      const second = relay.pendingIds()[0] as string;
      const approved = await approve(a, second);
      expect(approved.code, approved.err).toBe(0);
      const asked: string[] = [];
      const joined = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: async (l) => (asked.push(l), 'y') });
      expect(joined.code, joined.err).toBe(0);
      // The second machine does compare the final code: the admin key is new to it.
      expect(asked).toHaveLength(1);
    }

    it('each machine trusts the other, with the same pair secret, and neither lists itself', async () => {
      await bothEnrolled();
      const ua = readMachine(a).uuid;
      const ub = readMachine(b).uuid;
      const why = await diagnose();
      expect(peersOf(a).map((p) => p.registration.body.uuid), why).toEqual([ub]);
      expect(peersOf(b).map((p) => p.registration.body.uuid), why).toEqual([ua]);
      expect((peersOf(a)[0] as { pairSecret: string }).pairSecret, why).toBe((peersOf(b)[0] as { pairSecret: string }).pairSecret);
      expect(JSON.parse((await ok(a, ['status', '--json'])).out), why).toMatchObject({ enrolled: true, peers: 1, problems: [] });
      expect(JSON.parse((await ok(b, ['status', '--json'])).out), why).toMatchObject({ enrolled: true, peers: 1, problems: [] });
      // The second approval was sealed to the key of the second machine, with the first machine as the only peer.
      const sent = (decisions()[1]?.body as { approval: { adminUuid: string; random: string; peers: { sealedPairSecret: string }[] } }).approval;
      expect(sent.peers, why).toHaveLength(1);
      const opened = Buffer.from(openSealed(readMachine(b).identity.privateKeyPkcs8, sent.peers[0]?.sealedPairSecret as string, pairSecretContext({ adminUuid: ua, candidateUuid: ub, random: sent.random, slot: `peer:${ua}` }))).toString('base64url');
      expect(opened, why).toBe((peersOf(b)[0] as { pairSecret: string }).pairSecret);
    });

    it('the admin sent nothing to its own inbox and nothing to the new machine beyond the approval (no other peer yet)', async () => {
      await bothEnrolled();
      const why = await diagnose();
      expect(relay.inbox(readMachine(a).uuid), why).toEqual([]);
      expect(relay.inbox(readMachine(b).uuid), why).toEqual([]);
    });

    it('a third machine: the others get one peer document each about each other, none is sent to the admin machine about itself, none to a machine about itself', async () => {
      await bothEnrolled();
      const c = join(root, 'c');
      mkdirSync(c);
      await ok(c, ['init', '--name', 'nas']);
      await ok(c, ['join', THIRD_CODE, '--relay', relay.url, '--no-wait']);
      const third = relay.pendingIds()[0] as string;
      const approved = await approve(a, third);
      expect(approved.code, approved.err).toBe(0);
      expect(approved.out).toContain('2 document(s) stored by the relay for 1 machine(s)');
      const [ua, ub, uc] = [readMachine(a).uuid, readMachine(b).uuid, readMachine(c).uuid];
      const about = (uuid: string) => relay.inbox(uuid).map((d) => ((d.document as { body: { kind: string; payload: { registration: { body: { uuid: string } } } } }).body.payload.registration.body.uuid));
      expect(relay.inbox(ua)).toEqual([]);
      expect(about(ub)).toEqual([uc]);
      expect(about(uc)).toEqual([ub]);
      // The admin machine knows both by itself.
      expect(peersOf(a).map((p) => p.registration.body.uuid).sort()).toEqual([ub, uc].sort());
      // The admin machine is not a distribution subject for itself: a clear refusal, no document.
      const self = await cli(a, ['admin', 'distribute', 'desktop'], async () => passphrase);
      expect(self.code, self.err).toBe(0);
      expect(self.out).toMatch(/this is the admin machine itself: nothing to distribute to itself/);
      expect(relay.inbox(ua)).toEqual([]);
    });

    it('the first machine runs a command on the second one, with the address given and with the record the daemon published', async () => {
      await bothEnrolled();
      // The second machine gets its policy from the first through the relay inbox, like in real life.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(root, 'draft.json'), JSON.stringify({ v: 1, target: readMachine(b).uuid, version: 1, baseVersion: 0, defaults: [{ shell: SHELL, command: 'echo hello from laptop' }], peers: {} }));
      const signed = await cli(a, ['admin', 'sign-policy', join(root, 'draft.json'), '--out', join(root, 'policy-b.json')], async () => passphrase);
      expect(signed.code, signed.err).toBe(0);
      await ok(b, ['policy', 'install', join(root, 'policy-b.json')]);

      const daemon = await startMachineDaemon(b, { port: 0, version: 'bootstrap', peerPort: 0, peerHost: '127.0.0.1', advertise: [{ host: '127.0.0.1' }], log: () => undefined });
      daemons.push(daemon);
      await daemon.inbox?.ready;
      const byAddress = await cli(a, ['run', 'laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop']);
      expect(byAddress.err).toBe('');
      expect(byAddress.code).toBe(0);
      expect(byAddress.out.trim()).toBe('hello from laptop');
      const byRecord = await cli(a, ['run', 'laptop', '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop'], undefined, { allowLoopbackPeers: true });
      expect(byRecord.err).toBe('');
      expect(byRecord.code).toBe(0);
      expect(byRecord.out.trim()).toBe('hello from laptop');
      expect(readRelayConfig(b)?.label).toBe('machine-pairing-2');
    });
  });
});
