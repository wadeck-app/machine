import { useCallback, useState } from 'react';
import { DEFAULT_SAFER_MODE, readSaferMode, writeSaferMode } from '../lib/saferMode.js';

// Safer mode of the Requests page, kept in the browser storage. Never silent: what the storage cannot do is a `problem` line.

export function useSaferMode(): { on: boolean; problem: string | undefined; choose: (on: boolean) => void } {
  const [state, setState] = useState<{ on: boolean; problem?: string | undefined }>(() => {
    try {
      return readSaferMode(window.localStorage);
    } catch (e) {
      return { on: DEFAULT_SAFER_MODE, problem: `the browser storage is not available (${(e as Error).message}): Safer mode is off and is not remembered` };
    }
  });
  const choose = useCallback((on: boolean) => {
    let problem: string | undefined;
    try {
      problem = writeSaferMode(window.localStorage, on);
    } catch (e) {
      problem = `the browser storage is not available (${(e as Error).message}): Safer mode is kept for this page only`;
    }
    setState({ on, problem });
  }, []);
  return { on: state.on, problem: state.problem, choose };
}
