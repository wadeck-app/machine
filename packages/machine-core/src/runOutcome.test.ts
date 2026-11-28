import { describe, expect, it } from 'vitest';
import { RUN_CODES, classifyRunFailure, failureDocument, malformedInputAdvice, refusalDocument, resultDocument } from './runOutcome.js';

// `machine run --json`: EVERY outcome is exactly one JSON document (decision 114, D5). The `code` strings are a contract: stable, never renamed once released.

describe('the codes are a closed, stable list', () => {
  it('names exactly these strings (a rename or a removal is a breaking change: extend this list, never edit it)', () => {
    expect([...RUN_CODES]).toEqual([
      'ok',
      'refused:not-allowed',
      'refused:input-not-allowed',
      'refused:input-too-large',
      'refused:input-chars',
      'refused:input-format',
      'refused:other',
      'unreachable',
      'timeout',
      'denied',
      'target-too-old',
      'unknown-machine',
      'usage',
      'failed',
    ]);
  });
});

describe('resultDocument: the answer of the peer, plus code and message', () => {
  const answer = { type: 'result' as const, id: 'i', exitCode: 3, stdout: 'o', stderr: 'e', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 5 };
  it('a command that ran is `ok`, whatever its exit code (the raw code stays in exitCode)', () => {
    expect(resultDocument(answer)).toEqual({ ...answer, code: 'ok', message: 'the command ran and exited with code 3' });
  });
  it('a command stopped by the time limit of the peer is `timeout`, exitCode null', () => {
    const d = resultDocument({ ...answer, exitCode: null, timedOut: true });
    expect(d).toMatchObject({ code: 'timeout', exitCode: null, timedOut: true });
    expect(d.message).toMatch(/time limit/);
  });
  it('a command cut by the output cap stays `ok` with truncated true', () => {
    expect(resultDocument({ ...answer, exitCode: null, truncated: true })).toMatchObject({ code: 'ok', truncated: true, exitCode: null });
  });
  it('keeps decodedFrom only when the peer sent it', () => {
    expect(resultDocument({ ...answer, decodedFrom: 'cp850' })).toMatchObject({ decodedFrom: 'cp850' });
    expect('decodedFrom' in resultDocument(answer)).toBe(false);
  });
});

describe('refusalDocument: what the target refused, by stable code', () => {
  const base = { id: 'i', message: 'm' };
  it.each([
    ['not-listed', 'refused:not-allowed'],
    ['no-policy', 'refused:not-allowed'],
    ['expired', 'refused:not-allowed'],
    ['exhausted', 'refused:not-allowed'],
    ['input-not-allowed', 'refused:input-not-allowed'],
    ['input-too-large', 'refused:input-too-large'],
    ['input-chars', 'refused:input-chars'],
    ['input-format', 'refused:input-format'],
    ['denied', 'denied'],
    ['busy', 'refused:other'],
    ['rate-limited', 'refused:other'],
    ['peer-revoked', 'refused:other'],
  ])('%s -> %s', (reason, code) => {
    expect(refusalDocument({ type: 'refused', reason, ...base }, 'human text', { sentInput: false })).toMatchObject({ type: 'refused', code, reason, message: 'human text', id: 'i' });
  });
  it('is the full failure shape: no exit code of a command, empty output, nothing timed out', () => {
    expect(refusalDocument({ type: 'refused', reason: 'not-listed', ...base }, 't', { sentInput: false })).toEqual({ type: 'refused', code: 'refused:not-allowed', message: 't', id: 'i', reason: 'not-listed', exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false });
  });
  it('a target that refuses the SIGNED BODY as malformed when an input was sent is too old for stdin (fail closed)', () => {
    expect(refusalDocument({ type: 'refused', reason: 'malformed', message: 'm' }, 't', { sentInput: true })).toMatchObject({ code: 'target-too-old' });
    expect(refusalDocument({ type: 'refused', reason: 'malformed', message: 'm' }, 't', { sentInput: false })).toMatchObject({ code: 'refused:other' });
  });
  it('without an id the key is absent', () => {
    expect('id' in refusalDocument({ type: 'refused', reason: 'busy', message: 'm' }, 't', { sentInput: false })).toBe(false);
  });
});

describe('failureDocument: no answer from a command', () => {
  it('has the shape of every other failure', () => {
    expect(failureDocument('unreachable', 'no connection')).toEqual({ type: 'error', code: 'unreachable', message: 'no connection', exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false });
  });
});

describe('classifyRunFailure: a thrown error to a code', () => {
  it.each([
    ['no answer from the peer within 90000 ms: it may be busy', 'timeout'],
    ['"laptop" is unreachable (no route)', 'unreachable'],
    ['could not connect to laptop at 1.2.3.4:5: timed out', 'unreachable'],
    ['connection closed', 'failed'],
    ['something else entirely', 'failed'],
  ])('%s -> %s', (message, code) => {
    expect(classifyRunFailure({ message, unreachable: message.includes('unreachable') || message.startsWith('could not connect') })).toBe(code);
  });
});

describe('L2: the document is built from a whitelist, never from the spread of the peer answer', () => {
  const answer = { type: 'result' as const, id: 'i', exitCode: 0, stdout: 'o', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 5 };
  it('a hostile answer cannot add, override or smuggle a key', () => {
    const hostile = { ...answer, code: 'refused:other', message: 'forged', evil: 'x', __extra: { a: 1 }, reason: 'busy' } as unknown as typeof answer;
    const d = resultDocument(hostile);
    expect(Object.keys(d).sort()).toEqual(['code', 'durationMs', 'exitCode', 'id', 'message', 'outputNotUtf8', 'stderr', 'stdout', 'timedOut', 'truncated', 'type']);
    expect(d.code).toBe('ok');
    expect(d.message).toBe('the command ran and exited with code 0');
  });
  it('decodedFrom stays when present', () => {
    expect(Object.keys(resultDocument({ ...answer, decodedFrom: 'cp850' }))).toContain('decodedFrom');
  });
});

describe('L1: malformed with a sent input is ambiguous, and says so', () => {
  it('the advice names both causes and the fix', () => {
    const t = malformedInputAdvice('think');
    expect(t).toContain('malformed: the target is older than this feature or the request is damaged');
    expect(t).toContain('machine cli update');
    expect(t).toContain('think');
  });
});
