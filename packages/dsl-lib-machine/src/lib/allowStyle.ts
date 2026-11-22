// How the Requests page asks to allow: in a confirmation `dialog`, or `inline` in the card (no modal). The choice is the person's, kept in this
// browser (localStorage, key scoped to the module). Never silent: an unreadable or foreign value, or a storage that refuses, is reported.

export type AllowStyle = 'dialog' | 'inline';

export const ALLOW_STYLE_KEY = 'machine:requests:allowStyle';
export const DEFAULT_ALLOW_STYLE: AllowStyle = 'inline';

/** The part of `Storage` this uses. */
export interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readAllowStyle(storage: StyleStorage): { style: AllowStyle; problem?: string } {
  let raw: string | null;
  try {
    raw = storage.getItem(ALLOW_STYLE_KEY);
  } catch (e) {
    return { style: DEFAULT_ALLOW_STYLE, problem: `the browser storage cannot be read (${(e as Error).message}): the Allow style is ${DEFAULT_ALLOW_STYLE} and is not remembered` };
  }
  if (raw === null) {
    return { style: DEFAULT_ALLOW_STYLE };
  }
  if (raw === 'dialog' || raw === 'inline') {
    return { style: raw };
  }
  return { style: DEFAULT_ALLOW_STYLE, problem: `the stored Allow style "${raw.slice(0, 20)}" is not Dialog or Inline: ${DEFAULT_ALLOW_STYLE} is used; pick one to replace it` };
}

/** Undefined when stored; else the sentence to show. */
export function writeAllowStyle(storage: StyleStorage, style: AllowStyle): string | undefined {
  try {
    storage.setItem(ALLOW_STYLE_KEY, style);
    return undefined;
  } catch (e) {
    return `the browser storage refused the choice (${(e as Error).message}): the Allow style is kept for this page only`;
  }
}
