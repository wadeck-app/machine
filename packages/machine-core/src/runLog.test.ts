import { describe, expect, it } from 'vitest';
import { RUN_LOG_MAX_COMMAND, RUN_LOG_MAX_LINE, buildRunLogLine, outcomeOfAnswer, outcomeOfFailure, parseRunLogLine, parseRunLogLines, waitModeOf, type RunLogEntry, type RunLogInput } from './runLog.js';

// The OUTGOING run log (run-log.md): one JSON line per `machine run`, written by the machine that sends it. Pure: it builds and reads lines, no file.

const SELF = { name: 'laptop', uuid: '11111111-1111-4111-8111-111111111111' };
const PEER = { name: 'desk', uuid: '22222222-2222-4222-8222-222222222222' };

function input(over: Partial<RunLogInput> = {}): RunLogInput {
  return {
    now: Date.parse('2026-11-21T10:00:00.000Z'),
    runId: '33333333-3333-4333-8333-333333333333',
    from: SELF,
    to: PEER,
    shell: 'sh',
    command: 'ls -l',
    waitMode: 'default',
    onRefusal: 'wait',
    waitSeconds: 600,
    waitedSeconds: 0,
    outcome: { outcome: 'ran', exitCode: 0 },
    durationMs: 1200,
    ...over,
  };
}

