import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectOemCodePage } from './oemCodePage.js';
import { runCommand, type RunOptions } from './run.js';

// These run the REAL shells of the machine that executes the tests (T-15 conformance). Each platform block states what
// it needs; a platform that is not the current one is not applicable (not "skipped on a missing artifact").
const onWindows = process.platform === 'win32';
const onUnix = !onWindows;

const quick: Pick<RunOptions, 'timeoutMs' | 'maxOutputBytes'> = { timeoutMs: 30_000, maxOutputBytes: 100_000 };

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

describe.runIf(onWindows)('real cmd', () => {
  it('keeps double quotes exactly as approved', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'echo "hi there"', ...quick });
    expect(lines(r.stdout)).toEqual(['"hi there"']);
    expect(r.exitCode).toBe(0);
  });

  it('lets the approved string use cmd operators (the human approved that exact string)', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'echo a&echo b', ...quick });
    expect(lines(r.stdout)).toEqual(['a', 'b']);
  });

  it('returns the exit code', async () => {
    expect((await runCommand({ shell: 'cmd', command: 'exit 3', ...quick })).exitCode).toBe(3);
  });

  it('runs ipconfig (acceptance scenario)', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'ipconfig', ...quick });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(20);
  });

  it('does not pass secrets of the daemon environment to the command', async () => {
    process.env.MACHINE_TEST_SECRET = 'leaked-value';
    try {
      const r = await runCommand({ shell: 'cmd', command: 'echo %MACHINE_TEST_SECRET%', ...quick });
      expect(r.stdout).not.toContain('leaked-value');
      expect(r.stdout).toContain('%MACHINE_TEST_SECRET%');
    } finally {
      delete process.env.MACHINE_TEST_SECRET;
    }
  });

  it('has no usable stdin: a prompt returns instead of hanging', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'set /p x=prompt', timeoutMs: 10_000, maxOutputBytes: 10_000 });
    expect(r.timedOut).toBe(false);
  });

  it('kills the whole process tree on timeout', async () => {
    const started = Date.now();
    const r = await runCommand({ shell: 'cmd', command: 'ping -n 30 127.0.0.1', timeoutMs: 700, maxOutputBytes: 10_000 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops a command that produces too much output and says the output is truncated', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'for /L %i in (1,1,1000000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeoutMs: 30_000, maxOutputBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1000);
  });
});

describe.runIf(onWindows)('real cmd, output in the OEM code page', () => {
  const accented = String.fromCharCode(0xe9);
  // The approved string must be printable ASCII (T-15): the OEM bytes come from a file that `type` copies untouched.
  // 0x82 is e acute in cp437/850/858/852/860/863/865.
  const oemBytes = Buffer.from([0x63, 0x61, 0x66, 0x82, 0x0d, 0x0a]);
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'machine-exec-oem-'));
    file = join(dir, 'oem.txt');
    writeFileSync(file, oemBytes);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('decodes what cmd writes in the OEM page instead of reporting a lossy decoding', async () => {
    const page = await detectOemCodePage(process.env);
    expect(page, 'the OEM code page of this machine could not be read from the registry').toBeDefined();
    const r = await runCommand({ shell: 'cmd', command: `type "${file}"`, ...quick });
    expect(r.exitCode).toBe(0);
    expect(lines(r.stdout)).toEqual([`caf${accented}`]);
    expect(r.outputNotUtf8).toBe(false);
    expect(r.decodedFrom).toBe(`cp${String(page)}`);
  });

  it('decodes stderr too', async () => {
    const r = await runCommand({ shell: 'cmd', command: `type "${file}" 1>&2`, ...quick });
    expect(lines(r.stderr)).toEqual([`caf${accented}`]);
    expect(r.decodedFrom).toMatch(/^cp\d+$/);
  });

  it('keeps the warning when the page of the machine is unknown', async () => {
    const r = await runCommand({ shell: 'cmd', command: `type "${file}"`, oemCodePage: async () => undefined, ...quick });
    expect(r.outputNotUtf8).toBe(true);
    expect(r.decodedFrom).toBeUndefined();
  });

  it('does not touch valid UTF-8', async () => {
    const r = await runCommand({ shell: 'cmd', command: 'echo plain', ...quick });
    expect(r.decodedFrom).toBeUndefined();
    expect(r.outputNotUtf8).toBe(false);
  });
});

