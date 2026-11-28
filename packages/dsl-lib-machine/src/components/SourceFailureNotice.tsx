import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction, Card, Collapsible, HorizontalStack, Notice, Text, VerticalStack } from '@wadeck-app/dsl-ui';
import { cancelAdminLogin, readAdminLogin, startAdminLogin, type AdminLoginState } from '../lib/adminLoginFlow.js';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import { loadFailureView, SOURCE_SUBJECTS, type FailureView, type SourceError } from '../lib/loadFailure.js';
import { CommandNotice } from './CommandNotice.js';

// A failed source of a page, told by what it is (lib/loadFailure.ts, admin-ui.md "A failed source: three cases"): an internal error says so and copies its details; a
// missing admin relay token is a state to configure, with a button that logs in from the page; the relay that does not answer is the cause and Retry. A command is never
// the headline: it is folded in "Details" and copyable.

export interface SourceFailureNoticeProps {
  /** The key of the failed source (`candidacies`): names the route in "Copy details" and the thing that could not be loaded. */
  source?: string;
  /** What could not be loaded, as the object of "Could not load ..." ("the candidacies"). Default: the subject of the source. */
  subject?: string;
  error: SourceError;
  /** Loads the sources of the page again (`$refresh`). Without it there is no Retry: the sentence says to reload the page. */
  onRefresh?: () => Promise<void> | void;
  /** The module backend and the PIN (tests give a fake; the page uses the shell's). */
  api?: AllowApi;
  /** How often the login started from the page is read while it waits (tests shorten it). */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 3000;
const NOTICE_VARIANT = { info: 'info', warning: 'warning', danger: 'danger' } as const;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clock = (d: Date): string => d.toTimeString().slice(0, 8);

/** The failed source as ONE state: the sentence, the actions that fit its case, the whole message folded. */
export function SourceFailureNotice({ source, subject, error, onRefresh, api, pollMs = DEFAULT_POLL_MS }: SourceFailureNoticeProps) {
  const what = subject ?? (source === undefined ? 'the data' : (SOURCE_SUBJECTS[source] ?? `the data of "${source}"`));
  const view = loadFailureView(what, error, source);
  const [retrying, setRetrying] = useState(false);
  const [checked, setChecked] = useState<string | undefined>(undefined);
  const [retryProblem, setRetryProblem] = useState<string | undefined>(undefined);
  const [copyNote, setCopyNote] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  const copy = async (text: string, done: string): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) throw new Error('this browser gives the page no clipboard');
      await navigator.clipboard.writeText(text);
      setCopyNote({ ok: true, text: done });
    } catch (e) {
      setCopyNote({ ok: false, text: `Could not copy (${errorText(e)}): open Details and select the text.` });
    }
  };

  const retry = async (): Promise<void> => {
    if (onRefresh === undefined) return;
    setRetrying(true);
    setRetryProblem(undefined);
    try {
      await onRefresh();
      setChecked(clock(new Date()));
    } catch (e) {
      setRetryProblem(`Could not retry: ${errorText(e)}`);
    } finally {
      setRetrying(false);
    }
  };

  const isError = view.kind === 'internal' || view.kind === 'unexpected';
  // The command is the main action where the page cannot act itself; for the login case the button is, and the command stays in Details.
  const commandOutside = view.command !== undefined && !view.canLogin;

  return (
    <VerticalStack gap="gap-2">
      <CommandNotice variant={NOTICE_VARIANT[view.tone]} label={view.headline} />
      {view.canLogin && <AdminLoginPanel what={what} onRefresh={onRefresh} api={api} pollMs={pollMs} />}
      <HorizontalStack gap="gap-2" align="items-center" wrap>
        {onRefresh !== undefined && <ButtonAction label="Retry" variant="secondary" size="xs" loading={retrying} onClick={() => void retry()} />}
        {isError && <ButtonAction label="Copy details" variant="neutral" size="xs" onClick={() => void copy(view.copyText, 'Details copied.')} />}
        {commandOutside && <ButtonAction label="Copy command" variant="neutral" size="xs" onClick={() => void copy(view.command as string, 'Command copied.')} />}
      </HorizontalStack>
      {onRefresh === undefined && <Text tone="muted" size="sm" text="Reload the page to try again." />}
      {checked !== undefined && !retrying && <Text tone="muted" size="sm" text={`Checked again at ${checked}, still failing.`} />}
      {retryProblem !== undefined && <Notice variant="danger" label={retryProblem} />}
      {copyNote !== undefined && <Text tone={copyNote.ok ? 'success' : 'danger'} size="sm" text={copyNote.text} />}
      <Details view={view} onCopyCommand={view.canLogin && view.command !== undefined ? () => void copy(view.command as string, 'Command copied.') : undefined} />
    </VerticalStack>
  );
}

