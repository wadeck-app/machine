import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
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

  it('pages by page and pageSize, says the total is exact, and refuses a page past the last one with the last page', async () => {
    for (let n = 1; n <= 30; n++) {
      send(n, n % 2 === 0 ? 'ran' : 'denied');
    }
    const commands = makeCommands(dir, 'test');
    const second = await commands.activity({ page: '2', pageSize: '25' });
    expect(second).toMatchObject({ ok: true, page: { total: 30, totalExact: true, page: 2, pageSize: 25, pageCount: 2, hasMore: false } });
    expect((second as { page: { items: unknown[] } }).page.items).toHaveLength(5);
    const filtered = await commands.activity({ outcome: 'ran', page: '1', pageSize: '25' });
    expect(filtered).toMatchObject({ ok: true, page: { total: 15, totalExact: true, pageCount: 1 } });
    expect(await commands.activity({ page: '3', pageSize: '25' })).toMatchObject({ ok: false, reason: 'bad-query', message: expect.stringContaining('page 3 is beyond the last page (2)') });
    expect(await commands.activity({ pageSize: '30' })).toMatchObject({ ok: false, reason: 'bad-query', message: expect.stringContaining('pageSize') });
  });

  it('keeps the count of damaged lines of the whole log, and says when a file was recounted after a change that was not an append', async () => {
    send(1, 'ran');
    const commands = makeCommands(dir, 'test');
    expect(await commands.activity({})).toMatchObject({ ok: true, runLog: { damagedLines: 0, recounted: [] } });
    // A damaged line appended: counted from where the cache stopped, the total stays exact.
    appendFileSync(join(dir, 'run-log', 'runs.ndjson'), '{"v":1,"ts":\n');
    expect(await commands.activity({})).toMatchObject({ ok: true, page: { total: 1, totalExact: true }, runLog: { damagedLines: 1, recounted: [] } });
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
