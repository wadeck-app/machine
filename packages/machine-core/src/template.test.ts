import { describe, expect, it } from 'vitest';
import { TemplateError } from './typedParams.js';
import { canonicalEntry, hasAngleBracket, looksLikePlaceholder, matchTemplate, parseEntryText, parseTemplate, templateExamples, MAX_PLACEHOLDERS, MAX_TEXT } from './template.js';

const tpl = (text: string, shell: 'cmd' | 'ps' | 'bash' | 'sh' = 'sh') => parseTemplate(text, shell);
const matches = (template: string, command: string, platform: 'windows' | 'posix' = 'posix', shell: 'cmd' | 'ps' | 'bash' | 'sh' = 'sh'): boolean => matchTemplate(tpl(template, shell), command, platform).ok;

describe('parseTemplate: the entry grammar', () => {
  it.each([
    'orch logs <job:name> --tail <n:int(1,500)>',
    'journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager',
    'task show <id:hexid(8)> --json',
    'ping <p:port>',
    'sleep <d:duration(1,3600)>',
    'x <a:uuid> <b:name(dot)>',
  ])('accepts %s and keeps the text as signed', (text) => {
    const t = tpl(text);
    expect(t.text).toBe(text);
    expect(t.placeholders).toBeGreaterThan(0);
  });

  it('knows the token kinds: fixed words, whole-token placeholders, flag prefix plus placeholder', () => {
    const t = tpl('journalctl -u <u:enum(a|b)> --lines=<n:int(1,5)>');
    expect(t.tokens.map((k) => k.kind)).toEqual(['word', 'word', 'placeholder', 'placeholder']);
    expect(t.tokens[3]).toMatchObject({ kind: 'placeholder', prefix: '--lines=', label: 'n' });
    expect(t.tokens[2]).toMatchObject({ kind: 'placeholder', label: 'u' });
    expect((t.tokens[2] as { prefix?: string }).prefix).toBeUndefined();
  });

  it.each([
    ['orch logs <x', 'complete placeholder'],
    ['orch logs x>', 'complete placeholder'],
    ['orch logs <>', 'label'],
    ['orch logs <:int(1,2)>', 'label'],
    ['orch logs <a:b:c>', 'unknown type'],
    ['orch logs <a:int(1,2>', 'closing parenthesis'],
    ['orch logs <n:int(5,1)>', 'min'],
    ['orch logs <n:frob>', 'unknown type'],
    ['orch logs <n:int>', 'bounds'],
    ['orch logs <1a:int(1,2)>', 'label'],
    ['orch logs <a-b:int(1,2)>', 'label'],
    ['orch logs <n:int(1,2)>x', 'complete placeholder'],
    ['orch logs x<n:int(1,2)>', 'complete placeholder'],
    ['orch logs --a=b=<n:int(1,2)>', 'complete placeholder'],
    ['orch logs <<n:int(1,2)>>', 'complete placeholder'],
    ['orch logs <n:int(1,2)><m:int(1,2)>', 'complete placeholder'],
    ['orch logs <n: int(1,2)>', 'complete placeholder'],
    ['orch  logs <n:int(1,2)>', 'empty'],
    [' orch logs <n:int(1,2)>', 'empty'],
    ['orch logs <n:int(1,2)> ', 'empty'],
    ['<p:name> logs', 'program'],
    ['--x=<p:name> logs', 'program'],
    ['orch <f:enum(--force|b)>', 'start'],
    ['orch <f:enum(a;b)>', 'complete placeholder'],
    ['orch <f:enum(a/b)>', 'member'],
    ['orch logs --tail= <n:int(1,2)>', 'fixed word'],
    ['orch lo"gs <n:int(1,2)>', 'fixed word'],
    ['orch logs $x <n:int(1,2)>', 'fixed word'],
    ['orch 100% <n:int(1,2)>', 'fixed word'],
    ['orch a=b <n:int(1,2)>', 'fixed word'],
    ['orch <n:path(root=/x)>', 'phase 2'],
  ])('refuses %j (%s)', (text, hint) => {
    expect(() => tpl(text)).toThrow(TemplateError);
    expect(() => tpl(text)).toThrow(new RegExp(hint, 'i'));
  });

  it('refuses a template without a placeholder: that is an exact entry', () => {
    expect(() => tpl('orch logs')).toThrow(/no placeholder/);
  });

  it('refuses a non-ASCII character or a control character in a fixed word (whitelist of fixed words)', () => {
    expect(() => tpl('orch l\u00f6gs <n:int(1,2)>')).toThrow(/fixed word/);
    expect(() => tpl('orch lo\tgs <n:int(1,2)>')).toThrow(/fixed word/);
    expect(() => tpl('orch lo\u0000gs <n:int(1,2)>')).toThrow(/fixed word/);
  });

  it('an entry for the ps shell has no @ in its fixed words or enum members', () => {
    expect(() => tpl('Get-Foo @x <n:int(1,2)>', 'ps')).toThrow(/@/);
    expect(() => tpl('Get-Foo <n:enum(a@b|c)>', 'ps')).toThrow(/@/);
    expect(tpl('Get-Foo @x <n:int(1,2)>', 'bash').placeholders).toBe(1);
  });

  it(`refuses more than ${MAX_PLACEHOLDERS} placeholders`, () => {
    const many = (n: number) => `x ${Array.from({ length: n }, (_, i) => `<p${i}:int(1,2)>`).join(' ')}`;
    expect(tpl(many(MAX_PLACEHOLDERS)).placeholders).toBe(MAX_PLACEHOLDERS);
    expect(() => tpl(many(MAX_PLACEHOLDERS + 1))).toThrow(/at most 8 placeholders/);
  });

  it(`refuses a text above ${MAX_TEXT} characters and a final command line that could exceed it`, () => {
    expect(() => tpl(`${'a'.repeat(MAX_TEXT)} <n:int(1,2)>`)).toThrow(/2048/);
    const words = Array.from({ length: 27 }, () => 'a'.repeat(70)).join(' ');
    // 27 words of 70 plus 8 placeholders of at most 64 characters: the text is short, the final line is not.
    const text = `${words} ${Array.from({ length: 8 }, (_, i) => `<p${i}:name>`).join(' ')}`;
    expect(text.length).toBeLessThan(MAX_TEXT);
    expect(() => tpl(text)).toThrow(/final command line.*2048/);
  });
});

