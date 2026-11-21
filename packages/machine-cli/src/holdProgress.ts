import { resolveMachineRef, type HoldTable, type NoticeOutcome } from '@wadeck-app/machine-core';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { findNoticeEnd } from './noticeEnds.js';
import { readNotices } from './noticesStore.js';
import { readAliases } from './state.js';

// After an Allow, the Requests page asks every 2 s: is the request still held, or how did the hold end? (decision 86). For a request held on THIS machine the
// answer comes from the hold table of the daemon and from the outcomes it kept; for a request held on another machine, from what that machine told this one
// (`request-notice`, `request-notice-end`). `unknown` means nothing is known: the machine may be offline, run an older build, or not list this machine among
// the recipients of its notices. It is NEVER a success: the page shows a success only for an `ended` answer.

export type HoldProgressAnswer =
  | { ok: true; machine: { uuid: string; name: string }; id: string; state: 'held' }
  | { ok: true; machine: { uuid: string; name: string }; id: string; state: 'ended'; outcome: NoticeOutcome; at: number }
  | { ok: true; machine: { uuid: string; name: string }; id: string; state: 'unknown'; note?: string }
  | { ok: false; reason: 'bad-payload' | 'unknown-peer'; message: string };

const REQUEST_ID = /^[0-9a-f-]{6,36}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function holdProgressCommand(configDir: string, payload: unknown, now: number, holds?: HoldTable): HoldProgressAnswer {
  const p = typeof payload === 'object' && payload !== null ? (payload as { id?: unknown; machine?: unknown }) : {};
  if (typeof p.id !== 'string' || !REQUEST_ID.test(p.id) || (p.machine !== undefined && typeof p.machine !== 'string')) {
    return { ok: false, reason: 'bad-payload', message: 'expected {"id": "<id of the held request>", "machine": "<the machine that holds it, absent for this machine>"}: the "id" is the 6 to 36 hexadecimal characters and "-" that `machine requests` prints' };
  }
  const id = p.id;
  const self = readMachine(configDir);
  let machine = { uuid: self.uuid, name: self.name };
  if (p.machine !== undefined && p.machine !== self.uuid) {
    const network = loadNetwork(configDir, now);
    const known = network.directory.machines().find((m) => m.uuid === p.machine);
    if (known !== undefined) {
      machine = { uuid: known.uuid, name: known.name };
    } else if (UUID.test(p.machine)) {
      // What is kept per machine is keyed by the uuid the connection authenticated: a uuid this machine does not list simply has nothing.
      machine = { uuid: p.machine, name: p.machine.slice(0, 8) };
    } else {
      const resolved = resolveMachineRef(p.machine, network.directory.machines(), readAliases(configDir));
      if (!resolved.ok) {
        return { ok: false, reason: 'unknown-peer', message: `${resolved.message} (see \`machine list\`)` };
      }
      const found = network.directory.machines().find((m) => m.uuid === resolved.uuid);
      machine = { uuid: resolved.uuid, name: found?.name ?? resolved.uuid.slice(0, 8) };
    }
  }
  const local = machine.uuid === self.uuid;
  if (local) {
    if (holds === undefined) {
      return { ok: true, machine, id, state: 'unknown', note: 'the machine daemon is not running, so no request is held here: start it with `machine startup enable` (at login) or `machine daemon`' };
    }
    if (holds.get(id) !== undefined) {
      return { ok: true, machine, id, state: 'held' };
    }
  } else if (readNotices(configDir).some((n) => n.machine === machine.uuid && n.id === id && n.state === 'held')) {
    // Only a notice of that hold, kept as long as it lasts: an ended hold drops it.
    const end = findNoticeEnd(configDir, machine.uuid, id);
    if (end === undefined) {
      return { ok: true, machine, id, state: 'held' };
    }
  }
  const end = findNoticeEnd(configDir, machine.uuid, id);
  if (end !== undefined) {
    return { ok: true, machine, id, state: 'ended', outcome: end.outcome, at: end.at };
  }
  return { ok: true, machine, id, state: 'unknown' };
}
