import type { PendingRequestRow } from '../components/AllowRequestsTable.js';
import type { HeldRequestRow } from '../components/HeldRequests.js';

// Request notices on the Requests page (request-notices.md, phase 2): what OTHER machines reported (a held or refused request) shown without a
// passphrase, as information. No React, no I/O. A notice never grants anything: Allow still signs the exact command for the machine of the row.

/** A notice as the module backend sends it (backend `NoticeRow`). */
export interface NoticeData {
  id: string;
  /** The machine that REPORTED it (uuid) and its name: the label of the row, and the machine Allow signs for. */
  machine: string;
  machineName: string;
  /** Who asked there. */
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  commandTruncated: boolean;
  state: 'held' | 'refused';
  secondsLeft: number | null;
  /** Epoch seconds, this machine's clock. */
  receivedAt: number;
}

export interface RefusedSection {
  machine: { uuid: string; name: string };
  rows: PendingRequestRow[];
}

export interface MergedNotices {
  held: HeldRequestRow[];
  refused: RefusedSection[];
}

const clock = (seconds: number): string => new Date(seconds * 1000).toTimeString().slice(0, 5);

/** The muted note of every notice row. */
export function noticeNote(machineName: string, receivedAtSeconds: number): string {
  return `reported by ${machineName} at ${clock(receivedAtSeconds)}; not verified live: use Load the other machines to confirm`;
}

const TRUNCATED_NEXT = 'The command is truncated: Allow is not offered for it. Use Load the other machines to see the whole command.';
const quote = (command: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(command) ? command : `"${command.replace(/(["\\$`])/g, '\\$1')}"`);
const nextFor = (n: NoticeData): string => (n.commandTruncated ? TRUNCATED_NEXT : `machine admin allow ${n.machineName} --shell ${n.shell} -- ${quote(n.command)}`);

/**
 * The notices to show. Dropped: those about this machine (its own rows are live), those of a machine the page has loaded live (the live view wins:
 * same request id or a request that is gone), those outside the machine filter, and a request id repeated by the same machine (the newest stays).
 * `notices` come newest first from the daemon.
 */
export function mergeNotices(input: { notices: NoticeData[]; selfUuid: string | undefined; loadedMachines: ReadonlySet<string>; filter: string; allowAvailable: boolean }): MergedNotices {
  const held: HeldRequestRow[] = [];
  const sections = new Map<string, RefusedSection>();
  const seen = new Set<string>();
  for (const n of input.notices) {
    if (n.machine === input.selfUuid || input.loadedMachines.has(n.machine) || (input.filter !== 'all' && input.filter !== n.machine)) {
      continue;
    }
    const key = `${n.machine}\u0000${n.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const note = noticeNote(n.machineName, n.receivedAt);
    const canAllow = input.allowAvailable && !n.commandTruncated;
    const machine = { uuid: n.machine, name: n.machineName };
    if (n.state === 'held') {
      held.push({
        id: n.id,
        peerText: n.peerText,
        peer: n.peer,
        shell: n.shell,
        command: n.command,
        secondsLeft: n.secondsLeft ?? 0,
        askedText: '',
        countText: 'waiting now',
        nextCommand: nextFor(n),
        nextWhere: '',
        machine,
        canAllow,
        denyText: `Deny: run \`machine requests --deny ${n.id.slice(0, 8)}\` ON ${n.machineName}`,
        note,
        commandTruncated: n.commandTruncated,
      });
      continue;
    }
    const section = sections.get(n.machine) ?? { machine, rows: [] };
    sections.set(n.machine, section);
    section.rows.push({
      peerText: n.peerText,
      peer: n.peer,
      shell: n.shell,
      command: n.command,
      countText: 'reported',
      firstSeenText: clock(n.receivedAt),
      lastSeenText: clock(n.receivedAt),
      nextCommand: nextFor(n),
      nextWhere: '',
      canAllow,
      note,
      commandTruncated: n.commandTruncated,
    });
  }
  return { held, refused: [...sections.values()] };
}