function Details({ view, onCopyCommand }: { view: FailureView; onCopyCommand: (() => void) | undefined }) {
  return (
    <Collapsible title="Details">
      <VerticalStack gap="gap-2">
        {view.command !== undefined && (
          <div className="break-all">
            <Text mono size="xs" text={view.command} />
          </div>
        )}
        {onCopyCommand !== undefined && <ButtonAction label="Copy command" variant="neutral" size="xs" onClick={onCopyCommand} />}
        <div className="break-words">
          <Text mono size="xs" text={view.details} />
        </div>
      </VerticalStack>
    </Collapsible>
  );
}

type Login =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; state: Extract<AdminLoginState, { state: 'waiting' }> }
  | { phase: 'approved' }
  | { phase: 'failed'; message: string };

const phaseOf = (state: AdminLoginState): Login => {
  switch (state.state) {
    case 'waiting':
      return { phase: 'waiting', state };
    case 'approved':
      return { phase: 'approved' };
    case 'failed':
      return { phase: 'failed', message: state.message };
    default:
      return { phase: 'idle' };
  }
};

/**
 * `machine admin login` from the page: the button asks the PIN, the daemon starts the login with the relay and answers the code; the admin compares it in the relay
 * console and confirms there (nothing is typed here); the panel follows the wait and reloads the sources when the token is saved.
 */
function AdminLoginPanel({ what, onRefresh, api, pollMs }: { what: string; onRefresh: SourceFailureNoticeProps['onRefresh']; api: AllowApi | undefined; pollMs: number }) {
  const shell = useRef<AllowApi | null>(null);
  shell.current ??= api ?? shellAllowApi();
  const backend = api ?? shell.current;
  const [login, setLogin] = useState<Login>({ phase: 'idle' });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const refreshed = useRef(false);

  // A login the daemon already holds (the page was reloaded while the admin was in the relay console) is shown at once.
  useEffect(() => {
    let alive = true;
    readAdminLogin(backend).then(
      (state) => {
        if (alive) setLogin(phaseOf(state));
      },
      (e: unknown) => {
        if (alive) setProblem(`Could not read the state of the login: ${errorText(e)}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [backend]);

  // While it waits: read the state of the daemon until the admin confirmed, denied or let it expire.
  const waiting = login.phase === 'waiting';
  useEffect(() => {
    if (!waiting) return undefined;
    let alive = true;
    const timer = setInterval(() => {
      readAdminLogin(backend).then(
        (state) => {
          if (!alive) return;
          setProblem(undefined);
          setLogin(phaseOf(state));
        },
        (e: unknown) => {
          if (alive) setProblem(`Could not read the state of the login: ${errorText(e)}`);
        },
      );
    }, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [waiting, backend, pollMs]);

  // The token is saved: the sources are loaded again, once (the failure goes away with them).
  useEffect(() => {
    if (login.phase !== 'approved' || refreshed.current) return;
    refreshed.current = true;
    void Promise.resolve(onRefresh?.()).catch((e: unknown) => setProblem(`Could not load ${what} again: ${errorText(e)}`));
  }, [login.phase, onRefresh, what]);

  const start = async (): Promise<void> => {
    setProblem(undefined);
    setLogin({ phase: 'starting' });
    try {
      setLogin(phaseOf(await startAdminLogin(backend)));
    } catch (e) {
      setLogin({ phase: 'idle' });
      setProblem(`Could not start the login: ${errorText(e)}`);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      setLogin(phaseOf(await cancelAdminLogin(backend)));
    } catch (e) {
      setProblem(`Could not cancel the login: ${errorText(e)}`);
    }
  };

  return (
    <VerticalStack gap="gap-2">
      {login.phase === 'waiting' && <WaitingCard state={login.state} />}
      {login.phase === 'approved' && <Notice variant="success" label={`Admin token saved. Loading ${what} again.`} />}
      {login.phase === 'failed' && <CommandNotice variant="danger" label={login.message} />}
      {problem !== undefined && <CommandNotice variant="danger" label={problem} />}
      <HorizontalStack gap="gap-2" align="items-center" wrap>
        {(login.phase === 'idle' || login.phase === 'starting') && <ButtonAction label="Log in to the relay" variant="primary" size="sm" loading={login.phase === 'starting'} onClick={() => void start()} />}
        {login.phase === 'failed' && <ButtonAction label="Try again" variant="primary" size="sm" onClick={() => void start()} />}
        {login.phase === 'waiting' && <ButtonAction label="Cancel" variant="secondary" size="sm" onClick={() => void cancel()} />}
      </HorizontalStack>
    </VerticalStack>
  );
}

function WaitingCard({ state }: { state: Extract<AdminLoginState, { state: 'waiting' }> }) {
  const minutes = Math.max(1, Math.ceil((state.expiresAt - Date.now() / 1000) / 60));
  return (
    <Card padding="sm">
      <VerticalStack gap="gap-1">
        <Text size="sm" text="Code to compare in the relay console:" />
        <Text mono text={state.userCode} />
        <Text size="sm" text={state.consoleHint} />
        <Text size="sm" text={`Relay page: ${state.verificationUrl}`} />
        <Text tone="muted" size="sm" text={`Waiting for your confirmation in the relay console. Code lives about ${minutes} min.`} />
      </VerticalStack>
    </Card>
  );
}
