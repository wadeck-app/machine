import { describe, expect, it } from 'vitest';
import { canonicalType, checkValue, parseTypeSpec, sampleValues, TemplateError, type Platform, type TypeSpec } from './typedParams.js';

// Phase 1 typed parameters (typed-parameters.md): every type is a WHITELIST. The tests below prove what each type accepts and, with a hostile
// corpus, that everything else is refused. The dangerous characters appear ONLY here.

const spec = (text: string): TypeSpec => parseTypeSpec(text);
const ok = (type: string, value: string, platform: Platform = 'posix'): boolean => checkValue(spec(type), value, platform).ok;

describe('parseTypeSpec: the type text of a placeholder', () => {
  it.each([
    ['int(1,500)', 'int(1,500)'],
    ['int(0,0)', 'int(0,0)'],
    ['int(0,2147483647)', 'int(0,2147483647)'],
    ['duration(1,3600)', 'duration(1,3600)'],
    ['name', 'name(max=64)'],
    ['name(max=32)', 'name(max=32)'],
    ['name(dot)', 'name(max=64,dot)'],
    ['name(max=16,dot)', 'name(max=16,dot)'],
    ['port', 'int(1,65535)'],
    ['hexid(8)', 'hexid(8)'],
    ['uuid', 'uuid'],
    ['enum(ssh.service|machine.service)', 'enum(machine.service|ssh.service)'],
    ['enum(a)', 'enum(a)'],
  ])('accepts %s (canonical %s)', (text, canonical) => {
    expect(canonicalType(spec(text))).toBe(canonical);
  });

  it.each([
    ['', 'empty'],
    ['frobnicate', 'unknown type'],
    ['int', 'bounds'],
    ['int()', 'bounds'],
    ['int(1)', 'bounds'],
    ['int(5,1)', 'min'],
    ['int(1,2', 'closing'],
    ['int(-1,5)', 'digits'],
    ['int(01,5)', 'digits'],
    ['int(1,2147483648)', '2147483647'],
    ['int(1.5,3)', 'digits'],
    ['int(1,2,3)', 'bounds'],
    ['duration(0,10)', 'at least 1'],
    ['duration(1)', 'bounds'],
    ['duration(10,1)', 'min'],
    ['name(max=0)', 'max'],
    ['name(max=129)', '128'],
    ['duration(1,31536001)', '31536000'],
    ['duration(1,2147483647)', '365 days'],
    ['name(max=x)', 'max'],
    ['name(dots)', 'option'],
    ['name(dot,dot)', 'twice'],
    ['port(1,2)', 'no argument'],
    ['uuid(4)', 'no argument'],
    ['hexid', 'length'],
    ['hexid(0)', 'length'],
    ['hexid(65)', 'length'],
    ['hexid(x)', 'length'],
    ['enum()', 'member'],
    ['enum(a||b)', 'member'],
    ['enum(a|a)', 'twice'],
    ['enum(--x)', 'start'],
    ['enum(a;b)', 'member'],
    ['enum(a b)', 'member'],
    ['enum(a|b|)', 'member'],
    ['int(1,2)x', 'unknown type'],
    ['INT(1,2)', 'unknown type'],
    ['path(root=/x)', 'phase 2'],
    ['host', 'phase 2'],
    ['ref', 'phase 2'],
  ])('refuses %j (%s)', (text, hint) => {
    expect(() => parseTypeSpec(text)).toThrow(TemplateError);
    expect(() => parseTypeSpec(text)).toThrow(new RegExp(hint, 'i'));
  });

  it('refuses more than 64 enum members and members longer than 64 characters', () => {
    expect(() => parseTypeSpec(`enum(${Array.from({ length: 65 }, (_, i) => `m${i}`).join('|')})`)).toThrow(/at most 64 members/);
    expect(() => parseTypeSpec(`enum(${'a'.repeat(65)})`)).toThrow(/64 characters/);
  });
});

