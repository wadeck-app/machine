import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The module UI uses the standard dsl-ui components only. These class tokens were custom looks of a boxed message, a pill, a card, a modal, a progress bar
// and a tooltip: each has a standard component now, so no component may use them again. The tokens that remain in styleTokens.ts have NO standard
// equivalent (see .claude/specs/2026-11-13_machine-network/admin-ui.md, "Custom styles audit").
const REPLACED = [
  'NOTICE_SUCCESS', 'NOTICE_WARNING', 'NOTICE_NEUTRAL', 'TEXT_ERROR',
  'MODAL_BACKDROP', 'MODAL_PANEL', 'MODAL_PANEL_WITH_ASIDE',
  'OUTCOME_SUCCESS', 'OUTCOME_WARNING', 'OUTCOME_DANGER', 'OUTCOME_NEUTRAL',
  'EXIT_OK', 'EXIT_FAIL', 'EXIT_NONE',
  'HELD_ITEM', 'HELD_COUNTDOWN', 'HELD_COUNTDOWN_URGENT',
  'PROGRESS_CARD_ACTIVE', 'PROGRESS_CARD_SUCCESS', 'PROGRESS_CARD_DANGER', 'PROGRESS_SLIM_SUCCESS',
  'STEPPER_SEGMENT', 'SEGMENT_DONE', 'SEGMENT_ACTIVE', 'SEGMENT_PENDING', 'SEGMENT_FAILED',
  'TABLE_HEAD_ROW', 'TABLE_BODY_ROW', 'TABLE_ROW_MIDDLE',
  'POPOVER_SURFACE',
  // Replaced by the Text atom of dsl-ui 413 (tone, size, mono).
  'TEXT_MUTED', 'TEXT_MUTED_SM', 'COMMAND_TEXT',
];

const dir = path.resolve(__dirname, '..');
const sources = (d: string): string[] => fs.readdirSync(path.join(dir, d)).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => path.join(dir, d, f));
// A source as text with LF line ends (a checkout may hold CRLF).
const read = (f: string): string => fs.readFileSync(f, 'utf8').split('\r\n').join('\n');
const component = (name: string): string => read(path.join(dir, 'components', name));

describe('the module uses the standard components only', () => {
  it.each(REPLACED)('no component or helper uses the custom token %s', (token) => {
    const re = new RegExp(`\\b${token}\\b`);
    const offenders = [...sources('components'), ...sources('lib')].filter((f) => !f.endsWith('styleTokens.ts') && re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    expect(offenders).toEqual([]);
  });

  it.each(REPLACED)('styleTokens.ts no longer defines %s', (token) => {
    expect(fs.readFileSync(path.join(dir, 'lib', 'styleTokens.ts'), 'utf8')).not.toMatch(new RegExp(`export const ${token}\\b`));
  });

  // MONO_STYLE and HELD_COMMAND remain for what Text cannot do (a size above sm, a weight, letter spacing, a pre block): the set of files is closed.
  it.each(['MONO_STYLE', 'HELD_COMMAND'])('%s is used only by the few components that need a large or spaced monospace text', (token) => {
    const allowed = ['FinalCodeDisplay.tsx', 'SecurityCodeCompare.tsx', 'HeldRequests.tsx', 'ExpiredNotices.tsx', 'DeliveryList.tsx'];
    const re = new RegExp(`\\b${token}\\b`);
    const offenders = sources('components').filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f)).filter((f) => !allowed.includes(f));
    expect(offenders).toEqual([]);
  });

  // dsl-ui 419 breaks a DataTable column and a FieldReadOnly between words with `wrap: words` (the default `anywhere` is break-all). The wrapper element and the description list
  // that stood in for that prop must not come back. (A `break-words` text outside a table or a field, like CommandNotice, is not one: no standard component covers it.)
  it.each(['WrapText', 'DetailRows', 'break-normal'])('no source uses the workaround %s: the standard `wrap: words` does it', (token) => {
    const re = new RegExp(`(?<![\\w-])${token}(?![\\w-])`);
    const offenders = [...sources('components'), ...sources('lib')].filter((f) => re.test(read(f))).map((f) => path.basename(f));
    expect(offenders).toEqual([]);
  });

  it('the files of the workaround are gone', () => {
    const present = ['DetailRows.tsx', 'DetailRows.test.tsx'].filter((f) => fs.existsSync(path.join(dir, 'components', f)));
    expect(present).toEqual([]);
  });

  // The columns whose cell is a sentence or a command say `wrap: 'words'` (the nowrap, truncated and fixed-width ones never break).
  it.each([
    ['ActivityLog.tsx', "key: 'command'"],
    ['CandidaciesTable.tsx', "key: 'statusText'"],
    ['MachinesTable.tsx', "key: 'reachable'"],
  ])('%s: the column %s breaks between words by the standard prop', (file, column) => {
    const line = component(file).split('\n').find((l) => l.includes(column));
    expect(line, `${file} has no column ${column}`).toBeDefined();
    expect(line).toMatch(/wrap: 'words'/);
  });

  // The folded Details of the dialogs are FieldReadOnly rows that break between words, never the default (break-all).
  it.each(['RenameMachineDialog.tsx', 'AliasesDialog.tsx', 'RevokeMachineDialog.tsx', 'ApproveCandidacyDialog.tsx'])('%s: every FieldReadOnly of the Details has wrap="words"', (file) => {
    const tags = component(file).match(/<FieldReadOnly\b[^>]*>/g) ?? [];
    expect(tags.length, `${file} shows its Details without FieldReadOnly`).toBeGreaterThan(0);
    expect(tags.filter((t) => !/\bwrap="words"/.test(t))).toEqual([]);
  });

  it('no component moves the initial focus by an effect: ButtonAction has autoFocus', () => {
    const offenders = sources('components').filter((f) => /querySelector[^\n]*\.focus\(\)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    expect(offenders).toEqual([]);
  });
});
