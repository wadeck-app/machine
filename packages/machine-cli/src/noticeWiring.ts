import { existsSync } from 'node:fs';
import { adminPinFile, readAdminPin } from './admin.js';
import { readConnections } from './connectionsStore.js';
import type { MachineIdentity } from './identity.js';
import { pinnedOf } from './cliWake.js';
import { readNoticeRecipients } from './noticeRecipientsStore.js';
import { recordNotice, recordNoticeEnd } from './noticesStore.js';
import { connectToTarget, resolvePeerTarget } from './peerConnect.js';
import type { NoticeStoreDeps } from './peerService.js';
import type { NotifierSession } from './requestNotifier.js';
import type { PeerToReach } from './peerConnect.js';

// What the daemon plugs into the peer service for request notices (request-notices.md): the store of the notices it receives, and the three
// things the notifier needs to tell the recipients (their uuids, a connection, nothing else). Thin: the rules are in the peer service and the notifier.

/** Per address, as `machine run` (a recipient that does not answer within this is unreachable). */
export const NOTICE_CONNECT_MS = 3000;

export function makeNoticeStoreDeps(configDir: string): NoticeStoreDeps {
  return {
    record: (notice, now) => recordNotice(configDir, notice, now),
    end: (machine, id, now) => recordNoticeEnd(configDir, machine, id, now),
  };
}

/** The recipients of the signed list, undefined when this machine holds none (or is not enrolled). A damaged list or pin throws with its fix. */
export function makeNoticeRecipients(configDir: string): () => string[] | undefined {
  return () => {
    if (!existsSync(adminPinFile(configDir))) {
      return undefined;
    }
    return readNoticeRecipients(configDir, readAdminPin(configDir).adminPublicKey)?.body.recipients;
  };
}

/** The connection of `machine run`: pinned addresses, else the signed address record of the relay, then the pinned mutual-TLS channel. */
export function makeNoticeConnect(configDir: string, self: MachineIdentity, now: () => number, allowLocal: boolean): (peer: PeerToReach) => Promise<NotifierSession> {
  return async (peer) => {
    let target;
    try {
      const connection = readConnections(configDir).peers[peer.peerId];
      target = await resolvePeerTarget(configDir, peer, { pinned: pinnedOf(connection), now: now(), allowLocal, warn: () => undefined });
    } catch (e) {
      throw new Error(`address lookup failed for ${peer.name}: ${(e as Error).message}`);
    }
    const { session } = await connectToTarget(self.identity, peer, target, undefined, NOTICE_CONNECT_MS);
    return session;
  };
}
