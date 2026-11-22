import { useCallback, useState } from 'react';
import { DEFAULT_ALLOW_STYLE, readAllowStyle, writeAllowStyle, type AllowStyle, type StyleStorage } from '../lib/allowStyle.js';

// The Allow style of the Requests page (Dialog | Inline), kept in the browser storage. Never silent: what the storage cannot do is a `problem` line.

/** The storage of the browser; reading the property itself can throw (storage blocked by the browser settings). */
function browserStorage(): { storage: StyleStorage } | { problem: string } {
  try {
    return { storage: window.localStorage };
  } catch (e) {
    return { problem: `the browser storage is not available (${(e as Error).message}): the Allow style is ${DEFAULT_ALLOW_STYLE} and is not remembered` };
  }
}

export function useAllowStyle(): { style: AllowStyle; problem: string | undefined; choose: (style: AllowStyle) => void } {
  const [state, setState] = useState<{ style: AllowStyle; problem?: string | undefined }>(() => {
    const found = browserStorage();
    return 'problem' in found ? { style: DEFAULT_ALLOW_STYLE, problem: found.problem } : readAllowStyle(found.storage);
  });
  const choose = useCallback((style: AllowStyle) => {
    const found = browserStorage();
    const problem = 'problem' in found ? found.problem : writeAllowStyle(found.storage, style);
    setState({ style, problem });
  }, []);
  return { style: state.style, problem: state.problem, choose };
}
