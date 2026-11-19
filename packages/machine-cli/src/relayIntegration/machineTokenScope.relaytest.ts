import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelayClient, RelayError } from '../relayClient.js';
import { startWorld, type World } from './world.js';

// A plain machine token on the admin calls of the REAL relay (`npm run test:relay`): the scope gate answers 403 with a free text in `error`
// and no code. The client must turn it into the advice to run `machine admin login`, not into the generic "token may lack the machine scope".

let w: World;
let token: string;

beforeAll(async () => {
  w = await startWorld('machineTokenScope');
  const claimed = await createRelayClient({ baseUrl: w.relay.url }).claimPairing(await w.relay.machinePairingCode());
  token = claimed.token;
});
afterAll(async () => {
  await w.stop();
});

describe('a plain machine token on the real relay', () => {
  it('is a machine-scoped token', async () => {
    const r = await fetch(`${w.relay.url}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await r.json()) as { scopes: unknown }).scopes).toEqual(['machine']);
  });

  it('the raw answer of the gate on the candidacy list: 403, a free text, no code', async () => {
    const r = await fetch(`${w.relay.url}/api/machines/candidacies`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await r.json()) as Record<string, unknown>;
    expect(r.status).toBe(403);
    expect(body.error).toMatch(/^This token is limited to the scope machine and cannot call GET \/api\/machines\/candidacies/);
    expect(body.code).toBeUndefined();
  });

  it('listCandidacies: the advice to run machine admin login, with the relay text and without the token', async () => {
    const client = createRelayClient({ baseUrl: w.relay.url, token });
    const e = await client.listCandidacies().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(RelayError);
    const message = (e as RelayError).message;
    expect((e as RelayError).status).toBe(403);
    expect(message).toContain('plain machine token');
    expect(message).toContain('machine admin login');
    expect(message).toContain('This token is limited to the scope machine');
    expect(message).not.toContain(token);
    expect(message).not.toContain('may lack the "machine" scope');
  });
});