describe.runIf(onWindows)('real PowerShell', () => {
  // The first PowerShell launch on the windows-latest runner stayed silent for the whole 30 s three times (no byte on stdout or stderr,
  // exit code null; cause unproven: start-up or hang). This separate, generous first launch tells the two apart: if it finishes, the
  // start-up was only slow and its duration is in the log; if it times out too, PowerShell really hangs and this fails with the timing.
  // It does not touch the assertions of the tests below.
  beforeAll(async () => {
    const r = await runCommand({ shell: 'ps', command: 'Write-Output ready', timeoutMs: 180_000, maxOutputBytes: 100_000 });
    process.stderr.write(`[run.test] first PowerShell launch: ${r.durationMs} ms, exit ${String(r.exitCode)}, timedOut ${String(r.timedOut)}\n`);
    expect(r.timedOut, `the first PowerShell launch did not answer within ${r.durationMs} ms (stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}): PowerShell hangs on this machine`).toBe(false);
    expect(lines(r.stdout)).toEqual(['ready']);
  }, 200_000);

  it('keeps single and double quotes exactly as approved', async () => {
    const r = await runCommand({ shell: 'ps', command: `Write-Output 'a b'; Write-Output "c d"`, ...quick });
    // The message carries stderr so that a failure says why the output is empty (CI: empty after 30 s). stderr is not compared:
    // PowerShell writes its "preparing modules for first use" progress there.
    expect(r.timedOut, `timed out after ${r.durationMs} ms, exitCode ${String(r.exitCode)}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`).toBe(false);
    expect(lines(r.stdout)).toEqual(['a b', 'c d']);
  });

  it('evaluates the string as written, without a quoting layer in between', async () => {
    const r = await runCommand({ shell: 'ps', command: '$x = 2; $x * 3', ...quick });
    expect(lines(r.stdout)).toEqual(['6']);
  });

  it('accepts the ls alias (acceptance scenario)', async () => {
    const r = await runCommand({ shell: 'ps', command: 'ls', ...quick });
    expect(r.exitCode).toBe(0);
  });

  it('returns a failing exit code', async () => {
    expect((await runCommand({ shell: 'ps', command: 'exit 7', ...quick })).exitCode).toBe(7);
  });

  it('documents that a failing native command gives 1, not its own exit code, unless the string calls exit', async () => {
    // PowerShell -Command semantics: 0 when the last command succeeded, 1 when it failed. The approved string is never
    // wrapped by us (T-15), so a policy entry that needs the native code must say so: `cmd /c exit 5; exit $LASTEXITCODE`.
    expect((await runCommand({ shell: 'ps', command: 'cmd /c exit 5', ...quick })).exitCode).toBe(1);
    expect((await runCommand({ shell: 'ps', command: 'cmd /c exit 5; exit $LASTEXITCODE', ...quick })).exitCode).toBe(5);
  });

  it('does not report valid UTF-8 as non-UTF-8 when the output cap cuts a character in two', async () => {
    const r = await runCommand({
      shell: 'ps',
      command: '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::Out.Write(([string][char]0xE9) * 10)',
      timeoutMs: 30_000,
      maxOutputBytes: 5,
    });
    expect(r.truncated).toBe(true);
    expect(r.outputNotUtf8).toBe(false);
  });

  it('decodes PowerShell output written in the OEM page (its default console encoding)', async () => {
    const page = await detectOemCodePage(process.env);
    expect(page, 'the OEM code page of this machine could not be read from the registry').toBeDefined();
    const r = await runCommand({
      shell: 'ps',
      command: `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(${String(page)}); [Console]::Out.Write([char]0xE9)`,
      ...quick,
    });
    expect(r.stdout).toBe(String.fromCharCode(0xe9));
    expect(r.outputNotUtf8).toBe(false);
    expect(r.decodedFrom).toBe(`cp${String(page)}`);
  });

  it('does not pass secrets of the daemon environment to the command', async () => {
    process.env.MACHINE_TEST_SECRET = 'leaked-value';
    try {
      const r = await runCommand({ shell: 'ps', command: 'Write-Output "[$env:MACHINE_TEST_SECRET]"', ...quick });
      expect(lines(r.stdout)).toEqual(['[]']);
    } finally {
      delete process.env.MACHINE_TEST_SECRET;
    }
  });
});

describe.runIf(onUnix)('real sh and bash', () => {
  it('keeps quotes exactly as approved', async () => {
    const r = await runCommand({ shell: 'sh', command: `echo 'a b' "c d"`, ...quick });
    expect(lines(r.stdout)).toEqual(['a b c d']);
  });

  it('returns the exit code and stderr', async () => {
    const r = await runCommand({ shell: 'bash', command: 'echo oops >&2; exit 4', ...quick });
    expect(r.exitCode).toBe(4);
    expect(lines(r.stderr)).toEqual(['oops']);
  });

  it('does not pass secrets of the daemon environment to the command', async () => {
    process.env.MACHINE_TEST_SECRET = 'leaked-value';
    try {
      const r = await runCommand({ shell: 'sh', command: 'echo "[$MACHINE_TEST_SECRET]"', ...quick });
      expect(lines(r.stdout)).toEqual(['[]']);
    } finally {
      delete process.env.MACHINE_TEST_SECRET;
    }
  });

  it('kills the whole process group on timeout', async () => {
    const r = await runCommand({ shell: 'sh', command: 'sleep 30 & sleep 30', timeoutMs: 700, maxOutputBytes: 10_000 });
    expect(r.timedOut).toBe(true);
  });
});

describe('runCommand on any platform', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SystemRoot;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  });

  it('rejects, naming the cause, a command it must never launch', async () => {
    await expect(runCommand({ shell: onWindows ? 'cmd' : 'sh', command: 'echo a\necho b', ...quick })).rejects.toThrow(/printable ASCII/);
  });

  it('rejects a shell that does not exist on this platform', async () => {
    await expect(runCommand({ shell: onWindows ? 'bash' : 'cmd', command: 'echo a', ...quick })).rejects.toThrow(/(not supported on Windows|only exists on Windows)/);
  });

  it('reports a decoding problem instead of hiding it', async () => {
    // Output that is not UTF-8 and cannot be decoded must be flagged, never silently garbled. Emits the single byte 0xE9, which is
    // not valid UTF-8. On Windows the page of the machine is declared unknown here: with a real one the byte is a letter of that page
    // (0xE9 is U acute in cp850), see "real cmd, output in the OEM code page" for the decoded case.
    const request: Pick<RunOptions, 'shell' | 'command'> = onWindows
      ? { shell: 'ps', command: '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(1252); [Console]::Out.Write([char]0xE9)' }
      : { shell: 'sh', command: "printf '\\351'" };
    const r = await runCommand({ ...request, ...quick, oemCodePage: async () => undefined });
    expect(r.outputNotUtf8).toBe(true);
    expect(r.decodedFrom).toBeUndefined();
  });
});