describe('parseEntryText: exact or typed', () => {
  it('a text without angle brackets is an exact entry, byte for byte', () => {
    expect(parseEntryText('dir "C:\\Program Files"', 'cmd')).toEqual({ kind: 'exact', command: 'dir "C:\\Program Files"' });
  });
  it('a text with a placeholder is typed', () => {
    const e = parseEntryText('task show <id:hexid(8)>', 'sh');
    expect(e.kind).toBe('typed');
  });
  it.each(['echo a > out', 'cat < in', 'orch <x', 'a >b', 'x <n:int(1,2)', '<>'])('refuses %j: an angle bracket must belong to a complete placeholder', (text) => {
    expect(() => parseEntryText(text, 'sh')).toThrow(TemplateError);
  });
  it('names the way out for a redirection', () => {
    expect(() => parseEntryText('echo a > out', 'sh')).toThrow(/angle bracket|placeholder/i);
  });
});

describe('hasAngleBracket and looksLikePlaceholder', () => {
  it('detects any angle bracket', () => {
    expect(hasAngleBracket('a<b')).toBe(true);
    expect(hasAngleBracket('a>b')).toBe(true);
    expect(hasAngleBracket('ab')).toBe(false);
  });
  it('looksLikePlaceholder: the <...:...> shape a v1 body must not hold', () => {
    expect(looksLikePlaceholder('orch logs <n:int(1,500)>')).toBe(true);
    expect(looksLikePlaceholder('orch <a:b:c>')).toBe(true);
    expect(looksLikePlaceholder('echo a > out')).toBe(false);
    expect(looksLikePlaceholder('echo <x> y: z')).toBe(false);
    expect(looksLikePlaceholder('plain')).toBe(false);
  });
});

describe('matchTemplate', () => {
  const T = 'orch logs <job:name> --tail <n:int(1,500)>';
  it('accepts a command whose every typed token passes', () => {
    expect(matches(T, 'orch logs build --tail 50')).toBe(true);
    expect(matches(T, 'orch logs my-job --tail 500')).toBe(true);
  });
  it('refuses a different fixed word, a different count of tokens, an empty token', () => {
    expect(matches(T, 'orch log build --tail 50')).toBe(false);
    expect(matches(T, 'orch logs build --tail')).toBe(false);
    expect(matches(T, 'orch logs build --tail 50 --x')).toBe(false);
    expect(matches(T, 'orch logs  build --tail 50')).toBe(false);
    expect(matches(T, 'orch logs build --tail 50 ')).toBe(false);
    expect(matches(T, ' orch logs build --tail 50')).toBe(false);
    expect(matches(T, 'orch logs build -- tail 50')).toBe(false);
  });
  it('refuses a value outside its type, at the token that fails', () => {
    const r = matchTemplate(tpl(T), 'orch logs build --tail 501', 'posix');
    // Token numbers start at 1 (the same numbering as the parse errors).
    expect(r).toMatchObject({ ok: false, tokenIndex: 5 });
    if (!r.ok) {
      expect(r.rule).toMatch(/range/);
      expect(r.rule).not.toContain('501');
    }
    expect(matchTemplate(tpl(T), 'orch logs x;id --tail 5', 'posix')).toMatchObject({ ok: false, tokenIndex: 3 });
    expect(matchTemplate(tpl(T), 'orch logs build', 'posix')).toMatchObject({ ok: false });
  });
  it('the prefix form needs the exact prefix then a valid value', () => {
    const P = 'journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager';
    expect(matches(P, 'journalctl -u ssh.service --lines=50 --no-pager')).toBe(true);
    expect(matches(P, 'journalctl -u ssh.service --lines=0 --no-pager')).toBe(false);
    expect(matches(P, 'journalctl -u ssh.service --lines= --no-pager')).toBe(false);
    expect(matches(P, 'journalctl -u ssh.service --lines=50x --no-pager')).toBe(false);
    expect(matches(P, 'journalctl -u ssh.service --line=50 --no-pager')).toBe(false);
    expect(matches(P, 'journalctl -u ssh.service lines=50 --no-pager')).toBe(false);
    expect(matches(P, 'journalctl -u other.service --lines=50 --no-pager')).toBe(false);
  });
  it('a value can never be an option', () => {
    expect(matches('git show <r:name>', 'git show -x')).toBe(false);
    expect(matches('git show <r:name>', 'git show --upload-pack=x')).toBe(false);
  });
  it('the platform decides the reserved device names', () => {
    expect(matches('type <f:name>', 'type nul', 'windows', 'cmd')).toBe(false);
    expect(matches('type <f:name>', 'type nul', 'posix', 'cmd')).toBe(true);
  });
});

