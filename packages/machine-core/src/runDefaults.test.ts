import { describe, expect, it } from 'vitest';
import { DEFAULT_ON_REFUSAL, DEFAULT_WAIT_SECONDS, defaultWaitNotice, describeRunWait, holdLimitAdvice, notHeldWarning, parseRunDefaults, resolveRunWait, serializeRunDefaults } from './runDefaults.js';

// `machine run`: what to do when the target does not allow the command yet. Flags over the machine setting (run-defaults.json) over the built-in default.

describe('built-in default', () => {
  it('is to wait 10 minutes', () => {
    expect(DEFAULT_ON_REFUSAL).toBe('wait');
    expect(DEFAULT_WAIT_SECONDS).toBe(600);
  });
});

describe('resolveRunWait: precedence table', () => {
  const W = (seconds: number, onRefusalSource: string, secondsSource: string) => ({ onRefusal: 'wait', seconds, onRefusalSource, secondsSource });
  const F = (onRefusalSource: string) => ({ onRefusal: 'fail', onRefusalSource });

  it.each([
    ['nothing at all: built-in', {}, undefined, W(600, 'built-in', 'built-in')],
    ['setting wait with a duration', {}, { v: 1, onRefusal: 'wait', waitSeconds: 120 }, W(120, 'setting', 'setting')],
    ['setting duration alone keeps the built-in mode', {}, { v: 1, waitSeconds: 120 }, W(120, 'built-in', 'setting')],
    ['setting fail', {}, { v: 1, onRefusal: 'fail' }, F('setting')],
    ['setting fail with a stored duration', {}, { v: 1, onRefusal: 'fail', waitSeconds: 120 }, F('setting')],
    ['setting wait without a duration: built-in duration', {}, { v: 1, onRefusal: 'wait' }, W(600, 'setting', 'built-in')],
    ['--no-wait over the built-in', { noWait: true }, undefined, F('flag')],
    ['--no-wait over a setting wait', { noWait: true }, { v: 1, onRefusal: 'wait', waitSeconds: 120 }, F('flag')],
    ['--no-wait with --on-refusal fail (redundant, not contradictory)', { noWait: true, onRefusal: 'fail' }, undefined, F('flag')],
    ['--on-refusal fail over a setting wait', { onRefusal: 'fail' }, { v: 1, onRefusal: 'wait' }, F('flag')],
    ['--on-refusal wait over a setting fail: setting duration still applies', { onRefusal: 'wait' }, { v: 1, onRefusal: 'fail', waitSeconds: 120 }, W(120, 'flag', 'setting')],
    ['--on-refusal wait alone over the built-in', { onRefusal: 'wait' }, undefined, W(600, 'flag', 'built-in')],
    ['--wait over the built-in implies wait', { wait: '5m' }, undefined, W(300, 'flag', 'flag')],
    ['--wait over a setting fail implies wait', { wait: '30s' }, { v: 1, onRefusal: 'fail' }, W(30, 'flag', 'flag')],
    ['--wait over a setting duration', { wait: '1h' }, { v: 1, onRefusal: 'wait', waitSeconds: 120 }, W(3600, 'flag', 'flag')],
    ['--on-refusal wait with --wait (no conflict)', { onRefusal: 'wait', wait: '90s' }, undefined, W(90, 'flag', 'flag')],
  ])('%s', (_name, flags, setting, expected) => {
    expect(resolveRunWait(flags as never, setting as never)).toEqual(expected);
  });

  it.each([
    ['--no-wait with --wait', { noWait: true, wait: '5m' }, /--no-wait.*--wait.*(remove|drop|use)/s],
    ['--on-refusal fail with --wait', { onRefusal: 'fail', wait: '5m' }, /--on-refusal fail.*--wait/s],
    ['--no-wait with --on-refusal wait', { noWait: true, onRefusal: 'wait' }, /--no-wait.*--on-refusal wait/s],
    ['an unknown --on-refusal value', { onRefusal: 'retry' }, /--on-refusal "retry".*wait.*fail/s],
    ['an empty --on-refusal value', { onRefusal: '' }, /--on-refusal/],
    ['a --wait without unit', { wait: '10' }, /--wait 10 has no unit/],
    ['a --wait out of range', { wait: '5s' }, /outside/],
  ])('refuses %s loudly with the fix', (_name, flags, message) => {
    expect(() => resolveRunWait(flags as never, undefined)).toThrow(message);
  });

  it('a conflict is refused even when the setting would have decided', () => {
    expect(() => resolveRunWait({ noWait: true, wait: '5m' } as never, { v: 1, onRefusal: 'fail' })).toThrow(/--no-wait/);
  });
});

