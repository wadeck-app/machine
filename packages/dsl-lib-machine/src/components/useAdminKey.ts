import { useSyncExternalStore } from 'react';
import { adminKeyHolder, type HolderSnapshot } from '../lib/adminKeyHolder.js';

/** The state of the held admin key (decision 92): re-renders on unlock, lock, expiry and a change of the "Keep unlocked for" choice. Never gives the key. */
export function useAdminKey(): HolderSnapshot {
  return useSyncExternalStore(adminKeyHolder.subscribe, adminKeyHolder.snapshot);
}
