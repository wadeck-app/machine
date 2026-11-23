import { newRequestsListBody, signRequestsList } from '@wadeck-app/machine-webcrypto';
import { trackSigning, withAdminKey, type AllowApi } from './allowFlow.js';

// The requests of the OTHER machines on the Requests page (decision 74), without React. Only the admin machine can ask a peer: the request is signed with
// the ADMIN key, here, in the browser, one document per peer (each names its target). The passphrase is a parameter of `fetchRemoteRequests` only: never
// stored, logged or sent; the unlocked key is non-extractable and locked again before anything goes to the network. The module backend and the daemon only forward.
//
//   1. elevate    (PIN of app-core, before the passphrase is asked)
//   2. key file   (sensitive GET: the ENCRYPTED file), unlock with the passphrase
//   3. sign       one read-only `requests-list` per peer, then lock
//   4. post       (sensitive POST /requests/remote, one per peer) -> the rows of that peer, or the reason it could not answer

/** Groups asked of each peer (the peer answers at most 100). */
const GROUPS_ASKED = 50;

/** What the backend answers for one peer (backend remoteRequestsPage): only the fields this page reads are checked. */
export interface RemotePage {
  machine: { uuid: string; name: string };
  policyMode: 'admin' | 'local';
  allow: { available: boolean; machine: { uuid: string; name: string }; note: string };
  count: number;
  waiting: Array<{ id: string; peerText: string; peer: string; shell: string; command: string; secondsLeft: number; askedText: string; askedSecondsAgo?: number; countText: string; nextCommand: string; nextWhere: string }>;
  denyNote: string;
  pending: Array<{ peerText: string; peer: string; shell: string; command: string; countText: string; firstSeenText: string; lastSeenText: string; nextCommand: string; nextWhere: string }>;
  pendingTotal: number;
  chainOk: boolean;
  chainText: string;
  notes: string[];
}

export interface RemotePeer {
  uuid: string;
  name: string;
}

export type RemoteOutcome = { peer: RemotePeer; ok: true; page: RemotePage } | { peer: RemotePeer; ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function asPage(raw: unknown): RemotePage {
  if (!isObject(raw) || !Array.isArray(raw['waiting']) || !Array.isArray(raw['pending']) || !isObject(raw['machine']) || !isObject(raw['allow'])) {
    throw new Error('the module backend sent an unexpected answer for the requests of a peer: the page and the module are not the same version: update the machine module (`app-core-cli update`) and reload the page');
  }
  return raw as unknown as RemotePage;
}

/** The PIN, asked before the passphrase form is shown (the same order as the Allow button). Rejects when it is cancelled. */
export function elevateForRemote(api: AllowApi): Promise<void> {
  return api.elevate();
}

export function fetchRemoteRequests(api: AllowApi, input: { selfUuid: string; peers: RemotePeer[]; passphrase: string | null; now: number }): Promise<RemoteOutcome[]> {
  return trackSigning(() => fetchRemoteRequestsNow(api, input));
}

async function fetchRemoteRequestsNow(api: AllowApi, input: { selfUuid: string; peers: RemotePeer[]; passphrase: string | null; now: number }): Promise<RemoteOutcome[]> {
  if (input.peers.length === 0) {
    throw new Error('there is no other trusted machine to ask: see the Machines page, or `machine list`');
  }
  const requests: Array<{ peer: RemotePeer; request: unknown }> = [];
  // Passphrase null: the key held in this page (decision 92). Otherwise unlocked here, kept for the chosen idle time or locked before anything goes to the network.
  await withAdminKey(api, input.passphrase, async (key) => {
    for (const peer of input.peers) {
      requests.push({ peer, request: await signRequestsList(newRequestsListBody({ source: input.selfUuid, target: peer.uuid, limit: GROUPS_ASKED, now: input.now }), key.privateKey) });
    }
  });
  const outcomes: RemoteOutcome[] = [];
  for (const { peer, request } of requests) {
    try {
      outcomes.push({ peer, ok: true, page: asPage(await api.post('/requests/remote', { machine: peer.uuid, request })) });
    } catch (e) {
      outcomes.push({ peer, ok: false, message: (e as Error).message });
    }
  }
  return outcomes;
}
