import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, HEADER, OTHER_UUID, PEER_UUID, type Harness } from './pageRoutes.testUtil.js';

// Rename from the page (admin-ui.md, "Rename from the page"). The BROWSER signed the re-issued registration and the documents; these routes only check their shape and
// hand them to the daemon of the admin machine (commands renameContext and renameApply), which verifies, installs and delivers. They sign nothing and see no passphrase.

const CONTEXT = 'GET /rename-context/:uuid';
const APPLY = 'POST /rename';

let h: Harness;
beforeEach(() => {
  h = harness('app-module-machine-rename-');
});
afterEach(async () => {
  await h.close();
});

describe('GET /rename-context/:uuid: what the page needs before it asks the passphrase', () => {
  const context = { ok: true, adminMachine: { uuid: OTHER_UUID, name: 'desk' }, machine: { uuid: PEER_UUID, name: 'laptop', serial: 3, keyId: 'k' }, current: { body: {}, signature: 's' }, machines: [], aliases: {}, networkAliases: {}, revokedUpTo: null, others: [], noticeRecipients: null };

  it('is a sensitive route (the app-core PIN) and needs the module header: 403 without it, no daemon call', async () => {
    expect(h.routes().get(CONTEXT)?.options).toEqual({ effect: 'sensitive' });
    await h.startDaemon({ renameContext: context });
    const out = await h.call(CONTEXT, { params: { uuid: PEER_UUID } });
    expect(out.status).toBe(403);
    expect(h.events).toEqual([]);
  });

  it('forwards exactly the uuid to the daemon command renameContext and answers what it answered', async () => {
    const bodies = await h.startDaemon({ renameContext: context });
    const out = await h.call(CONTEXT, { headers: HEADER, params: { uuid: PEER_UUID } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(context);
    expect(bodies).toEqual([{ command: 'renameContext', body: { uuid: PEER_UUID } }]);
  });

  it('a bad uuid in the path is a 400 before any call', async () => {
    await h.startDaemon({ renameContext: context });
    const out = await h.call(CONTEXT, { headers: HEADER, params: { uuid: 'nope' } });
    expect(out.status).toBe(400);
    expect(out.body.kind).toBe('bad_request');
    expect(h.events).toEqual([]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['no-admin-key', 409], ['not-initialized', 409], ['self', 409], ['not-trusted', 409], ['revoked', 409], ['notice-recipients-invalid', 409], ['aliases-invalid', 409]];
    for (const [reason, status] of cases) {
      await h.startDaemon({ renameContext: { ok: false, reason, message: `cause of ${reason}: fix it` } });
      const out = await h.call(CONTEXT, { headers: HEADER, params: { uuid: PEER_UUID } });
      expect(out.status, reason).toBe(status);
      expect(out.body.error).toBe(`cause of ${reason}: fix it`);
    }
  });

  it('a daemon that is not running is a loud 503 naming the fix', async () => {
    const out = await h.call(CONTEXT, { headers: HEADER, params: { uuid: PEER_UUID } });
    expect(out.status).toBe(503);
    expect(out.body.error).toMatch(/daemon/);
  });
});

describe('POST /rename: the rename the page signed', () => {
  const doc = (to: string): Record<string, unknown> => ({ body: { v: 2, kind: 'peer', to, id: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: 1, expiresAt: 2, payload: { sealed: 'x' } }, signature: 'sig' });
  const signed = { body: { v: 1, uuid: PEER_UUID, name: 'mac-m2', identityPublicKey: 'k', serial: 4, validFrom: 5, validTo: 9, adminKeyId: 'k'.repeat(32) }, signature: 'sig' };
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ uuid: PEER_UUID, signed, documents: [doc(OTHER_UUID)], noticeRecipients: null, ...extra });
  const DONE = { ok: true, subject: { uuid: PEER_UUID, name: 'mac-m2' }, failed: false, report: { delivered: 2, alreadyThere: 0, failures: [], aborted: false, machines: 2 }, text: { out: '[ok] 2 document(s)\n', err: '' }, machines: [], retry: 'machine admin rename mac-m2 mac-m2' };

  it('is a sensitive route (the app-core PIN): it changes the name this machine trusts a machine under and spends the relay token', () => {
    expect(h.routes().get(APPLY)?.options).toEqual({ effect: 'sensitive' });
  });

  it('without the module header: 403, no daemon call', async () => {
    await h.startDaemon({ renameApply: DONE });
    const out = await h.call(APPLY, { body: body() });
    expect(out.status).toBe(403);
    expect(h.events).toEqual([]);
  });

  it('the body is exactly { uuid, signed, documents, noticeRecipients }: a missing field, an extra field (a passphrase cannot travel here) or a bad shape is a 400 before any call', async () => {
    await h.startDaemon({ renameApply: DONE });
    for (const bad of [undefined, { uuid: PEER_UUID }, body({ passphrase: 'x' }), body({ uuid: 'nope' }), body({ signed: 'x' }), body({ documents: 'x' }), body({ documents: [5] }), body({ noticeRecipients: 'x' })]) {
      const out = await h.call(APPLY, { headers: HEADER, body: bad });
      expect(out.status, JSON.stringify(bad)).toBe(400);
      expect(out.body.kind).toBe('bad_request');
    }
    expect(h.events).toEqual([]);
  });

  it('refuses a body larger than the relay can ever store, before any call', async () => {
    await h.startDaemon({ renameApply: DONE });
    const out = await h.call(APPLY, { headers: HEADER, body: body({ documents: Array.from({ length: 80 }, () => ({ ...doc(OTHER_UUID), pad: 'A'.repeat(16 * 1024) })) }) });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/too large/);
    expect(h.events).toEqual([]);
  });

  it('forwards exactly the four fields to the daemon command renameApply and answers what it answered', async () => {
    const bodies = await h.startDaemon({ renameApply: DONE });
    const sent = body({ documents: [doc(OTHER_UUID), doc(PEER_UUID)] });
    const out = await h.call(APPLY, { headers: HEADER, body: sent });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(DONE);
    expect(bodies).toEqual([{ command: 'renameApply', body: sent }]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['bad-registration', 422], ['bad-document', 422], ['bad-notice-recipients', 422], ['stale-notice-recipients', 409], ['not-trusted', 409], ['revoked', 409], ['self', 409], ['no-admin-key', 409], ['refused', 409], ['aliases-invalid', 409]];
    for (const [reason, status] of cases) {
      await h.startDaemon({ renameApply: { ok: false, reason, message: `cause of ${reason}: fix it` } });
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
