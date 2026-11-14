import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAddressRecord, verifyAddressRecord, type AddressEntry, type SignedAddressRecord } from '@wadeck-app/machine-core';
import type { AdvertisedAddresses } from './addressDiscovery.js';
import { writeFileAtomic } from './fsutil.js';
import type { MachineIdentity } from './identity.js';
import { BoundedSet } from './inboxLoop.js';
import { SECRETS_DIRNAME } from './paths.js';
import { RelayError, type RelayClient } from './relayClient.js';

// Publication of the signed address record of this machine (relay-api.md "Machines resource", threat T-33). The daemon calls `tick()` from the
// ONE timer of the inbox loop (the heartbeat), so there is no second timer. A tick publishes when nothing was published yet, when the address
// set changed, or when the record is older than a week (peers ignore a record older than 30 days). It never throws: the relay is untrusted
// and may be down; every distinct problem is said once.
//
// The seq counter lives in <configDir>/_secrets_/address-state.json and is written BEFORE the record is signed: a crash, a failed PUT or a
// lost answer never lets a seq be used twice. A failed PUT is retried with the very same record (no seq burned). When the file is lost
// the daemon continues after the seq of the record the relay holds, if that record is signed by this machine.

/** A record is published again after this long without a change, well before the 30 days after which peers ignore it. */
export const REFRESH_SECONDS = 7 * 86_400;
const MIN_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 600;
const MAX_RETRY_AFTER_SECONDS = 3600;

export const addressStateFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'address-state.json');

export interface AddressPublisherOptions {
  configDir: string;
  self: MachineIdentity;
  /** Client with the token of THIS machine (relay.json). */
  client: RelayClient;
  /** Epoch seconds. */
  now: () => number;
  log: (line: string) => void;
  /** What to publish now (asked at every tick: the interfaces may change). */
  addresses: () => AdvertisedAddresses;
  /** Only an enrolled machine publishes: peers verify the record against its registration, and the inbox needs it. */
  isEnrolled: () => boolean;
}

export interface AddressPublisher {
  /** One look at the address set and, when needed, one publication. Never throws. */
  tick(): Promise<void>;
  /** What was last published successfully by this process. */
  current(): { seq: number; addresses: AddressEntry[] } | undefined;
}

/** Printable ASCII only and bounded: text that came from the relay never reaches a log raw. */
const safe = (text: string, max = 600): string => text.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

function readSeq(configDir: string): number {
  const file = addressStateFile(configDir);
  if (!existsSync(file)) return 0;
  const corrupt = (why: string) =>
    new Error(
      `${file} is corrupt or invalid (${why}): it holds the counter of the address record, which must never go back. Delete it to start again: this machine then continues after the seq of the record the relay holds, and the record is published as soon as it is fixed`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw corrupt('not valid JSON');
  }
  const o = raw as { v?: unknown; seq?: unknown } | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o) || o.v !== 1 || typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || o.seq < 0) throw corrupt('unexpected shape');
  return o.seq;
}

