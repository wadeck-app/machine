import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AllowApi } from '../lib/allowFlow.js';
import { SourceFailureNotice } from './SourceFailureNotice.js';

// A failed source of a page, told by what it is (loadFailure.ts): the three cases of the UX requirement. Case 1 (internal): says so, Copy details, no command. Case 2 (not
// configured): a to-configure state with a button that logs in from the page, shows the code to compare, follows the wait and reloads the sources when done. Case 3
// (external): the cause and Retry. A command is never the headline: it is folded in "Details", and copyable where the page cannot act.

const NO_TOKEN = 'this machine holds no admin relay token (no /home/u/.config/machine/_secrets_/relay-admin.json): approving a machine needs the admin relay token (limited to machine rights, it cannot manage tokens). Run `machine admin login` and confirm the request in the relay console (Tokens page); or with a pairing code: then run `machine admin login <code>`';
const RELAY_502 = 'the relay is unreachable at https://relay.example.net (fetch failed): check the network and that the relay runs';
const WAITING = { ok: true, state: 'waiting', userCode: 'ADMN-7K42', verificationUrl: 'https://relay.example.net/console', label: 'desk admin', relayUrl: 'https://relay.example.net', expiresAt: Math.floor(Date.now() / 1000) + 290, consoleHint: 'In the relay console open Tokens: the request "desk admin" is listed there, marked MACHINE ADMIN. Compare its code with the one above, then approve.' };

let written: string[];
let clipboardFails: boolean;

beforeEach(() => {
  written = [];
  clipboardFails = false;
});

// userEvent.setup() installs a clipboard stub of its own: ours replaces it AFTER, so the test sees what the page copied.
function setup() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboardFails) throw new Error('permission denied');
        written.push(text);
      },
    },
  });
  return user;
}

interface FakeApi extends AllowApi {
  calls: string[];
  elevate: Mock<() => Promise<void>>;
}

/** A module backend whose login state is what `states` says, one entry per read (the last one repeats). */
function fakeApi(o: { states?: unknown[]; start?: unknown | Error; cancel?: unknown } = {}): FakeApi {
  const calls: string[] = [];
  const states = [...(o.states ?? [{ ok: true, state: 'idle' }])];
  const next = (): unknown => (states.length > 1 ? states.shift() : states[0]);
  return {
    calls,
    elevate: vi.fn(async () => undefined),
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return next();
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      if (path === '/admin-login/cancel') return o.cancel ?? { ok: true, state: 'idle' };
      if (o.start instanceof Error) throw o.start;
      return o.start ?? WAITING;
    },
  };
}

describe('case 1, internal error', () => {
  const error = { message: 'Cannot read properties of undefined', status: 500 };

  it('says it is an internal error, offers Retry and Copy details, and asks for no command', () => {
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={async () => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Internal error: the candidacies could not be loaded because of a bug in this page or in the module (HTTP 500).');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy command|Log in/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/machine admin|Run `/);
  });

  it('Copy details copies the cause, the route and the status, and says it did', async () => {
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={async () => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('Message: Cannot read properties of undefined');
    expect(written[0]).toContain('Route: GET /api/modules/machine/candidacies');
    expect(written[0]).toContain('HTTP status: 500');
    expect(await screen.findByText('Details copied.')).toBeInTheDocument();
  });

  it('a clipboard that refuses is said, with what to do (the whole message is in Details)', async () => {
    clipboardFails = true;
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={async () => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(await screen.findByText(/Could not copy \(permission denied\): open Details and select the text\./)).toBeInTheDocument();
  });

  it('Retry reloads the sources of the page, says it checked again, and the button is busy meanwhile', async () => {
    const user = setup();
    let finish: () => void = () => undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={onRefresh} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Checked again/)).toBeNull();
    finish();
    expect(await screen.findByText(/Checked again at \d\d:\d\d:\d\d, still failing\./)).toBeInTheDocument();
  });

  it('a Retry that throws is said, not swallowed', async () => {
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={async () => { throw new Error('refresh exploded'); }} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Could not retry: refresh exploded/)).toBeInTheDocument();
  });

  it('without a way to reload (no onRefresh), there is no dead button: the sentence says to reload the page', () => {
    render(<SourceFailureNotice source="candidacies" error={error} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('Reload the page to try again.')).toBeInTheDocument();
  });

  it('the whole message and the status are folded in Details', async () => {
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={async () => undefined} />);
    expect(screen.queryByText('HTTP 500: Cannot read properties of undefined')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('HTTP 500: Cannot read properties of undefined')).toBeInTheDocument();
  });
});

