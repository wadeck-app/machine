import { ActivityRangeError, buildActivity, parseActivityQuery, type ActivityPage, type ActivityQueryText } from '@wadeck-app/machine-core';
import { ActivityReadError, createCountCache, openActivityLogs, type ActivityBytes, type CountCache } from './activityLogs.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { auditLogFile } from './requestsView.js';
import { runLogDir } from './runLogStore.js';

// `machine log` and the Activity page of the module: the commands THIS machine sent (its outgoing run log) and received (its audit log) in one
// timeline (machine-core buildActivity). Read-only: nothing is written, no daemon is needed, nothing is sent to a peer. The logs are read from their
// end, a page at a time (activityLogs.ts): a log of tens of thousands of lines costs a few chunks, not a whole read.

/** The counts of the rows of each file, kept while the process lives: the daemon answers the next page without counting again. */
const sharedCountCache = createCountCache();

export interface ActivityView {
  initialized: true;
  ok: true;
  self: { uuid: string; name: string };
  /** Epoch seconds of the answer, so that a reader humanizes ages against the same clock. */
  now: number;
  page: ActivityPage;
  /** Where the sent runs are, and what was found there. */
  runLog: { dir: string; files: number; damagedLines: number; /** Files whose count was redone because they changed other than by appending. */ recounted: string[] };
  /** Damaged lines skipped in the audit log. */
  auditDamagedLines: number;
  /** Bytes read from disk for this answer, by why: the lines of the page, the pass that counts a filter, the totals cache. */
  readBytes: ActivityBytes;
  auditLogFile: string;
  auditLogPresent: boolean;
  /** The machines of the network and those seen in the logs, by name: the choices of a machine filter. */
  machines: string[];
}

export type ActivityAnswer =
  | { initialized: false; message: string }
  | { initialized: true; ok: false; reason: 'bad-query' | 'run-log-unreadable' | 'audit-log-unreadable'; message: string }
  | ActivityView;

export function activityAnswer(configDir: string, query: ActivityQueryText, nowSeconds: number, cache: CountCache = sharedCountCache): ActivityAnswer {
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

  const auditFile = auditLogFile(configDir);
  let logs;
  let page: ActivityPage;
  try {
    logs = openActivityLogs(configDir, cache, auditFile);
    page = buildActivity({ self: { uuid: self.uuid, name: self.name }, sources: logs.sources, nameOf: (uuid) => names.get(uuid), filter });
  } catch (e) {
    if (e instanceof ActivityRangeError) {
      const { message } = e;
      return { initialized: true, ok: false, reason: 'bad-query', message };
    }
    if (e instanceof ActivityReadError) {
      const { message, reason } = e;
      return { initialized: true, ok: false, reason, message };
    }
    throw e;
  }
  return {
    initialized: true,
    ok: true,
    self: { uuid: self.uuid, name: self.name },
    now: nowSeconds,
    page,
    runLog: { dir: runLogDir(configDir), files: logs.runLogFiles, damagedLines: page.damaged.sent, recounted: logs.notes },
    auditDamagedLines: page.damaged.received,
    readBytes: logs.bytes,
    auditLogFile: auditFile,
    auditLogPresent: logs.auditPresent,
    machines: [...new Set([...page.machines, ...directory.map((m) => m.name)])].sort((a, b) => a.localeCompare(b)),
  };
}

const QUERY_FIELDS = ['direction', 'machine', 'outcome', 'since', 'text', 'limit', 'offset', 'page', 'pageSize'] as const;

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
