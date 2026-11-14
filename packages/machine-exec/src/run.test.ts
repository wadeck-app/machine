import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe.runIf(onWindows)('real PowerShell', () => {
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
    // Output that is not UTF-8 (OEM code pages on Windows) must be flagged, never silently garbled.
    // Emits the single byte 0xE9, which is not valid UTF-8.
    const request: Pick<RunOptions, 'shell' | 'command'> = onWindows
      ? { shell: 'ps', command: '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(1252); [Console]::Out.Write([char]0xE9)' }
      : { shell: 'sh', command: "printf '\\351'" };
    const r = await runCommand({ ...request, ...quick });
    expect(r.outputNotUtf8).toBe(true);
  });
});
