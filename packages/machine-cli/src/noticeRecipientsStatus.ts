import { existsSync } from 'node:fs';
import { adminPinFile, readAdminPin } from './admin.js';
import { loadNetwork } from './network.js';
import { readNoticeRecipients } from './noticeRecipientsStore.js';

// The line of `machine status` about request notices (request-notices.md): who receives them, or why nobody does. A missing list is never silent.

export interface NoticeRecipientsStatus {
  /** `none`: no list stored here; `listed`: a verified list (possibly empty); `error`: the stored list cannot be used. */
  state: 'none' | 'listed' | 'error';
  recipients: Array<{ uuid: string; name: string }>;
  /** The line of `machine status`, with its `[warn]` prefix when something must be done. */
  line: string;
}

/**
 * Undefined when this machine has no pinned admin key: nobody can send it a list, `machine status` already says it is not enrolled.
 * Local files only (no daemon, no network), so an older daemon cannot make it wrong.
 */
export function noticeRecipientsStatus(configDir: string, self: { uuid: string; name: string }, now: number): NoticeRecipientsStatus | undefined {
  if (!existsSync(adminPinFile(configDir))) {
    return undefined;
  }
  try {
    const signed = readNoticeRecipients(configDir, readAdminPin(configDir).adminPublicKey);
    if (signed === undefined) {
      return {
        state: 'none',
        recipients: [],
        line: `[warn] request notices: no recipient list yet, so this machine tells nobody about held or refused requests: run \`machine admin distribute ${self.name}\` on the admin machine`,
      };
    }
    const directory = loadNetwork(configDir, now).directory;
    const recipients = signed.body.recipients.map((uuid) => ({ uuid, name: uuid === self.uuid ? self.name : (directory.find(uuid)?.name ?? uuid) }));
    const named = signed.body.recipients.map((uuid) => (uuid === self.uuid ? `${self.name} (this machine)` : (directory.find(uuid)?.name ?? `${uuid} (not a trusted peer of this machine)`)));
    return {
      state: 'listed',
      recipients,
      line: named.length === 0 ? 'request notices: nobody (the list is empty: `machine admin notify-to <machine>...` on the admin machine chooses who is told)' : `request notices: sent to ${named.join(', ')}`,
    };
  } catch (e) {
    // A damaged list or pin: said with the file and the fix (the message of the reader), the rest of `status` stays readable.
    return { state: 'error', recipients: [], line: `[warn] request notices: ${(e as Error).message}` };
  }
}
