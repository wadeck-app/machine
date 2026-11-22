import type { ActivityEvent } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { createFollowRows, isQuietEvent } from './followRows.js';

// The rows of `machine log --follow` fit the terminal: no line is longer than the columns, whatever the width, and a resize applies to the next row.

const AT = new Date(2026, 10, 22, 14, 3, 9).getTime();

function ran(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    ts: new Date(AT).toISOString(),
    atMs: AT,
    direction: 'received',
    from: { uuid: 'u-thinkcentre', name: 'thinkcentre' },
    to: { uuid: 'u-midgard2', name: 'midgard2' },
    shell: 'sh',
    command: 'git -C /srv/app pull --ff-only origin main && npm ci && npm run build',
    outcome: 'ran',
    exitCode: 0,
    execMs: 14,
    durationMs: 14,
    waitedSeconds: 0,
    verified: true,
    ...over,
  };
}

const refused = (): ActivityEvent => ran({ outcome: 'refused', reason: 'not-listed', command: 'rm -rf /srv/app/data', execMs: undefined, durationMs: undefined, exitCode: undefined });
const waited = (): ActivityEvent => ran({ waitedSeconds: 107, execMs: 3200 });
const doc = (over: Partial<ActivityEvent> = {}): ActivityEvent => ran({ command: '', shell: '', outcome: 'document-delivered', detail: 'already-installed', exitCode: undefined, execMs: undefined, durationMs: undefined, ...over });

function rowsAt(columns: number, events: ActivityEvent[], all = true): string[] {
  const rows = createFollowRows({ columns: () => columns, all });
  return [rows.header(), ...events.map((e) => rows.row(e)).filter((l): l is string => l !== undefined)];
}

describe('follow rows fit the terminal', () => {
  for (const width of [40, 60, 80, 100, 120, 160, 300]) {
    it(`no line is longer than ${width} columns, and the command, result and exit are always there`, () => {
      const lines = rowsAt(width, [ran(), refused(), waited(), ran({ exitCode: null }), ran({ timedOut: true }), doc(), ran({ command: 'x'.repeat(400) })]);
      for (const line of lines) {
        expect(line.length, line).toBeLessThanOrEqual(width);
      }
      expect(lines[1]).toMatch(/\d\d-\d\d \d\d:\d\d/);
      expect(lines[1]).toContain('ran');
      expect(lines[2]).toContain(width === 40 ? 'refus' : 'refused');
    });
  }

  it('keeps at least 12 characters of the command from 60 columns up, and ends a cut command with ...', () => {
    for (const width of [60, 80, 100, 120, 160]) {
      const [, line] = rowsAt(width, [ran()]);
      expect(line as string).toContain('git -C /s');
      if (width <= 120) {
        expect(line as string).toMatch(/\.\.\./);
      }
    }
  });

  it('recomputes at each row: a resize between two rows changes the second row only', () => {
    let columns = 160;
    const rows = createFollowRows({ columns: () => columns, all: true });
    const wide = rows.row(ran()) as string;
    columns = 80;
    const narrow = rows.row(ran()) as string;
    expect(wide.length).toBeGreaterThan(80);
    expect(wide.length).toBeLessThanOrEqual(160);
    expect(narrow.length).toBeLessThanOrEqual(80);
  });

  it('drops the year of the time and merges the exit code and the run time in one cell', () => {
    const [, line] = rowsAt(100, [ran()]);
    expect(line as string).toMatch(/^11-22 14:03:09 /);
    expect(line as string).toMatch(/ran\s+0\s{2}14 ms$/);
  });

  it('prints the wait as a tail only on the rows that have one, when the width allows', () => {
    const [, plain, withWait] = rowsAt(160, [ran(), waited()]);
    expect(plain as string).not.toContain('waited');
    expect(withWait as string).toMatch(/3\.2 s\s+waited 1 min 47 s$/);
    const [, narrow] = rowsAt(70, [waited()]);
    expect(narrow as string).not.toContain('waited');
  });

  it('names the other machine on the first row and when it changes, not on every row', () => {
    const rows = createFollowRows({ columns: () => 120, all: true });
    const other = ran({ from: { uuid: 'u-laptop', name: 'laptop' } });
    const lines = [ran(), ran(), other, other, ran()].map((e) => rows.row(e) as string);
    expect(lines.map((l) => l.includes('thinkcentre'))).toEqual([true, false, false, false, true]);
    expect(lines.map((l) => l.includes('laptop'))).toEqual([false, false, true, false, false]);
  });

  it('does not name the machine at all when the header named the only peer', () => {
    const rows = createFollowRows({ columns: () => 120, all: true, peer: 'thinkcentre' });
    expect(rows.row(ran())).not.toContain('thinkcentre');
    expect(rows.row(ran({ from: { uuid: 'u-laptop', name: 'laptop' } }))).toContain('laptop');
  });

  it('shows the shell when there is room, never when it would cut the command below 24 characters', () => {
    const [, wide] = rowsAt(160, [ran()]);
    expect(wide as string).toMatch(/ sh /);
    const [, narrow] = rowsAt(70, [ran()]);
    expect(narrow as string).not.toMatch(/\d sh /);
  });

  it('the header line has the same columns as the rows', () => {
    const [header] = rowsAt(100, [ran()]);
    expect(header as string).toMatch(/^TIME\s+SHELL\s+COMMAND\s+RESULT\s+EXIT\s+RAN$/);
  });
});

