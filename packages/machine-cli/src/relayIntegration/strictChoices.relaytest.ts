import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorld, type World } from './world.js';

// The OPT-IN strict mode of the relay (machines-config.json deviceLoginChoices, decision 60): the console lists six codes, a click on a decoy denies.
// The default mode (one Approve button on the real code) is covered by onboarding.relaytest.ts.

let w: World;

const relayGet = async (path: string, token: string) => {
  const r = await fetch(`${w.relay.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  w = await startWorld('strict-choices', { deviceLoginChoices: true });
});
afterAll(async () => {
  await w.stop();
});

describe('strict relay mode with six codes (real relay)', () => {
  it('a decoy clicked in the console (one of the six codes, not the one the machine shows) denies the request on the real relay: join says so, nothing is saved; the same for the admin login of setup', async () => {
    const decoyClick = async (out: string): Promise<void> => {
      const shown = /^\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(out)?.[1];
      if (shown === undefined) throw new Error(`no code in:\n${out}`);
      const list = await relayGet('/api/device-login', w.relay.adminToken);
      const request = (list.body.requests as { id: string; choices: string[] }[]).find((r) => r.choices.includes(shown));
      if (request === undefined) throw new Error(`the console does not list a request offering ${shown}: ${JSON.stringify(list.body)}`);
      expect(request.choices).toHaveLength(6);
      const decoy = request.choices.find((c) => c !== shown) as string;
      const clicked = await fetch(`${w.relay.url}/api/device-login/${request.id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${w.relay.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ userCode: decoy }) });
      expect([clicked.status, ((await clicked.json()) as { error: string }).error]).toEqual([409, 'request_denied']);
    };
    const joiner = w.machineDir('decoy-join');
    let clicked = false;
    const joined = await w.run('decoy', joiner, ['join', w.relay.url], {
      hostname: 'Decoy',
      approveDevice: false,
      onWait: async (_n, out) => {
        if (!clicked && /^\s*[A-Z0-9]{4}-[A-Z0-9]{4}\s*$/m.test(out)) {
          clicked = true;
          await decoyClick(out);
        }
      },
    });
    expect(joined.code).toBe(1);
    expect(joined.err).toMatch(/the request was denied in the relay console \(a different code was chosen/);
    expect(joined.err).toMatch(/approve the request that shows this code/);
    expect(existsSync(join(joiner, '_secrets_', 'relay.json'))).toBe(false);

    const admin = w.machineDir('decoy-setup');
    clicked = false;
    const setup = await w.run('decoy2', admin, ['setup', w.relay.url], {
      hostname: 'Decoy2',
      visible: [''],
      approveDevice: false,
      onWait: async (_n, out) => {
        if (!clicked && /^\s*[A-Z0-9]{4}-[A-Z0-9]{4}\s*$/m.test(out)) {
          clicked = true;
          await decoyClick(out);
        }
      },
    });
    expect(setup.code).toBe(1);
    expect(setup.err).toMatch(/a different code was chosen/);
    expect(setup.err).toMatch(/run `machine setup` again/);
    for (const file of ['relay.json', 'relay-admin.json']) expect(existsSync(join(admin, '_secrets_', file))).toBe(false);
    const pending = await relayGet('/api/machines/candidacies', w.relay.adminToken);
    expect(pending.body.candidacies).toEqual([]);
  });
});
