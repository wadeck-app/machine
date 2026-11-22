import { entryFromText } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { buildAllowEntry, entryDescription, entryLine, leftOutLines, renewalLines, typedSummary } from './allowText.js';

const NOW = 1_800_000_000;

describe('entryDescription / entryLine: how an entry is shown', () => {
  it('an exact permanent entry is just its JSON text', () => {
    expect(entryDescription(entryFromText('ls', 'sh'), NOW)).toBe('"ls"');
    expect(entryLine(entryFromText('ls', 'sh'), NOW)).toBe('sh  "ls"');
  });
  it('a typed entry carries the tag "typed" and shows its template exactly as signed', () => {
    expect(entryDescription(entryFromText('orch logs <j:name> --tail <n:int(1,500)>', 'sh'), NOW)).toBe('"orch logs <j:name> --tail <n:int(1,500)>"  [typed]');
  });
  it('shows the lifetime: calls, calls left when the counter is known, until', () => {
    expect(entryDescription(entryFromText('ls', 'sh', { maxCalls: 5 }), NOW)).toBe('"ls"  (5 calls)');
    expect(entryDescription(entryFromText('ls', 'sh', { maxCalls: 5 }), NOW, 2)).toBe('"ls"  (3 of 5 calls left)');
    expect(entryDescription(entryFromText('ls', 'sh', { expiresAt: Date.UTC(2027, 1, 1, 18, 0, 0) / 1000 }), NOW)).toBe('"ls"  (until 2027-02-01T18:00:00Z)');
    expect(entryDescription(entryFromText('x <n:int(1,2)>', 'sh', { maxCalls: 1 }), NOW)).toBe('"x <n:int(1,2)>"  [typed]  (1 call)');
  });
  it('JSON-escapes the text so that nothing hides in it', () => {
    expect(entryDescription(entryFromText('echo "a b"', 'sh'), NOW)).toBe('"echo \\"a b\\""');
  });
});

describe('buildAllowEntry: the entry of a signing request', () => {
  it('builds exact, typed and limited entries', () => {
    expect(buildAllowEntry('ls', 'sh', {}, NOW)).toEqual({ shell: 'sh', command: 'ls' });
    expect(buildAllowEntry('x <n:int(1,2)>', 'sh', { times: '3' }, NOW)).toEqual({ shell: 'sh', template: 'x <n:int(1,2)>', limits: { maxCalls: 3 } });
    expect(buildAllowEntry('ls', 'sh', { for: '2h' }, NOW)).toEqual({ shell: 'sh', command: 'ls', limits: { expiresAt: NOW + 7200 } });
  });
  it('names the cause and the fix of a text that does not parse, and says nothing was signed', () => {
    expect(() => buildAllowEntry('orch logs <j', 'sh', {}, NOW)).toThrow(/complete placeholder.*Nothing was signed/s);
    expect(() => buildAllowEntry('echo a > out', 'sh', {}, NOW)).toThrow(/angle bracket.*Nothing was signed/s);
  });
  it('names the flag of a lifetime that does not parse', () => {
    expect(() => buildAllowEntry('ls', 'sh', { times: '0' }, NOW)).toThrow(/--times.*Nothing was signed/s);
  });
});

describe('typedSummary: what the owner reads before the passphrase (R10)', () => {
  const entry = buildAllowEntry('orch logs <job:name> --tail <n:int(1,500)>', 'sh', { times: '5' }, NOW);
  const text = typedSummary(entry, NOW).join('\n');
  it('names the template, each placeholder with what it accepts, the lifetime', () => {
    expect(text).toContain('orch logs <job:name> --tail <n:int(1,500)>');
    expect(text).toMatch(/job.*name/);
    expect(text).toMatch(/n.*whole number from 1 to 500/);
    expect(text).toMatch(/5 calls/);
  });
  it('gives two accepted and two refused examples produced by the validator, and says they are not a safeguard', () => {
    expect(text).toMatch(/accepted: orch logs job1 --tail 1\n/);
    expect(text).toMatch(/accepted: orch logs my-job --tail 500\n/);
    expect((text.match(/^\s+accepted: /gm) ?? []).length + (text.match(/^\s+refused: /gm) ?? []).length).toBe(4);
    expect(text).toMatch(/sanity check/);
  });
  it('says "permanent" for an entry without limits', () => {
    expect(typedSummary(buildAllowEntry('x <n:int(1,2)>', 'sh', {}, NOW), NOW).join('\n')).toMatch(/permanent/);
  });
  it('has nothing to say about an exact entry', () => {
    expect(typedSummary(buildAllowEntry('ls', 'sh', {}, NOW), NOW)).toEqual([]);
  });
});

describe('renewalLines and leftOutLines', () => {
  it('says "limits updated" with the old and the new lifetime', () => {
    const before = entryFromText('ls', 'sh', { maxCalls: 2 });
    const after = entryFromText('ls', 'sh');
    expect(renewalLines([{ before, after }], NOW).join('\n')).toMatch(/limits updated.*"ls".*2 calls.*permanent/s);
  });
  it('lists the default entries that were not copied, and says the peer loses them', () => {
    const left = [entryFromText('uptime', 'sh', { maxCalls: 3 })];
    const out = leftOutLines(left, 'desktop', NOW).join('\n');
    expect(out).toMatch(/\[warn\]/);
    expect(out).toMatch(/desktop.*loses/);
    expect(out).toContain('"uptime"');
    expect(out).toMatch(/3 calls/);
  });
  it('nothing left out, nothing said', () => {
    expect(leftOutLines([], 'desktop', NOW)).toEqual([]);
    expect(renewalLines([], NOW)).toEqual([]);
  });
});

describe('renewalLines of a renewal (limits.renewals)', () => {
  it('says "renews" with the old and the new lifetime and that the counter starts again', () => {
    const before = entryFromText('ls', 'sh', { maxCalls: 1 });
    const after = entryFromText('ls', 'sh', { maxCalls: 1, renewals: 1 } as never);
    expect(renewalLines([{ before, after }], NOW).join('\n')).toBe('  ~ renews "ls": 1 call -> 1 call (the counter starts again)');
  });
});