describe('parseRunDefaults: a damaged setting is an error, never a fallback', () => {
  it('accepts an empty document and every field', () => {
    expect(parseRunDefaults({ v: 1 })).toEqual({ v: 1 });
    expect(parseRunDefaults({ v: 1, onRefusal: 'fail', waitSeconds: 10 })).toEqual({ v: 1, onRefusal: 'fail', waitSeconds: 10 });
    expect(parseRunDefaults({ v: 1, onRefusal: 'wait', waitSeconds: 3600 })).toEqual({ v: 1, onRefusal: 'wait', waitSeconds: 3600 });
  });

  it.each([
    ['not an object', 'x', /not an object/],
    ['an array', [], /not an object/],
    ['null', null, /not an object/],
    ['no version', { onRefusal: 'wait' }, /"v"/],
    ['another version', { v: 2 }, /"v"/],
    ['an unknown field', { v: 1, nope: 1 }, /unknown field "nope"/],
    ['a bad onRefusal', { v: 1, onRefusal: 'retry' }, /"onRefusal".*wait.*fail/s],
    ['a waitSeconds that is text', { v: 1, waitSeconds: '600' }, /"waitSeconds"/],
    ['a waitSeconds that is fractional', { v: 1, waitSeconds: 10.5 }, /"waitSeconds"/],
    ['a waitSeconds under 10', { v: 1, waitSeconds: 9 }, /"waitSeconds".*10 s to 60 min/s],
    ['a waitSeconds over 60 min', { v: 1, waitSeconds: 3601 }, /"waitSeconds".*10 s to 60 min/s],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => parseRunDefaults(raw)).toThrow(message);
  });

  it('serializes to a document that parses back', () => {
    const text = serializeRunDefaults({ v: 1, onRefusal: 'fail', waitSeconds: 900 });
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRunDefaults(JSON.parse(text))).toEqual({ v: 1, onRefusal: 'fail', waitSeconds: 900 });
  });
});

describe('texts', () => {
  it('the default notice says it once, with the way out', () => {
    const wait = resolveRunWait({}, undefined);
    expect(defaultWaitNotice('thinkcentre', wait)).toBe('waiting up to 10m for thinkcentre to allow it (default; --no-wait to fail at once)');
  });

  it('the setting notice names the setting', () => {
    const wait = resolveRunWait({}, { v: 1, waitSeconds: 90 });
    expect(defaultWaitNotice('thinkcentre', wait)).toBe('waiting up to 90s for thinkcentre to allow it (setting run-defaults; --no-wait to fail at once)');
    const onRefusal = resolveRunWait({}, { v: 1, onRefusal: 'wait' });
    expect(defaultWaitNotice('thinkcentre', onRefusal)).toBe('waiting up to 10m for thinkcentre to allow it (setting run-defaults; --no-wait to fail at once)');
  });

  it('no notice when the command line asked for the wait or for failing', () => {
    expect(defaultWaitNotice('x', resolveRunWait({ wait: '5m' }, undefined))).toBeUndefined();
    expect(defaultWaitNotice('x', resolveRunWait({ onRefusal: 'wait' }, undefined))).toBeUndefined();
    expect(defaultWaitNotice('x', resolveRunWait({ noWait: true }, undefined))).toBeUndefined();
    expect(defaultWaitNotice('x', resolveRunWait({}, { v: 1, onRefusal: 'fail' }))).toBeUndefined();
  });

  it('describes the effective value and where it comes from', () => {
    expect(describeRunWait(resolveRunWait({}, undefined))).toEqual({ onRefusal: 'wait (built-in default)', wait: '10m (built-in default)' });
    expect(describeRunWait(resolveRunWait({}, { v: 1, onRefusal: 'fail' }))).toEqual({ onRefusal: 'fail (setting run-defaults)' });
    expect(describeRunWait(resolveRunWait({ wait: '5m' }, { v: 1, waitSeconds: 120 }))).toEqual({ onRefusal: 'wait (flag)', wait: '5m (flag)' });
  });
});

describe('caller messages that depend on the wait in effect', () => {
  it('older target: names where the wait came from and how to stop asking', () => {
    const byDefault = notHeldWarning('thinkcentre', resolveRunWait({}, undefined));
    expect(byDefault).toMatch(/thinkcentre did not hold the request/);
    expect(byDefault).toMatch(/by default/);
    expect(byDefault).toMatch(/machine cli update/);
    expect(byDefault).toMatch(/--no-wait/);
    expect(byDefault).toMatch(/machine run-defaults --on-refusal fail/);
    expect(notHeldWarning('x', resolveRunWait({}, { v: 1, onRefusal: 'wait' }))).toMatch(/setting run-defaults/);
    const typed = notHeldWarning('x', resolveRunWait({ wait: '5m' }, undefined));
    expect(typed).toMatch(/--wait was given/);
    expect(typed).not.toMatch(/machine run-defaults/);
  });

  it('hold limits: what to do, in the words of the cause', () => {
    const peer = holdLimitAdvice('hold-limit-peer', 'thinkcentre');
    expect(peer).toMatch(/wait for the owner of thinkcentre to answer the pending ones/);
    expect(peer).toMatch(/machine requests/);
    expect(peer).toMatch(/--no-wait/);
    expect(holdLimitAdvice('hold-limit-machine', 'thinkcentre')).toMatch(/--no-wait/);
    expect(holdLimitAdvice('not-listed', 'thinkcentre')).toBeUndefined();
  });
});