describe('int(min,max): the digits 0-9 only, no sign, no leading zero', () => {
  it.each(['0', '1', '7', '500', '0'])('accepts %s in int(0,500)', (v) => expect(ok('int(0,500)', v)).toBe(true));
  it.each(['501', '99999999999', '2147483648'])('refuses the out-of-range %s', (v) => expect(ok('int(0,500)', v)).toBe(false));
  it('refuses below the minimum and accepts both bounds', () => {
    expect(ok('int(5,9)', '4')).toBe(false);
    expect(ok('int(5,9)', '5')).toBe(true);
    expect(ok('int(5,9)', '9')).toBe(true);
    expect(ok('int(5,9)', '10')).toBe(false);
  });
  it.each(['', '00', '01', '+1', '-1', '1.0', '1e2', '0x10', '1_0', ' 1', '1 ', '\u0661', '\uff11', '1\u0661', '12345678901', 'one'])('refuses %j', (v) => expect(ok('int(0,2147483647)', v)).toBe(false));
});

describe('port', () => {
  it.each(['1', '22', '8080', '65535'])('accepts %s', (v) => expect(ok('port', v)).toBe(true));
  it.each(['0', '65536', '080', '-1', '1e3', ''])('refuses %j', (v) => expect(ok('port', v)).toBe(false));
});

describe('duration(min,max): digits then one of s m h d', () => {
  it.each(['1s', '90s', '5m', '2h', '1d'])('accepts %s in duration(1,86400)', (v) => expect(ok('duration(1,86400)', v)).toBe(true));
  it('checks the bounds in seconds', () => {
    expect(ok('duration(60,3600)', '59s')).toBe(false);
    expect(ok('duration(60,3600)', '60s')).toBe(true);
    expect(ok('duration(60,3600)', '1m')).toBe(true);
    expect(ok('duration(60,3600)', '1h')).toBe(true);
    expect(ok('duration(60,3600)', '61m')).toBe(false);
    expect(ok('duration(60,3600)', '2h')).toBe(false);
  });
  it.each(['', '0s', '00s', '01s', '5', 's', '5S', '5M', '5w', '5ms', '1.5h', '-5s', '+5s', '5 s', '5h5m', '\u0661s', '99999999999d'])('refuses %j', (v) => expect(ok('duration(1,31536000)', v)).toBe(false));
});

describe('name: [A-Za-z0-9_][A-Za-z0-9_-]*, length-bounded', () => {
  it.each(['a', 'job1', 'my-job', 'my_job', '_x', '9', 'A-b_C', 'x'.repeat(64)])('accepts %s', (v) => expect(ok('name', v)).toBe(true));
  it.each(['', '-x', 'a.b', '.a', 'a/b', 'a b', 'x'.repeat(65), 'a@b', 'a:b'])('refuses %j', (v) => expect(ok('name', v)).toBe(false));
  it('honours max=', () => {
    expect(ok('name(max=3)', 'abc')).toBe(true);
    expect(ok('name(max=3)', 'abcd')).toBe(false);
  });
  it('name(dot) allows inner dots only: no leading, trailing or double dot', () => {
    for (const v of ['a.b', 'a.b.c', 'v1.2.3', 'x.y-z']) expect(ok('name(dot)', v), v).toBe(true);
    for (const v of ['.a', 'a.', 'a..b', '.', '..', '-a.b', 'a.-b']) expect(ok('name(dot)', v), v).toBe(false);
  });
  it('refuses the reserved device names on a Windows target only (whatever the case, with or without an extension)', () => {
    for (const v of ['con', 'CON', 'Prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9']) {
      expect(ok('name', v, 'windows'), v).toBe(false);
      expect(ok('name', v, 'posix'), v).toBe(true);
    }
    expect(ok('name(dot)', 'nul.txt', 'windows')).toBe(false);
    expect(ok('name(dot)', 'com1.log', 'windows')).toBe(false);
    expect(ok('name', 'com0', 'windows')).toBe(true);
    expect(ok('name', 'console', 'windows')).toBe(true);
    expect(ok('name', 'com10', 'windows')).toBe(true);
  });
});

describe('enum: exactly one listed member', () => {
  const type = 'enum(ssh.service|machine.service|a:b|x@y|k+1|dash-ed)';
  it.each(['ssh.service', 'machine.service', 'a:b', 'x@y', 'k+1', 'dash-ed'])('accepts %s', (v) => expect(ok(type, v)).toBe(true));
  it.each(['', 'ssh', 'ssh.service ', ' ssh.service', 'SSH.SERVICE', 'ssh.service|machine.service', 'ssh.servic\u0435', 'ssh.service\u0000'])('refuses %j', (v) => expect(ok(type, v)).toBe(false));
});

