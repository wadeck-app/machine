import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, HEADER, OTHER_UUID, PEER_UUID, type Harness } from './pageRoutes.testUtil.js';

// Network aliases from the page (decision 116, admin-ui.md). The BROWSER signed the list and the documents; these routes only check their shape and hand them to the
// daemon of the admin machine (commands aliasesContext and aliasesApply), which verifies, installs and delivers. They sign nothing and see no passphrase.

const CONTEXT = 'GET /aliases-context';
const APPLY = 'POST /aliases';

let h: Harness;
beforeEach(() => {
  h = harness('app-module-machine-aliases-');
});
afterEach(async () => {
  await h.close();
});

describe('GET /aliases-context: what the page needs before it asks the passphrase', () => {
  const context = { ok: true, adminMachine: { uuid: OTHER_UUID, name: 'desk' }, adminPublicKey: 'p', adminKeyId: 'i', current: null, machines: [], revoked: [], localAliases: {}, recipients: [] };

  it('is a sensitive route (the app-core PIN) and needs the module header: 403 without it, no daemon call', async () => {
    expect(h.routes().get(CONTEXT)?.options).toEqual({ effect: 'sensitive' });
    await h.startDaemon({ aliasesContext: context });
    const out = await h.call(CONTEXT, {});
    expect(out.status).toBe(403);
    expect(h.events).toEqual([]);
  });

  it('calls the daemon command aliasesContext with an empty payload and answers what it answered', async () => {
    const bodies = await h.startDaemon({ aliasesContext: context });
    const out = await h.call(CONTEXT, { headers: HEADER });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(context);
    expect(bodies).toEqual([{ command: 'aliasesContext', body: {} }]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['no-admin-key', 409], ['not-initialized', 409], ['aliases-invalid', 409]];
    for (const [reason, status] of cases) {
      await h.startDaemon({ aliasesContext: { ok: false, reason, message: `cause of ${reason}: fix it` } });
      const out = await h.call(CONTEXT, { headers: HEADER });
      expect(out.status, reason).toBe(status);
      expect(out.body.error).toBe(`cause of ${reason}: fix it`);
    }
  });

  it('a daemon that is not running is a loud 503 naming the fix', async () => {
    const out = await h.call(CONTEXT, { headers: HEADER });
    expect(out.status).toBe(503);
    expect(out.body.error).toMatch(/daemon/);
  });
});

describe('POST /aliases: the list the page signed', () => {
  const doc = (to: string): Record<string, unknown> => ({ body: { v: 2, kind: 'aliases', to, id: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: 1, expiresAt: 2, payload: { sealed: 'x' } }, signature: 'sig' });
  const signed = { body: { v: 1, adminKeyId: 'k'.repeat(32), serial: 5, issuedAt: 5, entries: [{ alias: 'box', uuid: PEER_UUID }] }, signature: 'sig' };
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ signed, documents: [doc(OTHER_UUID)], ...extra });
  const DONE = { ok: true, serial: 5, entries: [{ alias: 'box', uuid: PEER_UUID, name: 'laptop' }], changed: true, failed: false, report: { delivered: 1, alreadyThere: 0, failures: [], aborted: false, machines: 1 }, text: { out: '[ok] 1 document(s)\n', err: '' }, machines: [], retry: 'machine admin alias send' };

  it('is a sensitive route (the app-core PIN): it changes what a reference means on every machine and spends the relay token', () => {
    expect(h.routes().get(APPLY)?.options).toEqual({ effect: 'sensitive' });
  });

  it('without the module header: 403, no daemon call', async () => {
    await h.startDaemon({ aliasesApply: DONE });
    const out = await h.call(APPLY, { body: body() });
    expect(out.status).toBe(403);
    expect(h.events).toEqual([]);
  });

  it('the body is exactly { signed, documents }: a missing field, an extra field (a passphrase cannot travel here) or a bad shape is a 400 before any call', async () => {
    await h.startDaemon({ aliasesApply: DONE });
    for (const bad of [undefined, { signed }, body({ passphrase: 'x' }), body({ signed: 'x' }), body({ documents: 'x' }), body({ documents: [5] })]) {
      const out = await h.call(APPLY, { headers: HEADER, body: bad });
      expect(out.status, JSON.stringify(bad)).toBe(400);
      expect(out.body.kind).toBe('bad_request');
    }
    expect(h.events).toEqual([]);
  });

  it('refuses a body larger than the relay can ever store, before any call', async () => {
    await h.startDaemon({ aliasesApply: DONE });
    const out = await h.call(APPLY, { headers: HEADER, body: body({ documents: Array.from({ length: 80 }, () => ({ ...doc(OTHER_UUID), pad: 'A'.repeat(16 * 1024) })) }) });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/too large/);
    expect(h.events).toEqual([]);
  });

  it('forwards exactly the two fields to the daemon command aliasesApply and answers what it answered', async () => {
    const bodies = await h.startDaemon({ aliasesApply: DONE });
    const sent = body({ documents: [doc(OTHER_UUID), doc(PEER_UUID)] });
    const out = await h.call(APPLY, { headers: HEADER, body: sent });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(DONE);
    expect(bodies).toEqual([{ command: 'aliasesApply', body: sent }]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['bad-aliases', 422], ['bad-document', 422], ['stale-aliases', 409], ['aliases-invalid', 409], ['no-admin-key', 409], ['refused', 409]];
    for (const [reason, status] of cases) {
      await h.startDaemon({ aliasesApply: { ok: false, reason, message: `cause of ${reason}: fix it` } });
      const out = await h.call(APPLY, { headers: HEADER, body: body() });
      expect(out.status, reason).toBe(status);
      expect(out.body.error).toBe(`cause of ${reason}: fix it`);
    }
  });

  it('a daemon that is not running is a loud 503 naming the fix', async () => {
    const out = await h.call(APPLY, { headers: HEADER, body: body() });
    expect(out.status).toBe(503);
    expect(out.body.error).toMatch(/daemon/);
  });
});