describe('buildRunLogLine', () => {
  it('is one JSON line ending with a newline, in a fixed field order, with an ISO UTC time', () => {
    const line = buildRunLogLine(input());
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    const parsed = JSON.parse(line) as RunLogEntry;
    expect(parsed).toMatchObject({ v: 1, ts: '2026-11-21T10:00:00.000Z', runId: input().runId, from: SELF, to: PEER, shell: 'sh', command: 'ls -l', truncated: false, waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: 'ran', exitCode: 0, durationMs: 1200 });
  });

  it('keeps the command as typed: quotes, accents and control characters survive a round trip (JSON escapes them)', () => {
    const command = 'echo "café" \'x\'\tend';
    const read = parseRunLogLines(buildRunLogLine(input({ command })));
    expect(read.damaged).toBe(0);
    expect(read.entries[0]?.command).toBe(command);
  });

  it('cuts a command longer than 2048 characters and flags it', () => {
    const entry = JSON.parse(buildRunLogLine(input({ command: 'a'.repeat(RUN_LOG_MAX_COMMAND + 500) }))) as { command: string; truncated: boolean };
    expect(entry.command.length).toBe(RUN_LOG_MAX_COMMAND);
    expect(entry.truncated).toBe(true);
  });

  it('never exceeds 4 KiB, even when every character needs a JSON escape: the command is cut further and flagged', () => {
    const line = buildRunLogLine(input({ command: '\u0001'.repeat(RUN_LOG_MAX_COMMAND) }));
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(RUN_LOG_MAX_LINE);
    expect((JSON.parse(line) as { truncated: boolean }).truncated).toBe(true);
  });

  it('never exceeds 4 KiB with multi-byte characters', () => {
    const line = buildRunLogLine(input({ command: '€'.repeat(RUN_LOG_MAX_COMMAND), outcome: { outcome: 'error', cause: 'x'.repeat(5000) } }));
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(RUN_LOG_MAX_LINE);
  });

  it('bounds the cause and reduces it to printable ASCII (a message cannot forge a line or drive a terminal)', () => {
    const entry = JSON.parse(buildRunLogLine(input({ outcome: { outcome: 'error', cause: `bad\n{"fake":1}\u001b[31m ${'y'.repeat(1000)}` } }))) as { cause: string };
    expect(entry.cause).not.toMatch(/[\n\u001b]/);
    expect(entry.cause.length).toBeLessThanOrEqual(300);
  });

  it('records no field that could hold a secret: only the listed keys are written', () => {
    const allowed = ['v', 'ts', 'runId', 'from', 'to', 'shell', 'command', 'truncated', 'waitMode', 'onRefusal', 'waitSeconds', 'waitedSeconds', 'outcome', 'exitCode', 'timedOut', 'reason', 'cause', 'durationMs', 'execMs'];
    const sneaky = { ...input(), env: { TOKEN: 'secret' }, passphrase: 'p', stdout: 'out' } as unknown as RunLogInput;
    const entry = JSON.parse(buildRunLogLine(sneaky)) as RunLogEntry;
    expect(Object.keys(entry).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(JSON.stringify(entry)).not.toMatch(/secret|passphrase|out"/);
  });

  it('refuses an empty run id, machine or outcome loudly', () => {
    expect(() => buildRunLogLine(input({ runId: '' }))).toThrow(/runId/);
    expect(() => buildRunLogLine(input({ to: { name: 'desk', uuid: '' } }))).toThrow(/uuid/);
  });
});

describe('outcomes', () => {
  it('a result is `ran` with its exit code (null when the command was killed) and the time-out flag', () => {
    expect(outcomeOfAnswer({ type: 'result', exitCode: 3, timedOut: false })).toEqual({ outcome: 'ran', exitCode: 3 });
    expect(outcomeOfAnswer({ type: 'result', exitCode: null, timedOut: true })).toEqual({ outcome: 'ran', exitCode: null, timedOut: true });
  });

  it('a refusal keeps its reason; an owner Deny is `denied`; a hold that ended unanswered is `deadline`', () => {
    expect(outcomeOfAnswer({ type: 'refused', reason: 'not-listed' })).toEqual({ outcome: 'refused', reason: 'not-listed' });
    expect(outcomeOfAnswer({ type: 'refused', reason: 'denied', held: { waitSeconds: 60 } })).toEqual({ outcome: 'denied', reason: 'denied' });
    // The owner text rides along as the cause; the fixed no-reason sentence is not a cause.
    expect(outcomeOfAnswer({ type: 'refused', reason: 'denied', message: 'not today' })).toEqual({ outcome: 'denied', reason: 'denied', cause: 'not today' });
    expect(outcomeOfAnswer({ type: 'refused', reason: 'denied', message: 'denied by the owner, no reason given' })).toEqual({ outcome: 'denied', reason: 'denied' });
    expect(outcomeOfAnswer({ type: 'refused', reason: 'not-listed', held: { waitSeconds: 60 } })).toEqual({ outcome: 'deadline', reason: 'not-listed' });
    expect(outcomeOfAnswer({ type: 'refused', reason: 'no-policy', held: { waitSeconds: 60 } })).toEqual({ outcome: 'deadline', reason: 'no-policy' });
  });

  it('a refusal that is not about a missing allow entry stays `refused` even when it was held (revoked while waiting)', () => {
    expect(outcomeOfAnswer({ type: 'refused', reason: 'peer-revoked', held: { waitSeconds: 60 } })).toEqual({ outcome: 'refused', reason: 'peer-revoked' });
  });

  it('a thrown failure is classified: no answer = timeout, ended connection = connection-lost, anything else = error with its cause', () => {
    expect(outcomeOfFailure('no answer from the peer within 30000 ms: it may be busy or unreachable').outcome).toBe('timeout');
    expect(outcomeOfFailure('the connection ended while the request was waiting for approval (the target daemon may have restarted)').outcome).toBe('connection-lost');
    expect(outcomeOfFailure('connection closed').outcome).toBe('connection-lost');
    expect(outcomeOfFailure('cannot reach desk: all addresses failed')).toEqual({ outcome: 'error', cause: 'cannot reach desk: all addresses failed' });
  });
});

describe('waitModeOf', () => {
  it('names where the behaviour comes from: any flag, else the setting, else the built-in default', () => {
    expect(waitModeOf({ onRefusal: 'wait', seconds: 600, onRefusalSource: 'built-in', secondsSource: 'built-in' })).toBe('default');
    expect(waitModeOf({ onRefusal: 'wait', seconds: 60, onRefusalSource: 'built-in', secondsSource: 'flag' })).toBe('flag');
    expect(waitModeOf({ onRefusal: 'wait', seconds: 60, onRefusalSource: 'setting', secondsSource: 'built-in' })).toBe('setting');
    expect(waitModeOf({ onRefusal: 'fail', onRefusalSource: 'flag' })).toBe('flag');
    expect(waitModeOf({ onRefusal: 'fail', onRefusalSource: 'built-in' })).toBe('default');
  });
});

describe('parseRunLogLines', () => {
  const good = buildRunLogLine(input());

  it('reads good lines in order and counts a damaged one instead of crashing', () => {
    const second = buildRunLogLine(input({ runId: '44444444-4444-4444-8444-444444444444' }));
    const text = `${good}this is not json\n${second}{"v":1,"ts":"nope"}\n\n`;
    const read = parseRunLogLines(text);
    expect(read.entries.map((e) => e.runId)).toEqual([input().runId, '44444444-4444-4444-8444-444444444444']);
    expect(read.damaged).toBe(2);
  });

  it('counts a last line cut by a crash (no newline, half a JSON) as damaged', () => {
    const read = parseRunLogLines(`${good}${good.slice(0, 40)}`);
    expect(read.entries).toHaveLength(1);
    expect(read.damaged).toBe(1);
  });

  it('refuses an entry with the wrong shape (unknown outcome, non-numeric duration)', () => {
    const bad = JSON.parse(good) as RunLogEntry;
    expect(parseRunLogLines(`${JSON.stringify({ ...bad, outcome: 'weird' })}\n`).damaged).toBe(1);
    expect(parseRunLogLines(`${JSON.stringify({ ...bad, durationMs: 'x' })}\n`).damaged).toBe(1);
    expect(parseRunLogLines(`${JSON.stringify({ ...bad, from: 'laptop' })}\n`).damaged).toBe(1);
  });

  it('keeps execMs (the run time of the command on the target) apart from durationMs (the whole run, wait included)', () => {
    const line = buildRunLogLine(input({ durationMs: 107_300, waitedSeconds: 107, execMs: 312 }));
    expect(JSON.parse(line)).toMatchObject({ durationMs: 107_300, execMs: 312 });
    expect(parseRunLogLines(line).entries[0]).toMatchObject({ durationMs: 107_300, execMs: 312 });
  });

  it('writes no execMs when the command did not run, and reads an old line (no execMs) without a fuss', () => {
    expect('execMs' in JSON.parse(buildRunLogLine(input({ outcome: { outcome: 'refused', reason: 'denied' } })))).toBe(false);
    const old = JSON.parse(good) as RunLogEntry;
    const read = parseRunLogLines(`${JSON.stringify(old)}\n`);
    expect(read.damaged).toBe(0);
    expect(read.entries[0]?.execMs).toBeUndefined();
  });

  it('counts an execMs that is not a number of milliseconds as a damaged line', () => {
    const bad = JSON.parse(good) as RunLogEntry;
    expect(parseRunLogLines(`${JSON.stringify({ ...bad, execMs: 'fast' })}\n`).damaged).toBe(1);
    expect(parseRunLogLines(`${JSON.stringify({ ...bad, execMs: -5 })}\n`).damaged).toBe(1);
  });

  it('parses one line at a time: an entry, or damaged', () => {
    expect(parseRunLogLine(good.trimEnd())).toMatchObject({ runId: input().runId });
    expect(parseRunLogLine('{oops')).toBe('damaged');
  });

  it('ignores a line of a newer format version instead of misreading it', () => {
    const newer = JSON.parse(good) as RunLogEntry;
    expect(parseRunLogLines(`${JSON.stringify({ ...newer, v: 2 })}\n`)).toEqual({ entries: [], damaged: 1 });
  });
});