describe('hexid(n) and uuid: lower-case hexadecimal', () => {
  it('hexid(8) accepts exactly 8 of 0-9 a-f', () => {
    expect(ok('hexid(8)', '0123abcd')).toBe(true);
    expect(ok('hexid(8)', 'deadbeef')).toBe(true);
    for (const v of ['', '0123abc', '0123abcde', '0123ABCD', '0123abcg', '0x23abcd', '0123abc ', '01234567\u0661']) expect(ok('hexid(8)', v), v).toBe(false);
  });
  it('uuid accepts the canonical lower-case form only', () => {
    expect(ok('uuid', '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f')).toBe(true);
    expect(ok('uuid', '00000000-0000-0000-0000-000000000000')).toBe(true);
    for (const v of ['', '6F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F', '6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f', '{6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f}', '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5', '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f0', '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5g']) expect(ok('uuid', v), v).toBe(false);
  });
});

// The hostile corpus: from the desk study and the surveyed CLIs. EVERY type must refuse EVERY one of them (none is a valid value of any type).
const HOSTILE: string[] = [
  '--upload-pack=x', '-oProxyCommand=x', '-', '--', '-1', '- x', 'ext::sh -c x', '; id', 'a;b', 'a|b', 'a&b', 'a&&b', 'a||b', '`id`', '$(id)', '${IFS}', '$HOME', '%PATH%', '%%',
  '"x"', "'x'", 'a"b', "a'b", 'a\\b', '\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'C:\\x', 'C:x', 'Env:PATH', 'a:b:stream', '../x', '..', '...', './x', '/etc/passwd', '~', '~/x', '@file', '@', '*', '?', 'a*b', '[a]', '{a,b}', '(a)', '<x', 'x>', '<x>', '#', '!', '^', ',', '=', 'a=b', '+', 'a b', 'a\tb', 'a\nb', 'a\rb', 'a\u0000b', '\u0000',
  '\u00e9', '\u0430', '\uff41', '\uff10', '\u0660', '\u202e', 'a\u202eb', '\u200b', '\ufeff', '\u00c0\u00af', '\ud83d\ude00', 'a'.repeat(5000), ' ', '\u00a0',
];
const ALL_TYPES = ['int(0,2147483647)', 'duration(1,31536000)', 'name', 'name(dot)', 'enum(a|b|c.d)', 'port', 'hexid(8)', 'uuid'];

describe('hostile corpus: refused by every type, on both platforms', () => {
  for (const type of ALL_TYPES) {
    it(`${type} refuses all ${HOSTILE.length}`, () => {
      const accepted = HOSTILE.filter((v) => ok(type, v, 'posix') || ok(type, v, 'windows'));
      expect(accepted).toEqual([]);
    });
  }
  it('a refusal names the rule but never echoes the value', () => {
    for (const type of ALL_TYPES) {
      const result = checkValue(spec(type), 'SECRET;$(id)\u0000', 'posix');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule.length).toBeGreaterThan(0);
        expect(result.rule).not.toContain('SECRET');
        expect(result.rule).not.toContain('$(id)');
      }
    }
  });
  it('a value that is not a string is refused, not coerced', () => {
    expect(checkValue(spec('int(0,9)'), 5 as unknown as string, 'posix').ok).toBe(false);
    expect(checkValue(spec('name'), undefined as unknown as string, 'posix').ok).toBe(false);
  });
});

describe('sampleValues: the examples shown before the passphrase come from the same validator', () => {
  it.each(ALL_TYPES)('%s: at least 2 accepted and 2 refused, each confirmed by checkValue', (type) => {
    const s = spec(type);
    const samples = sampleValues(s, 'posix');
    expect(samples.accepted.length).toBeGreaterThanOrEqual(2);
    expect(samples.refused.length).toBeGreaterThanOrEqual(2);
    for (const v of samples.accepted) expect(checkValue(s, v, 'posix').ok, v).toBe(true);
    for (const v of samples.refused) expect(checkValue(s, v, 'posix').ok, v).toBe(false);
    expect(new Set(samples.accepted).size).toBe(samples.accepted.length);
  });
});