describe('canonicalEntry: duplicate detection ignores the label, not the type', () => {
  const c = (text: string, shell: 'cmd' | 'ps' | 'bash' | 'sh' = 'sh') => canonicalEntry(shell, parseEntryText(text, shell));
  it('the label and the order of enum members do not matter', () => {
    expect(c('x <a:int(1,5)>')).toBe(c('x <other:int(1,5)>'));
    expect(c('x <a:enum(p|q)>')).toBe(c('x <b:enum(q|p)>'));
    expect(c('x <a:port>')).toBe(c('x <b:int(1,65535)>'));
    expect(c('x <a:name>')).toBe(c('x <b:name(max=64)>'));
  });
  it('a different type or bound is a different entry', () => {
    expect(c('x <a:int(1,5)>')).not.toBe(c('x <a:int(1,6)>'));
    expect(c('x <a:name>')).not.toBe(c('x <a:name(dot)>'));
    expect(c('x <a:int(1,5)>', 'sh')).not.toBe(c('x <a:int(1,5)>', 'bash'));
  });
  it('an exact entry is never equal to a typed one', () => {
    expect(c('x y')).not.toBe(c('x <a:int(1,5)>'));
  });
});

describe('templateExamples: two accepted and two refused command lines from the same validator', () => {
  it('builds lines that matchTemplate confirms', () => {
    const t = tpl('journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager');
    const ex = templateExamples(t, 'posix');
    expect(ex.accepted).toHaveLength(2);
    expect(ex.refused).toHaveLength(2);
    for (const line of ex.accepted) expect(matchTemplate(t, line, 'posix').ok, line).toBe(true);
    for (const line of ex.refused) expect(matchTemplate(t, line, 'posix').ok, line).toBe(false);
  });
  it('works for a single placeholder', () => {
    const t = tpl('task show <id:hexid(8)> --json');
    const ex = templateExamples(t, 'posix');
    expect(ex.accepted).toHaveLength(2);
    expect(ex.refused).toHaveLength(2);
  });
});

describe('limits of an entry, at the boundary', () => {
  it('the entry text: 2048 characters accepted, 2049 refused, empty refused, each naming 2048', () => {
    const at = (length: number) => `${'a'.repeat(length - 13)} <n:int(1,9)>`;
    expect(at(MAX_TEXT)).toHaveLength(2048);
    expect(tpl(at(MAX_TEXT)).placeholders).toBe(1);
    expect(() => tpl(at(MAX_TEXT + 1))).toThrow(/longer than 2048 characters/);
    expect(() => tpl('')).toThrow(/empty/);
  });

  it('the final command line: 2048 accepted, 2049 refused (a value can be longer than its placeholder)', () => {
    // `<n:name(max=128)>` is 17 characters and stands for up to 128: the line is the fixed part plus 1 plus 128.
    const at = (fixed: number) => `${'a'.repeat(fixed)} <n:name(max=128)>`;
    expect(tpl(at(1919)).placeholders).toBe(1);
    expect(() => tpl(at(1920))).toThrow(/could reach 2049 characters, above 2048/);
  });

  it('the placeholders: 8 accepted, 9 refused, naming 8', () => {
    const many = (n: number) => `x ${Array.from({ length: n }, (_, i) => `<p${i}:int(1,2)>`).join(' ')}`;
    expect(tpl(many(8)).placeholders).toBe(8);
    expect(() => tpl(many(9))).toThrow(/at most 8 placeholders/);
  });

  it('the label: 32 characters accepted, 33 refused', () => {
    expect(tpl(`x <${'a'.repeat(32)}:int(1,2)>`).placeholders).toBe(1);
    expect(() => tpl(`x <${'a'.repeat(33)}:int(1,2)>`)).toThrow(/1 to 32 characters/);
  });

  it('a value matched against a template is bound by the type, and a request line by the 2048 of the request itself', () => {
    const t = tpl('x <n:name(max=128)>');
    expect(matchTemplate(t, `x ${'a'.repeat(128)}`, 'posix').ok).toBe(true);
    const r = matchTemplate(t, `x ${'a'.repeat(129)}`, 'posix');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule).toMatch(/longer than 128 characters/);
    }
  });
});
