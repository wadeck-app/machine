import { existsSync, readFileSync } from 'node:fs';
import { buildActivity, parseActivityQuery, type ActivityPage, type ActivityQueryText } from '@wadeck-app/machine-core';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { auditLogFile } from './requestsView.js';
import { readRunLog, runLogDir } from './runLogStore.js';

// `machine log` and the Activity page of the module: the commands THIS machine sent (its outgoing run log) and received (its audit log) in one
// timeline (machine-core buildActivity). Read-only: nothing is written, no daemon is needed, nothing is sent to a peer.

export interface ActivityView {
  initialized: true;
  ok: true;
  self: { uuid: string; name: string };
  /** Epoch seconds of the answer, so that a reader humanizes ages against the same clock. */
  now: number;
  page: ActivityPage;
  /** Where the sent runs are, and what was found there. */
  runLog: { dir: string; files: number; damagedLines: number };
  auditLogFile: string;
  auditLogPresent: boolean;
  /** The machines of the network and those seen in the logs, by name: the choices of a machine filter. */
  machines: string[];
}

export type ActivityAnswer =
  | { initialized: false; message: string }
  | { initialized: true; ok: false; reason: 'bad-query' | 'run-log-unreadable' | 'audit-log-unreadable'; message: string }
  | ActivityView;

export function activityAnswer(configDir: string, query: ActivityQueryText, nowSeconds: number): ActivityAnswer {
  let self;
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) {
      const { message } = e;
      return { initialized: false, message };
    }
    throw e;
  }
  let filter;
  try {
    filter = parseActivityQuery(query, nowSeconds * 1000);
  } catch (e) {
    return { initialized: true, ok: false, reason: 'bad-query', message: (e as Error).message };
  }
  const network = loadNetwork(configDir, nowSeconds);
  const directory = network.directory.machines();
  const names = new Map(directory.map((m) => [m.uuid, m.name]));

  let sent;
  try {
    sent = readRunLog(configDir);
  } catch (e) {
    return { initialized: true, ok: false, reason: 'run-log-unreadable', message: (e as Error).message };
  }
  const auditFile = auditLogFile(configDir);
  const auditLogPresent = existsSync(auditFile);
  let auditLines: string[] = [];
  if (auditLogPresent) {
    try {
      const text = readFileSync(auditFile, 'utf8');
      auditLines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
    } catch (e) {
      return { initialized: true, ok: false, reason: 'audit-log-unreadable', message: `cannot read the audit log ${auditFile}: ${(e as Error).message}. Fix its permissions, then run the command again` };
    }
  }

  const page = buildActivity({ self: { uuid: self.uuid, name: self.name }, sent: sent.entries, auditLines, nameOf: (uuid) => names.get(uuid), filter });
  return {
    initialized: true,
    ok: true,
    self: { uuid: self.uuid, name: self.name },
    now: nowSeconds,
    page,
    runLog: { dir: runLogDir(configDir), files: sent.files, damagedLines: sent.damaged },
    auditLogFile: auditFile,
    auditLogPresent,
    machines: [...new Set([...page.machines, ...directory.map((m) => m.name)])].sort((a, b) => a.localeCompare(b)),
  };
}

const QUERY_FIELDS = ['direction', 'machine', 'outcome', 'since', 'text', 'limit', 'offset'] as const;

/** The payload of the daemon command: an object of text fields, nothing else. A wrong shape is a `bad-query` with the fix, not a guess. */
export function activityFromPayload(configDir: string, payload: unknown, nowSeconds: number): ActivityAnswer {
  const bad = (message: string): ActivityAnswer => ({ initialized: true, ok: false, reason: 'bad-query', message });
  if (payload === undefined) {
    return activityAnswer(configDir, {}, nowSeconds);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return bad(`the query must be an object of text fields (${QUERY_FIELDS.join(', ')})`);
  }
  const query: ActivityQueryText = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!(QUERY_FIELDS as readonly string[]).includes(key)) {
      return bad(`the query field "${key}" is not known: use ${QUERY_FIELDS.join(', ')}`);
    }
    if (typeof value !== 'string') {
      return bad(`the query field "${key}" must be text (a number is sent as text, for example "20")`);
    }
    query[key as (typeof QUERY_FIELDS)[number]] = value;
  }
  return activityAnswer(configDir, query, nowSeconds);
}