// Realistic maximum sizes (user request 2026-11-21): each limit is tested at the exact boundary, the maximum accepted, the maximum + 1
// refused, and empty refused. A refusal names the limit and its value.
describe('limits of the types, at the boundary', () => {
  const refusal = (type: string, value: string): string => {
    const r = checkValue(spec(type), value, 'posix');
    if (r.ok) {
      throw new Error(`expected a refusal of a value of ${value.length} characters`);
    }
    return r.rule;
  };

  it('name: 64 by default, max= raises it to 128 at most', () => {
    expect(ok('name', 'a'.repeat(64))).toBe(true);
    expect(refusal('name', 'a'.repeat(65))).toMatch(/longer than 64 characters/);
    expect(ok('name(max=128)', 'a'.repeat(128))).toBe(true);
    expect(refusal('name(max=128)', 'a'.repeat(129))).toMatch(/longer than 128 characters/);
    expect(ok('name(max=1)', 'a')).toBe(true);
    expect(() => parseTypeSpec('name(max=129)')).toThrow(/1 to 128/);
    expect(() => parseTypeSpec('name(max=0)')).toThrow(/1 to 128/);
    expect(refusal('name', '')).toMatch(/empty/);
    expect(ok('name(dot)', `${'a'.repeat(31)}.${'b'.repeat(32)}`)).toBe(true);
    expect(refusal('name(dot)', `${'a'.repeat(32)}.${'b'.repeat(32)}`)).toMatch(/longer than 64 characters/);
  });

  it('int: at most 10 digits, bounds inside 0..2147483647', () => {
    expect(ok('int(0,2147483647)', '2147483647')).toBe(true);
    expect(refusal('int(0,2147483647)', '2147483648')).toMatch(/range/);
    expect(refusal('int(0,2147483647)', '12345678901')).toMatch(/more than 10 digits/);
    expect(refusal('int(0,2147483647)', '')).toMatch(/empty/);
    expect(() => parseTypeSpec('int(0,2147483648)')).toThrow(/2147483647/);
  });

  it('duration: at most 10 digits plus the unit, at most 365 days', () => {
    expect(ok('duration(1,31536000)', '365d')).toBe(true);
    expect(ok('duration(1,31536000)', '31536000s')).toBe(true);
    expect(ok('duration(1,31536000)', '8760h')).toBe(true);
    expect(refusal('duration(1,31536000)', '366d')).toMatch(/range/);
    expect(refusal('duration(1,31536000)', '31536001s')).toMatch(/range/);
    expect(refusal('duration(1,31536000)', '12345678901s')).toMatch(/more than 10 digits/);
    expect(refusal('duration(1,31536000)', '')).toMatch(/empty/);
    expect(() => parseTypeSpec('duration(1,31536001)')).toThrow(/at most 31536000 seconds \(365 days\)/);
  });

  it('hexid(n): n at most 64, exact length', () => {
    expect(ok('hexid(64)', 'a'.repeat(64))).toBe(true);
    expect(refusal('hexid(64)', 'a'.repeat(65))).toMatch(/exactly 64 characters/);
    expect(refusal('hexid(64)', '')).toMatch(/empty/);
    expect(() => parseTypeSpec('hexid(65)')).toThrow(/1 to 64/);
    expect(() => parseTypeSpec('hexid(0)')).toThrow(/1 to 64/);
  });

  it('uuid: exactly 36 characters', () => {
    const u = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
    expect(u).toHaveLength(36);
    expect(ok('uuid', u)).toBe(true);
    expect(refusal('uuid', `${u}0`)).toMatch(/36 characters/);
    expect(refusal('uuid', u.slice(0, 35))).toMatch(/36 characters/);
    expect(refusal('uuid', '')).toMatch(/empty/);
  });

  it('enum: at most 64 members of at most 64 characters', () => {
    const members = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`).join('|');
    expect(parseTypeSpec(`enum(${members(64)})`)).toMatchObject({ kind: 'enum' });
    expect(() => parseTypeSpec(`enum(${members(65)})`)).toThrow(/at most 64 members/);
    expect(ok(`enum(${'a'.repeat(64)}|b)`, 'a'.repeat(64))).toBe(true);
    expect(() => parseTypeSpec(`enum(${'a'.repeat(65)}|b)`)).toThrow(/longer than 64 characters/);
    expect(() => parseTypeSpec('enum()')).toThrow(/empty member/);
    expect(refusal('enum(a|b)', '')).toMatch(/empty/);
  });
});