describe('event rows', () => {
  it('are one short line with short wording', () => {
    const [, delivered, installed, session] = rowsAt(100, [doc(), doc({ detail: 'installed' }), doc({ outcome: 'session-closed', detail: 'peer-revoked' })]);
    expect(delivered as string).toContain('doc already there');
    expect(installed as string).toContain('doc delivered');
    expect(session as string).toContain('session closed');
    expect(session as string).toContain('peer-revoked');
    expect(delivered as string).not.toMatch(/already-installed|\(already/);
  });

  it('documents, sessions and notices are hidden unless --all; commands, refusals, holds and failures never are', () => {
    const shown = (e: ActivityEvent): boolean => createFollowRows({ columns: () => 100, all: false }).row(e) !== undefined;
    for (const outcome of ['document-accepted', 'document-delivered', 'session-closed', 'session-error', 'request-notice', 'notice-undelivered', 'daemon-started']) {
      expect(isQuietEvent(doc({ outcome })), outcome).toBe(true);
      expect(shown(doc({ outcome })), outcome).toBe(false);
    }
    for (const e of [ran(), refused(), ran({ outcome: 'running' }), ran({ outcome: 'error', cause: 'boom' }), ran({ outcome: 'held', command: 'df' }), ran({ outcome: 'hold-ended', detail: 'allowed' }), ran({ direction: 'sent' })]) {
      expect(shown(e), e.outcome).toBe(true);
    }
  });
});

// The same five entries at each width: the whole block, as printed.
const GOLDEN_EVENTS = (): ActivityEvent[] => [ran(), ran({ command: 'ls -l', waitedSeconds: 107, execMs: 3200 }), refused(), doc(), ran({ exitCode: null, command: 'sleep 999' })];
const GOLDEN: Record<number, string[]> = {
  80: [
    'TIME              COMMAND                    RESULT             EXIT  RAN',
    '11-22 14:03:09 <= thinkcentre: git -C /s...  ran                   0  14 ms',
    '11-22 14:03:09 <= ls -l                      ran                   0  3.2 s',
    '11-22 14:03:09 <= rm -rf /srv/app/data       refused (no...        -',
    '11-22 14:03:09 <= doc already there          -                     -',
    '11-22 14:03:09 <= sleep 999                  ran              killed  14 ms',
  ],
  100: [
    'TIME              SHELL  COMMAND                         RESULT                     EXIT  RAN',
    '11-22 14:03:09 <= sh     thinkcentre: git -C /srv/ap...  ran                           0  14 ms',
    '11-22 14:03:09 <= sh     ls -l                           ran                           0  3.2 s',
    '11-22 14:03:09 <= sh     rm -rf /srv/app/data            refused (not-listed)          -',
    '11-22 14:03:09 <= -      doc already there               -                             -',
    '11-22 14:03:09 <= sh     sleep 999                       ran                      killed  14 ms',
  ],
  120: [
    'TIME              SHELL  COMMAND                                       RESULT                           EXIT  RAN',
    '11-22 14:03:09 <= sh     thinkcentre: git -C /srv/app pull --ff-on...  ran                                 0  14 ms',
    '11-22 14:03:09 <= sh     ls -l                                         ran                                 0  3.2 s',
    '11-22 14:03:09 <= sh     rm -rf /srv/app/data                          refused (not-listed)                -',
    '11-22 14:03:09 <= -      doc already there                             -                                   -',
    '11-22 14:03:09 <= sh     sleep 999                                     ran                            killed  14 ms',
  ],
  160: [
    'TIME              SHELL  COMMAND                                                         RESULT                           EXIT  RAN        WAITED',
    '11-22 14:03:09 <= sh     thinkcentre: git -C /srv/app pull --ff-only origin main && ...  ran                                 0  14 ms',
    '11-22 14:03:09 <= sh     ls -l                                                           ran                                 0  3.2 s      waited 1 min 47 s',
    '11-22 14:03:09 <= sh     rm -rf /srv/app/data                                            refused (not-listed)                -',
    '11-22 14:03:09 <= -      doc already there                                               -                                   -',
    '11-22 14:03:09 <= sh     sleep 999                                                       ran                            killed  14 ms',
  ],
};

describe('golden blocks', () => {
  for (const width of [80, 100, 120, 160]) {
    it(`prints exactly this at ${width} columns`, () => {
      expect(rowsAt(width, GOLDEN_EVENTS())).toEqual(GOLDEN[width]);
    });
  }
});
