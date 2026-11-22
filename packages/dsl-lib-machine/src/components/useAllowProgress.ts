import { useCallback, useEffect, useRef, useState } from 'react';
import type { AllowApi } from '../lib/allowFlow.js';
import { initialProgress, reduceProgress, startHoldPolling, type ProgressEvent, type ProgressRecord } from '../lib/allowProgress.js';
import type { AllowDialogEvent } from './AllowDialog.js';

// The progress of every Allow made from the page (decision 86): one record per request, driven by the events of the dialog (signature, answer of the
// daemon) and by the 2 s polling of the end of the hold. Kept here, not in the dialog, so closing the dialog does not stop it.

export interface ProgressEntry<R> {
  /** The row as it was when Allow was clicked: the card stays even when the request leaves the list of held requests. */
  row: R;
  record: ProgressRecord;
}

export interface AllowProgressState<R> {
  entries: Record<string, ProgressEntry<R>>;
  /** Epoch milliseconds, ticking every second while a progress is not finished. */
  now: number;
  handle: (row: R, target: { uuid: string; name: string }, machineRef: string, event: AllowDialogEvent) => void;
  dismiss: (id: string) => void;
}

export function useAllowProgress<R extends { id: string }>(api: AllowApi | null): AllowProgressState<R> {
  const [entries, setEntries] = useState<Record<string, ProgressEntry<R>>>({});
  const [now, setNow] = useState(() => Date.now());
  const stops = useRef(new Map<string, () => void>());
  const apiRef = useRef(api);
  apiRef.current = api;

  const unfinished = Object.values(entries).some((e) => e.record.finishedAt === undefined);
  useEffect(() => {
    if (!unfinished) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [unfinished]);

  useEffect(
    () => () => {
      stops.current.forEach((stop) => stop());
      stops.current.clear();
    },
    [],
  );

  const dispatch = useCallback((id: string, event: ProgressEvent) => {
    setEntries((prev) => {
      const entry = prev[id];
      return entry === undefined ? prev : { ...prev, [id]: { ...entry, record: reduceProgress(entry.record, event, Date.now()) } };
    });
  }, []);

  const stopPolling = useCallback((id: string) => {
    stops.current.get(id)?.();
    stops.current.delete(id);
  }, []);

  const handle = useCallback(
    (row: R, target: { uuid: string; name: string }, machineRef: string, event: AllowDialogEvent) => {
      if (event.type === 'start') {
        stopPolling(row.id);
        setEntries((prev) => ({ ...prev, [row.id]: { row, record: initialProgress({ machineName: target.name, held: true, now: Date.now() }) } }));
        return;
      }
      // A failure stays on the card (`failed`: the cause and Allow again): the entry is not removed.
      dispatch(row.id, event);
      if (event.type === 'result' && apiRef.current !== null) {
        const current = apiRef.current;
        stops.current.set(
          row.id,
          startHoldPolling({ get: (path) => current.get(path), machine: machineRef, id: row.id, now: () => Date.now(), onEvent: (e) => dispatch(row.id, e) }),
        );
      }
    },
    [dispatch, stopPolling],
  );

  const dismiss = useCallback(
    (id: string) => {
      stopPolling(id);
      setEntries((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    },
    [stopPolling],
  );

  return { entries, now, handle, dismiss };
}