describe('case 3, external: the relay does not answer', () => {
  it('the cause and Retry; nothing about a command, no Copy details, no login', () => {
    render(<SourceFailureNotice source="candidacies" error={{ message: RELAY_502, status: 502 }} onRefresh={async () => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the candidacies: the relay is unreachable at https://relay.example.net. Check the network and that the relay runs.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy|Log in/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/`|machine admin|Run /);
  });
});

describe('case 2, not configured: no admin relay token', () => {
  it('is a to-configure state (not an alert), the button is the action, the command is folded in Details', async () => {
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={fakeApi()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByText('To see the candidacies, this machine needs an admin relay token. It has none yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to the relay' })).toBeInTheDocument();
    expect(screen.queryByText(/machine admin login/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /Details/ }));
    // The same command, for a terminal, is there for whoever prefers it (and can be copied).
    expect(screen.getAllByText(/machine admin login/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });

  it('the button asks the PIN, starts the login through the module, and shows the code to compare, where to confirm and how long it lives', async () => {
    const user = setup();
    const api = fakeApi();
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} pollMs={20} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    expect(await screen.findByText('ADMN-7K42')).toBeInTheDocument();
    expect(api.elevate).toHaveBeenCalled();
    expect(api.calls).toContain('POST /admin-login');
    expect(screen.getByText(/In the relay console open Tokens/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/relay\.example\.net\/console/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for your confirmation in the relay console/)).toBeInTheDocument();
    expect(screen.getByText(/Code lives about \d min/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in to the relay' })).toBeNull();
  });

  it('follows the wait: when the admin confirmed, it says the token is saved and reloads the sources (once)', async () => {
    const user = setup();
    const onRefresh = vi.fn(async () => undefined);
    const api = fakeApi({ states: [{ ok: true, state: 'idle' }, WAITING, { ok: true, state: 'approved', label: 'desk admin', scopes: ['machine-admin'] }] });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={onRefresh} api={api} pollMs={20} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    expect(await screen.findByText(/Admin token saved/)).toBeInTheDocument();
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('the relay console address is a link that opens in a new tab without giving the page to the console (UX review 4)', async () => {
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={fakeApi()} pollMs={20} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    const link = await screen.findByRole('link', { name: 'https://relay.example.net/console' });
    expect(link).toHaveAttribute('href', 'https://relay.example.net/console');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('an address that is not http(s) is never a link (a javascript: address from the daemon would run in the page): it is shown as text', async () => {
    const user = setup();
    const api = fakeApi({ start: { ...WAITING, verificationUrl: 'javascript:alert(1)' } });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} pollMs={20} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    expect(await screen.findByText(/javascript:alert[(]1[)]/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a denied or expired request is said with its cause, and the button starts a new one', async () => {
    const user = setup();
    const api = fakeApi({ states: [{ ok: true, state: 'idle' }, WAITING, { ok: true, state: 'failed', message: 'the request was denied in the relay console: nothing was stored' }] });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} pollMs={20} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    expect(await screen.findByText(/the request was denied in the relay console: nothing was stored/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a refusal of the daemon (relay down, no relay joined) is shown with its sentence, and the page stays usable', async () => {
    const user = setup();
    const api = fakeApi({ start: new Error('the relay is unreachable at https://relay.example.net (fetch failed): check the network') });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    expect(await screen.findByText(/Could not start the login: the relay is unreachable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to the relay' })).toBeInTheDocument();
  });

  it('a PIN that is cancelled says so and starts nothing', async () => {
    const user = setup();
    const api = fakeApi();
    api.elevate.mockRejectedValueOnce(new Error('Sensitive action cancelled: PIN not entered'));
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    expect(await screen.findByText(/Could not start the login: Sensitive action cancelled: PIN not entered/)).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /admin-login');
  });

  it('a login already waiting in the daemon (the page was reloaded) is shown at once, no new request', async () => {
    const api = fakeApi({ states: [WAITING] });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} pollMs={500} />);
    expect(await screen.findByText('ADMN-7K42')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /admin-login');
  });

  it('Cancel stops the wait through the module and goes back to the button', async () => {
    const user = setup();
    const api = fakeApi({ states: [{ ok: true, state: 'idle' }, WAITING], cancel: { ok: true, state: 'idle' } });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} pollMs={500} />);
    await user.click(await screen.findByRole('button', { name: 'Log in to the relay' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(api.calls).toContain('POST /admin-login/cancel');
    expect(await screen.findByRole('button', { name: 'Log in to the relay' })).toBeInTheDocument();
    expect(screen.queryByText('ADMN-7K42')).toBeNull();
  });

  it('a state the page cannot read (older daemon) is said, and the button stays', async () => {
    const api = fakeApi({ states: [{ nope: 1 }] });
    render(<SourceFailureNotice source="candidacies" error={{ message: NO_TOKEN, status: 503 }} onRefresh={async () => undefined} api={api} />);
    expect(await screen.findByText(/Could not read the state of the login: the daemon answered the relay login with something this page does not understand/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to the relay' })).toBeInTheDocument();
  });
});

describe('case 2 where the page cannot act (damaged token file, machine without identity)', () => {
  const error = { message: '/home/u/.config/machine/_secrets_/relay-admin.json is corrupt or invalid (not valid JSON): delete it and run `machine admin login --force` and confirm the request in the relay console', status: 503 };

  it('one sentence, a Copy command button, the command folded in Details, no login button', async () => {
    const user = setup();
    render(<SourceFailureNotice source="candidacies" error={error} onRefresh={async () => undefined} />);
    expect(screen.getByText('Setup needed: /home/u/.config/machine/_secrets_/relay-admin.json is corrupt or invalid.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Log in/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(written).toEqual(['machine admin login --force']);
    expect(await screen.findByText('Command copied.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('machine admin login --force')).toBeInTheDocument();
  });
});

describe('the machine daemon', () => {
  it('not running: Retry and Copy command, the command is not in the headline', () => {
    render(<SourceFailureNotice source="machines" error={{ message: 'the machine daemon is not running (no /h/daemon.port.json): start it with `machine daemon` (or its orch job) and reload the page', status: 503 }} onRefresh={async () => undefined} />);
    expect(screen.getByText('Could not reach the machine daemon, so the machines cannot be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });
});
