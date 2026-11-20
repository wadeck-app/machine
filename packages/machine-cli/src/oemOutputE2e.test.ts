import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { cli, provision } from './testing.js';

// The target is this Windows machine: cmd writes its OEM code page, the daemon decodes it (decision 72) and the caller says so.
// Not applicable elsewhere: only Windows has an OEM code page.
let root: string;
const stoppers: Array<() => Promise<void>> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-oem-e2e-'));
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('output in the OEM code page of the target', () => {
  it('shows the accents and an [info] line, no [warn]', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    // 0x82 is e acute in the OEM pages; `type` copies the bytes untouched.
    const file = join(root, 'oem.txt');
    writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0x82, 0x0d, 0x0a]));
    const command = `type "${file}"`;
    await provision(root, a, b, [{ shell: 'cmd', command }]);
    const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1' });
    stoppers.push(daemon.stop);
    const r = await cli(a, ['run', 'laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--shell', 'cmd', '--', command]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`caf${String.fromCharCode(0xe9)}`);
    expect(r.err).toMatch(/\[info\] output decoded from the target's code page cp\d+/);
    expect(r.err).not.toContain('[warn]');
  });
});
