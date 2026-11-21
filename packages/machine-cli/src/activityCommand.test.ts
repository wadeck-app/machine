import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunLogLine } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';
import { readMachine } from './identity.js';
import { appendRunLog } from './runLogStore.js';
import { cli } from './testing.js';

// The `activity` command of the daemon (the Activity page of the module): the same reader as `machine log`, with the filters as the query of the page.

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'machine-activity-cmd-'));
  const r = await cli(dir, ['init', '--name', 'desktop']);
  expect(r.code, r.err).toBe(0);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function send(n: number, outcome: 'ran' | 'denied'): void {
  const line = buildRunLogLine({
    now: Date.now() - n * 60_000,
    runId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    from: { name: 'desktop', uuid: readMachine(dir).uuid },
    to: { name: 'laptop', uuid: '22222222-2222-4222-8222-222222222222' },
    shell: 'sh',
    command: `echo ${n}`,
    waitMode: 'default',
    onRefusal: 'wait',
    waitSeconds: 600,
    waitedSeconds: 0,
    outcome: outcome === 'ran' ? { outcome: 'ran', exitCode: 0 } : { outcome: 'denied', reason: 'denied' },
    durationMs: 5,
  });
  expect(appendRunLog(dir, line).written).toBe(true);
}

describe('daemon command activity', () => {
  it('answers the page of the timeline, filtered by the query', async () => {
    send(1, 'ran');
    send(2, 'denied');
    send(3, 'ran');
    const commands = makeCommands(dir, 'test');
    const all = await commands.activity({});
    expect(all).toMatchObject({ initialized: true, ok: true, page: { total: 3, counts: { sent: 3, received: 0 } }, machines: ['laptop'] });
    const some = await commands.activity({ outcome: 'ran', limit: '1', offset: '1' });
    expect(some).toMatchObject({ ok: true, page: { total: 2, offset: 1, limit: 1, hasMore: false } });
  });

  it('refuses a bad query with a reason and the fix, never a guess', async () => {
    const commands = makeCommands(dir, 'test');
    expect(await commands.activity({ outcome: 'done' })).toMatchObject({ ok: false, reason: 'bad-query', message: expect.stringContaining('outcome "done" is not a choice') });
    expect(await commands.activity({ colour: 'red' })).toMatchObject({ ok: false, reason: 'bad-query', message: expect.stringContaining('colour') });
    expect(await commands.activity('x')).toMatchObject({ ok: false, reason: 'bad-query' });
    expect(await commands.activity({ limit: 5 })).toMatchObject({ ok: false, reason: 'bad-query', message: expect.stringContaining('limit') });
  });

  it('says so when the machine is not initialized', async () => {
    const commands = makeCommands(join(dir, 'nothing'), 'test');
    expect(await commands.activity({})).toMatchObject({ initialized: false });
  });
});
