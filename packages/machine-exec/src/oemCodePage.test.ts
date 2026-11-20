import { describe, expect, it } from 'vitest';
import { detectOemCodePage } from './oemCodePage.js';
import { runCommand } from './run.js';

describe.runIf(process.platform === 'win32')('detectOemCodePage on this Windows machine', () => {
  it('agrees with the page `chcp` reports to a fresh console', async () => {
    const page = await detectOemCodePage(process.env);
    const chcp = await runCommand({ shell: 'cmd', command: 'chcp', timeoutMs: 30_000, maxOutputBytes: 10_000 });
    const reported = /(\d{3,5})\s*$/m.exec(chcp.stdout.trim());
    expect(reported, `chcp printed ${JSON.stringify(chcp.stdout)}`).not.toBeNull();
    expect(page).toBe(Number(reported![1]));
  });

  it('is unknown (undefined), not a crash, when SystemRoot is missing', async () => {
    expect(await detectOemCodePage({})).toBeUndefined();
  });

  it('answers again from the cache', async () => {
    const first = await detectOemCodePage(process.env);
    const started = Date.now();
    const second = await detectOemCodePage(process.env);
    expect(second).toBe(first);
    expect(Date.now() - started).toBeLessThan(20);
  });
});

describe.runIf(process.platform !== 'win32')('detectOemCodePage elsewhere', () => {
  it('is unknown: there is no OEM code page outside Windows', async () => {
    expect(await detectOemCodePage(process.env)).toBeUndefined();
  });
});
