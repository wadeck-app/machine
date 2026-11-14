import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, appendAudit, verifyAuditChain } from './audit.js';

function chain(n: number): { lines: string[]; last: string } {
  const lines: string[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const r = appendAudit({ prevHash: prev, seq: i, entry: { event: 'accepted', n: i, command: `echo ${i}` } });
    lines.push(r.line);
    prev = r.hash;
  }
  return { lines, last: prev };
}

describe('audit chain', () => {
  it('verifies an intact chain and returns the last hash to anchor elsewhere', () => {
    const { lines, last } = chain(3);
    expect(verifyAuditChain(lines)).toEqual({ ok: true, entries: 3, lastHash: last });
  });

  it('verifies an empty log', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, entries: 0, lastHash: GENESIS_HASH });
  });

  it('detects an edited entry and names its line', () => {
    const { lines } = chain(3);
    lines[1] = (lines[1] as string).replace('echo 1', 'echo EVIL');
    expect(verifyAuditChain(lines)).toMatchObject({ ok: false, line: 2 });
  });

  it('detects a deleted entry', () => {
    const { lines } = chain(4);
    lines.splice(1, 1);
    expect(verifyAuditChain(lines)).toMatchObject({ ok: false, line: 2 });
  });

  it('detects reordered entries', () => {
    const { lines } = chain(3);
    [lines[1], lines[2]] = [lines[2] as string, lines[1] as string];
    expect(verifyAuditChain(lines)).toMatchObject({ ok: false });
  });

  it('detects a rewritten hash that was recomputed without the previous link', () => {
    const { lines } = chain(3);
    const forged = appendAudit({ prevHash: GENESIS_HASH, seq: 1, entry: { event: 'accepted', n: 1, command: 'echo forged' } });
    lines[1] = forged.line;
    expect(verifyAuditChain(lines)).toMatchObject({ ok: false });
  });

  it('names the line of a malformed entry without echoing its content', () => {
    const { lines } = chain(2);
    lines.push('{not json with secret-looking-text');
    const r = verifyAuditChain(lines);
    expect(r).toMatchObject({ ok: false, line: 3 });
    if (!r.ok) expect(r.message).not.toContain('secret-looking-text');
  });

  it('refuses an entry that cannot be serialized canonically', () => {
    expect(() => appendAudit({ prevHash: GENESIS_HASH, seq: 0, entry: { event: undefined as never } })).toThrow();
  });
});
