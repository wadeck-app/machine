// Safer mode of the Requests page (decision 98): OFF by default, Allow signs in one click for every lifetime when the admin key is unlocked. ON, a flagged
// lifetime needs a second click. A UI preference (not a secret), kept in this browser like the Allow style. Never silent: an unreadable or foreign value, or a
// storage that refuses, is reported.

import type { StyleStorage } from './allowStyle.js';

export const SAFER_MODE_KEY = 'machine:requests:saferMode';
export const DEFAULT_SAFER_MODE = false;

export function readSaferMode(storage: StyleStorage): { on: boolean; problem?: string } {
  let raw: string | null;
  try {
    raw = storage.getItem(SAFER_MODE_KEY);
  } catch (e) {
    return { on: DEFAULT_SAFER_MODE, problem: `the browser storage cannot be read (${(e as Error).message}): Safer mode is off and is not remembered` };
  }
  if (raw === null) {
    return { on: DEFAULT_SAFER_MODE };
  }
  if (raw === 'on' || raw === 'off') {
    return { on: raw === 'on' };
  }
  return { on: DEFAULT_SAFER_MODE, problem: `the stored Safer mode "${raw.slice(0, 20)}" is not on or off: off is used; switch it to replace it` };
}

/** Undefined when stored; else the sentence to show. */
export function writeSaferMode(storage: StyleStorage, on: boolean): string | undefined {
  try {
    storage.setItem(SAFER_MODE_KEY, on ? 'on' : 'off');
    return undefined;
  } catch (e) {
    return `the browser storage refused the choice (${(e as Error).message}): Safer mode is kept for this page only`;
  }
}
