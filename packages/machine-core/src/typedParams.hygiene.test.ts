import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// USER RULE (2026-11-21): character checks of the validator are WHITELISTS. These tests fail when a validator source holds a blacklist-style
// check: a negated character class, a constant made of dangerous characters, or a name that says "forbidden"/"blacklist". The scan is a
// guard, not a proof: the proof is the hostile corpus of typedParams.test.ts. It is reviewed by hand too (see the report of the change).

const here = dirname(fileURLToPath(import.meta.url));
export const VALIDATOR_SOURCES = ['typedParams.ts', 'template.ts', 'lifetime.ts', 'readOnly.ts'];
/** The copies of the browser (machine-webcrypto) are scanned too. */
const COPIES = VALIDATOR_SOURCES.map((file) => join(here, '..', '..', 'machine-webcrypto', 'src', file));

/** Characters that appear in no whitelist of any type: a constant holding several of them, without a letter, is a deny list. */
const DANGEROUS = ';&$`"\'\\*?~!#%^<>{}[]';

function stripComments(source: string): string {
  // A Windows checkout has CRLF line ends: `.` does not match `\r`, so the line comments would survive the strip without this split.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

export function blacklistFindings(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  if (code.includes('[^')) {
    found.push('negated character class [^...]');
  }
  const word = /\b(forbidden|banned|blacklist|blocklist|denylist|deny|illegal|dangerous|unsafe)\w*/i.exec(code);
  if (word) {
    found.push(`deny-list wording "${word[0]}"`);
  }
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const text = m[2] as string;
    const letters = /[A-Za-z0-9]/.test(text);
    const hits = [...text].filter((c) => DANGEROUS.includes(c));
    if (!letters && hits.length >= 3) {
      found.push(`constant of dangerous characters ${JSON.stringify(text)}`);
    }
  }
  return found;
}

describe('the validator holds no blacklist of characters', () => {
  it('finds the validator sources (the scan below is not vacuous)', () => {
    for (const file of VALIDATOR_SOURCES) expect(readFileSync(join(here, file), 'utf8').length).toBeGreaterThan(500);
  });

  it.each(VALIDATOR_SOURCES)('%s has no negated class, no dangerous-character constant, no deny-list wording', (file) => {
    expect(blacklistFindings(readFileSync(join(here, file), 'utf8'))).toEqual([]);
  });

  it.each(COPIES)('the browser copy %s is clean too', (file) => {
    expect(blacklistFindings(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the scan itself catches the blacklist styles it is meant to catch', () => {
    expect(blacklistFindings("const bad = /[^a-z]/;")).not.toEqual([]);
    expect(blacklistFindings("const BAD = ';|&$`';\nconst x = 1;")).not.toEqual([]);
    expect(blacklistFindings("const FORBIDDEN = 'x';")).not.toEqual([]);
    expect(blacklistFindings('const blacklist = [1];')).not.toEqual([]);
    expect(blacklistFindings('const SHELL_META = "<>;&";')).not.toEqual([]);
    // Comments and ordinary text are not findings.
    expect(blacklistFindings("// never a forbidden list: [^x] ;&$\nconst ok = 'abc';")).toEqual([]);
    // Same source with Windows line ends (CI on windows-latest checks files out with CRLF).
    expect(blacklistFindings("// never a forbidden list: [^x] ;&$\r\nconst ok = 'abc';\r\n")).toEqual([]);
  });
});