const describe = (addresses: AddressEntry[]): string => addresses.map((a) => (a.host.includes(':') ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`)).join(', ');

export function createAddressPublisher(o: AddressPublisherOptions): AddressPublisher {
  const uuid = o.self.uuid;
  const registered = { uuid, identityPublicKey: o.self.identity.publicKey };
  // Errors of the relay: said once, forgotten at the next success so that a later outage is said again.
  const warned = new BoundedSet();
  const noticed = new Set<string>();
  let published: { key: string; issuedAt: number; seq: number; addresses: AddressEntry[] } | undefined;
  let pending: { key: string; record: SignedAddressRecord } | undefined;
  // What the relay holds for this machine, learned by one GET (at the first publication, and after a 412).
  let knowsRelay = false;
  let etag: string | undefined;
  let relaySeq = 0;
  let failures = 0;
  let blockedUntil = 0;
  let notOwner = false;

  const notice = (key: string, line: string): void => {
    if (noticed.has(key)) return;
    noticed.add(key);
    o.log(line);
  };
  const warnOnce = (message: string): void => {
    if (warned.add(message)) o.log(`address record: ${safe(message)}`);
  };

  /** Reads what the relay holds: the etag to send, and the seq to continue after (only when the record is signed by THIS machine). */
  const refresh = async (): Promise<void> => {
    const entry = await o.client.getMachine(uuid);
    knowsRelay = true;
    if (entry === undefined) {
      etag = undefined;
      relaySeq = 0;
      return;
    }
    etag = entry.etag;
    // The relay cannot make this machine skip numbers: only a record that verifies with the own identity key counts. The date is not checked (an old record still tells the counter).
    const issuedAt = (entry.record as { body?: { issuedAt?: unknown } } | undefined)?.body?.issuedAt;
    const checked = typeof issuedAt === 'number' ? verifyAddressRecord(entry.record, registered, issuedAt) : undefined;
    if (checked?.ok) {
      relaySeq = checked.body.seq;
    } else {
      relaySeq = 0;
      notice('foreign-record', 'address record: the relay holds a record for this machine that was not signed by this machine (or is malformed): it is replaced by a new one');
    }
  };

  const recordFor = (key: string, addresses: AddressEntry[]): SignedAddressRecord => {
    if (pending !== undefined && pending.key === key && pending.record.body.seq > relaySeq) return pending.record;
    // Above the clock too: a lost state starts above anything this machine ever published (a seq never exceeds the time of its
    // publication, publications being far rarer than one per second), so peers, which keep the highest seq they saw, accept the new record.
    const seq = Math.max(readSeq(o.configDir), relaySeq, o.now()) + 1;
    if (!Number.isSafeInteger(seq)) throw new Error('the address record counter is out of range: delete address-state.json and contact the relay owner');
    // Built (and size checked) first: a record that cannot be built burns no seq. The seq is written BEFORE the PUT, so it is never used twice.
    const record = buildAddressRecord({ uuid, addresses, seq, issuedAt: o.now() }, o.self.identity.privateKeyPkcs8);
    writeFileAtomic(addressStateFile(o.configDir), `${JSON.stringify({ v: 1, seq })}\n`, 0o600);
    pending = { key, record };
    return record;
  };

  const send = async (key: string, addresses: AddressEntry[]): Promise<void> => {
    // A damaged counter stops everything before the relay is asked anything.
    readSeq(o.configDir);
    if (!knowsRelay) await refresh();
    for (let attempt = 0; ; attempt++) {
      const record = recordFor(key, addresses);
      try {
        const result = await o.client.putRecord(uuid, record, etag);
        etag = result.etag;
        relaySeq = record.body.seq;
        pending = undefined;
        published = { key, issuedAt: record.body.issuedAt, seq: record.body.seq, addresses };
        return;
      } catch (e) {
        // The record changed on the relay since this machine last looked: read it again and try once more.
        if (e instanceof RelayError && e.status === 412 && attempt === 0) {
          await refresh();
          continue;
        }
        throw e;
      }
    }
  };

  const backoff = (message: string, retryAfterSeconds?: number): void => {
    failures++;
    const delay = retryAfterSeconds !== undefined ? Math.min(Math.max(retryAfterSeconds, 1), MAX_RETRY_AFTER_SECONDS) : Math.min(MIN_BACKOFF_SECONDS * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);
    blockedUntil = o.now() + delay;
    warnOnce(message);
  };

  const tick = async (): Promise<void> => {
    if (!o.isEnrolled()) {
      notice('not-enrolled', 'address record: not published yet because this machine is not enrolled (no admin key pinned): finish `machine join`; it is published as soon as this machine is enrolled');
      return;
    }
    const wanted = o.addresses();
    if (wanted.warning !== undefined && !noticed.has(`warning:${wanted.warning}`)) {
      noticed.add(`warning:${wanted.warning}`);
      o.log(`address record: WARNING: ${safe(wanted.warning)}`);
    }
    if (wanted.addresses.length === 0) {
      const problem = wanted.problem ?? 'there is no address to publish';
      if (warned.add(`none:${problem}`)) o.log(`address record NOT published: ${safe(problem)}. The record already on the relay, if any, is left as it is`);
      return;
    }
    const key = JSON.stringify(wanted.addresses);
    const due = published === undefined || published.key !== key || o.now() - published.issuedAt >= REFRESH_SECONDS;
    if (!due || o.now() < blockedUntil) return;
    try {
      await send(key, wanted.addresses);
    } catch (e) {
      if (e instanceof RelayError && e.status === 403 && e.code === 'not_owner') {
        // A state, not an outage: no backoff, so that the machine recovers by itself once the admin removed the old record.
        notOwner = true;
        failures = 0;
        blockedUntil = 0;
        notice('not-owner', `address record NOT published: ${safe(e.message)}`);
        return;
      }
      backoff(e instanceof RelayError ? e.message : `cannot publish the address record: ${(e as Error).message}`, e instanceof RelayError ? e.retryAfterSeconds : undefined);
      return;
    }
    failures = 0;
    blockedUntil = 0;
    if (notOwner) {
      notOwner = false;
      noticed.delete('not-owner');
      o.log('address record: this machine owns its address record again');
    }
    if (warned.size > 0) {
      warned.clear();
      o.log('address record: the relay is working again');
    }
    const done = published as NonNullable<typeof published>;
    o.log(`address record published (seq ${done.seq}): ${describe(done.addresses)}`);
  };

  return {
    tick: async () => {
      try {
        await tick();
      } catch (e) {
        // Last resort: the heartbeat that called this must go on.
        warnOnce(`unexpected error: ${(e as Error).message}`);
      }
    },
    current: () => (published === undefined ? undefined : { seq: published.seq, addresses: published.addresses }),
  };
}
