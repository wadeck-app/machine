import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HoldTable, buildRequestNotice, type StoredNotice } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';
import { readMachine } from './identity.js';
import { recordNoticeEndOutcome } from './noticeEnds.js';
import { recordNotice } from './noticesStore.js';
import { ok } from './testing.js';

// The `holdProgress` command of the daemon (decision 86): after an Allow, is the request still held, or how did the hold end? The Requests page asks every 2 s.
// For a request held on THIS machine the answer comes from the hold table and the outcomes kept here; for another machine from the notices it sent.

const PEER = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const OTHER = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const REQUEST = '3f1c2d3e-4a5b-4c6d-8e7f-000000000001';
const NOW = 1_800_000_000;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'machine-progress-'));
  await ok(dir, ['init', '--name', 'desktop']);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const heldNotice = (): StoredNotice => {
  const { type: _type, ...rest } = buildRequestNotice({ id: REQUEST, peer: PEER, peerName: 'agent', shell: 'sh', command: 'ls', state: 'held', deadline: NOW + 600, now: NOW });
  return { ...rest, machine: OTHER, machineName: 'thinkcentre', receivedAt: NOW };
};

describe('daemon command holdProgress', () => {
  it('a request held on this machine is held; once it ended the recorded outcome is the answer', () => {
    const table = new HoldTable();
    table.admit({ id: REQUEST, peer: PEER, shell: 'sh', command: 'ls', now: NOW, requestedSeconds: 600, capSeconds: 1800 });
    const commands = makeCommands(dir, 'test', () => NOW, table);
    expect(commands.holdProgress({ id: REQUEST })).toMatchObject({ ok: true, state: 'held', machine: { name: 'desktop' } });
    table.end(REQUEST);
    expect(commands.holdProgress({ id: REQUEST })).toMatchObject({ ok: true, state: 'unknown' });
    recordNoticeEndOutcome(dir, { machine: readMachine(dir).uuid, id: REQUEST, outcome: 'allowed', at: NOW }, NOW);
    expect(commands.holdProgress({ id: REQUEST })).toMatchObject({ ok: true, state: 'ended', outcome: 'allowed', at: NOW });
  });

  it('a request held on another machine: held while its notice stands, ended with the outcome that machine reported', () => {
    recordNotice(dir, heldNotice(), NOW);
    const commands = makeCommands(dir, 'test', () => NOW, new HoldTable());
    expect(commands.holdProgress({ id: REQUEST, machine: OTHER })).toMatchObject({ ok: true, state: 'held' });
    recordNoticeEndOutcome(dir, { machine: OTHER, id: REQUEST, outcome: 'denied', at: NOW + 3 }, NOW + 3);
    // The end of the hold drops its notice too (recordNoticeEnd does both); here only the outcome was written, so it wins.
    expect(commands.holdProgress({ id: REQUEST, machine: OTHER })).toMatchObject({ ok: true, state: 'ended', outcome: 'denied' });
  });

  it('an Allow whose command could not start ends as refused and carries the reason and the message of the daemon', () => {
    const commands = makeCommands(dir, 'test', () => NOW, new HoldTable());
    const failure = { reason: 'cannot-run', message: 'shell "sh" is not supported on Windows: use "cmd" or "ps" in the policy entry' };
    recordNoticeEndOutcome(dir, { machine: readMachine(dir).uuid, id: REQUEST, outcome: 'refused', at: NOW, failure }, NOW);
    expect(commands.holdProgress({ id: REQUEST })).toMatchObject({ ok: true, state: 'ended', outcome: 'refused', ...failure });
  });

  it('nothing known about the request is unknown, never a success', () => {
    const commands = makeCommands(dir, 'test', () => NOW, new HoldTable());
    expect(commands.holdProgress({ id: REQUEST, machine: OTHER })).toMatchObject({ ok: true, state: 'unknown' });
    expect(commands.holdProgress({ id: REQUEST })).toMatchObject({ ok: true, state: 'unknown' });
  });

  it('without a daemon (no hold table) a local request is unknown, and says why', () => {
    const answer = makeCommands(dir, 'test', () => NOW).holdProgress({ id: REQUEST });
    expect(answer).toMatchObject({ ok: true, state: 'unknown', note: expect.stringMatching(/daemon is not running/) });
  });

  it('refuses a payload without a request id, naming the shape', () => {
    expect(makeCommands(dir, 'test', () => NOW, new HoldTable()).holdProgress({})).toMatchObject({ ok: false, reason: 'bad-payload', message: expect.stringMatching(/"id"/) });
    expect(makeCommands(dir, 'test', () => NOW, new HoldTable()).holdProgress({ id: 'not an id!' })).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('a machine that is not a trusted peer is refused with the way to list them', () => {
    expect(makeCommands(dir, 'test', () => NOW, new HoldTable()).holdProgress({ id: REQUEST, machine: 'nobody' })).toMatchObject({ ok: false, reason: 'unknown-peer', message: expect.stringMatching(/machine list/) });
  });
});
