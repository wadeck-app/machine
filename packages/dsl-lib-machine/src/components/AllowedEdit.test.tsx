import { encryptAdminKey, generateSigningKeyPair, keyId, signPolicy as coreSignPolicy, type PolicyBody, type PolicyEntry, type SignedPolicy } from '@wadeck-app/machine-core';
import { unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { useEffect, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { signingsSettled } from '../lib/allowFlow.js';
import { appFetcher } from '../lib/shellApi.js';
import { AllowedList, type AllowedEntryData, type AllowedMachineData, type AllowedPageData } from './AllowedList.js';

// The Allowed page is ACTIONABLE (decision 112): delete and change of lifetime, one row or a selection, signed in the browser with the unlocked admin key
// exactly like Allow. The app-core shell is a stub on globalThis; the module backend is a recording fake that answers with REAL signed policies.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const SELF = '22222222-2222-4222-8222-222222222222';
const LAPTOP = '33333333-3333-4333-8333-333333333333';
const PEER = '11111111-1111-4111-8111-111111111111';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const exact = (command: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell: 'sh', command, ...(limits === undefined ? {} : { limits }) });

const signed = (target: string, version: number, defaults: PolicyEntry[], peers: PolicyBody['peers'] = {}): SignedPolicy =>
  coreSignPolicy({ v: 1, target, version, baseVersion: version - 1, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 60, notBefore: NOW - 60, notAfter: NOW + 86400, defaults, peers }, admin.privateKeyPkcs8);

/** The rows the page shows for a policy, as the module backend builds them (identity keys). */
function rowsOf(policy: SignedPolicy): AllowedEntryData[] {
  const lists: Array<{ peer: string; list: PolicyEntry[] }> = [{ peer: '', list: policy.body.defaults }, ...Object.entries(policy.body.peers).map(([peer, list]) => ({ peer, list }))];
  return lists.flatMap(({ peer, list }) =>
    list.map((e, i): AllowedEntryData => ({
      key: `${peer === '' ? 'default' : peer}|${e.shell}|${e.command ?? e.template}`,
      listLabel: peer === '' ? 'default' : 'only for thinkcentre',
      listTitle: peer === '' ? 'Default list (every trusted peer without a list of its own)' : 'Only for thinkcentre (its own list, it replaces the default)',
      peerName: peer === '' ? '' : 'thinkcentre',
      peerUuid: peer,
      index: i + 1,
      shell: e.shell,
      text: (e.command ?? e.template) as string,
      typed: e.template !== undefined,
      lifetimeText: e.limits?.maxCalls !== undefined ? `${e.limits.maxCalls} calls` : e.limits?.expiresAt !== undefined ? 'until later' : 'permanent',
      limited: e.limits !== undefined,
      maxCalls: e.limits?.maxCalls ?? null,
      expiresAt: e.limits?.expiresAt ?? null,
      limitNote: '',
      lastUsedAt: null,
      lastUsedSort: -1,
      lastUsedText: 'never',
      lastUsedNote: 'No accepted use.',
      removeCommand: peer === '' ? `machine admin allow x --remove --index ${i + 1}` : '',
    })),
  );
}

const machineOf = (uuid: string, name: string, policy: SignedPolicy, over: Partial<AllowedMachineData> = {}): AllowedMachineData => ({
  uuid, name, isSelf: uuid === SELF, source: uuid === SELF ? 'installed' : 'signed-here', sourceText: 'x', mode: 'admin', version: policy.body.version, signedText: 'signed 1 min ago', signedIso: '',
  entries: rowsOf(policy), deliveryNote: '', problem: '', emptyText: '', fillCommand: `machine admin allow ${name} -- <command>`, canEdit: true, editNote: '', ...over,
});

/** The page of allowed.yaml in miniature: the source (read at mount and at each refresh), a Refresh button, and the component fed with the data. */
function Host() {
  const [data, setData] = useState<AllowedPageData | undefined>(undefined);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    void Promise.resolve(appFetcher('GET /api/modules/machine/allowed')).then((answer) => setData(answer as AllowedPageData));
  }, [reads]);
  const refresh = async (): Promise<void> => setReads((n) => n + 1);
  return (
    <>
      <ButtonAction label="Refresh" onClick={() => void refresh()} />
      <AllowedList data={data} onRefresh={refresh} />
    </>
  );
}

let desktop: SignedPolicy;
let laptop: SignedPolicy;
let pageOver: (m: AllowedMachineData[]) => AllowedMachineData[];

const page = (): AllowedPageData => {
  const machines = pageOver([machineOf(SELF, 'desktop', desktop), machineOf(LAPTOP, 'laptop', laptop)]);
  return { machine: { uuid: SELF, name: 'desktop' }, entryCount: machines.reduce((n, m) => n + m.entries.length, 0), machineCount: machines.length, machines, warnings: [] };
};

interface Call { url: string; body?: unknown }
let calls: Call[];
let postAnswer: unknown;
let contextOver: (uuid: string, c: Record<string, unknown>) => Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
  const mine: Call[] = [];
  calls = mine;
  desktop = signed(SELF, 4, [exact('echo a'), exact('echo b', { maxCalls: 2 }), exact('echo c'), exact('echo d')], { [PEER]: [exact('peer one'), exact('peer two')] });
  laptop = signed(LAPTOP, 2, [exact('uptime'), exact('df -h')]);
  pageOver = (m) => m;
  postAnswer = { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 5, delivery: 'installed', deliveryText: { tone: 'success', text: 'Installed on desktop (this machine)' } };
  contextOver = (_uuid, c) => c;
  const fetcher = async (url: string, _p?: Record<string, string>, body?: unknown) => {
    mine.push({ url, body });
    if (url === 'GET /api/modules/machine/allowed') {
      return page();
    }
    const ctx = /^GET \/api\/modules\/machine\/allow\/(.+)$/.exec(url);
    if (ctx !== null) {
      const uuid = ctx[1] as string;
      const self = uuid === SELF;
      return contextOver(uuid, {
        ok: true,
        target: { uuid, name: self ? 'desktop' : 'laptop', identityPublicKey: self ? undefined : admin.publicKey },
        toSelf: self,
        policyMode: 'admin',
        adminKeyId: ADMIN_KEY_ID,
        adminPublicKey: admin.publicKey,
        current: self ? desktop : laptop,
        source: 'x',
        delivery: self ? 'install' : 'inbox',
        ...(self ? {} : { noticeRecipients: { selfUuid: SELF, current: null } }),
      });
    }
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFile };
    }
    if (url === 'POST /api/modules/machine/allow') {
      if (postAnswer instanceof Error) {
        throw postAnswer;
      }
      return postAnswer;
    }
    throw new Error(`unexpected call ${url}`);
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate: async () => undefined, fetcher }, configurable: true, writable: true });
});
afterEach(async () => {
  await signingsSettled();
  // Unmount BEFORE the shell is removed: a signing that ended after the test body re-reads the page (Host effect -> appFetcher) and must still find the fetcher.
  cleanup();
  adminKeyHolder.reset();
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const unlock = async (): Promise<void> => {
  adminKeyHolder.hold(await unlockAdminKey(keyFile, PASSPHRASE, { extractable: false }));
};
const posts = (): Call[] => calls.filter((c) => c.url === 'POST /api/modules/machine/allow');
const posted = (): { policy: SignedPolicy } => posts()[0]?.body as { policy: SignedPolicy };
const opened = async (): Promise<void> => {
  await screen.findByRole('tab', { name: /^desktop/ });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const defaultsOf = (p: SignedPolicy): string[] => p.body.defaults.map((e) => e.command as string);

describe('the actions are offered only where this machine can sign', () => {
  it('a machine this machine signs for: a Delete and a Change lifetime button per row, each named with its command, and a checkbox per row', async () => {
    render(<Host />);
    await opened();
    expect(screen.getByRole('button', { name: 'Delete echo a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change lifetime of echo a' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(1);
  });

  it('a machine this machine cannot sign for (mode local, no admin key): no button, no checkbox, ONE line that says why and the terminal command', async () => {
    const note = 'This machine manages its own list (policy mode local): no admin signature is used here. Change it from a terminal on this machine with `machine policy allow`.';
    pageOver = (m) => [{ ...(m[0] as AllowedMachineData), canEdit: false, editNote: note }, m[1] as AllowedMachineData];
    render(<Host />);
    await opened();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Change lifetime of / })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getAllByText(note)).toHaveLength(1);
  });

  it('a daemon that predates the actions says so with the fix, never a silent read-only table', async () => {
    const note = 'the daemon is older than this page and does not say whether this machine can sign a change of this list, so no action is offered: update it with `machine cli update` and restart it';
    pageOver = (m) => [{ ...(m[0] as AllowedMachineData), canEdit: false, editNote: note }, m[1] as AllowedMachineData];
    render(<Host />);
    await opened();
    expect(screen.getByText(note)).toBeInTheDocument();
  });
});

describe('delete one row', () => {
  it('opens a confirmation that names the machine, the shell, the exact command and what happens; Cancel and Escape sign nothing', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByRole('heading')).toHaveTextContent('Delete 1 allowed command on desktop?');
    expect(within(d).getByText('Machine').nextSibling).toHaveTextContent('desktop');
    expect(within(d).getByText('Shell').nextSibling).toHaveTextContent('sh');
    expect(within(d).getByText('Command').nextSibling).toHaveTextContent('echo c');
    expect(await within(d).findByText(/Policy version 4 -> 5/)).toBeInTheDocument();
    expect(within(d).getByText(/stops being allowed/)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('with the admin key unlocked ONE click signs a `remove` of exactly that entry: version 5 edited from 4, the other lists untouched, only signed documents posted', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    await screen.findByRole('dialog');
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const { policy } = posted();
    expect(Object.keys(posted())).toEqual(['policy']);
    expect(policy.body).toMatchObject({ version: 5, baseVersion: 4, target: SELF });
    expect(defaultsOf(policy)).toEqual(['echo a', 'echo b', 'echo d']);
    expect(policy.body.peers[PEER]?.map((e) => e.command)).toEqual(['peer one', 'peer two']);
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
  });

  it('after success: the page is read again, the dialog is gone, and a line says what was signed (version) and how it was delivered', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    const reads = () => calls.filter((c) => c.url === 'GET /api/modules/machine/allowed').length;
    expect(reads()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    const line = within(await screen.findByRole('group', { name: 'Last change' })).getByRole('status');
    expect(line).toHaveTextContent('Signed version 5 for desktop');
    expect(line).toHaveTextContent('Installed on desktop (this machine)');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(reads()).toBe(2));
  });

  it('a locked key asks the passphrase in the dialog (never anywhere else) and signs with it', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    await screen.findByRole('dialog');
    await user.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await user.click(screen.getByRole('button', { name: 'Delete and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1), { timeout: 8000 });
    expect(defaultsOf(posted().policy)).toEqual(['echo a', 'echo b', 'echo d']);
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
  }, 15000);

  it('the entry of an own list of a peer is removed from THAT list (the per-peer lists of an admin policy are editable from the page)', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete peer two' }));
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().policy.body.peers[PEER]?.map((e) => e.command)).toEqual(['peer one']);
    expect(defaultsOf(posted().policy)).toEqual(['echo a', 'echo b', 'echo c', 'echo d']);
  });

  it('another machine: the policy is signed for IT and its sealed inbox document rides along; the delivery sentence of the daemon is shown', async () => {
    const user = userEvent.setup();
    await unlock();
    postAnswer = { ok: true, target: { uuid: LAPTOP, name: 'laptop' }, version: 3, delivery: 'inbox', deliveryText: { tone: 'warning', text: 'laptop is not reachable directly: stored in the relay inbox' } };
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('tab', { name: /^laptop/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete df -h' }));
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = posts()[0]?.body as { policy: SignedPolicy; document?: unknown };
    expect(body.policy.body).toMatchObject({ target: LAPTOP, version: 3, baseVersion: 2 });
    expect(body.document).toBeDefined();
    expect(within(await screen.findByRole('group', { name: 'Last change' })).getByRole('status')).toHaveTextContent('laptop is not reachable directly');
  });
});

describe('change the lifetime', () => {
  it('shows the old and the new lifetime, flags a WIDENING with the warning badge, and signs a renewal of that entry', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Change lifetime of echo b' }));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByRole('heading')).toHaveTextContent('Change the lifetime of 1 allowed command on desktop?');
    await user.selectOptions(within(d).getByLabelText('How long is it allowed?'), 'permanent');
    expect(await within(d).findByText(/2 calls.*->.*permanent/s)).toBeInTheDocument();
    expect(within(d).getByRole('note')).toHaveTextContent(/Widens rights/);
    await user.click(within(d).getByRole('button', { name: 'Change lifetime and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().policy.body.defaults[1]).toEqual({ shell: 'sh', command: 'echo b' });
    expect(posted().policy.body).toMatchObject({ version: 5, baseVersion: 4 });
  });

  it('a stricter lifetime is not flagged, and the counter restarting is said', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Change lifetime of echo a' }));
    const d = await screen.findByRole('dialog');
    await user.selectOptions(within(d).getByLabelText('How long is it allowed?'), 'once');
    expect(await within(d).findByText(/permanent.*->.*1 call/s)).toBeInTheDocument();
    expect(within(d).queryByRole('note')).toBeNull();
    expect(within(d).getByText(/counter starts again/)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Change lifetime and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().policy.body.defaults[0]).toEqual({ shell: 'sh', command: 'echo a', limits: { maxCalls: 1, renewals: 1 } });
    expect(posted().policy.body.v).toBe(2);
  });

  it('an invalid custom lifetime is refused in the dialog with the fix and nothing is signed', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Change lifetime of echo a' }));
    const d = await screen.findByRole('dialog');
    await user.selectOptions(within(d).getByLabelText('How long is it allowed?'), 'custom');
    await user.click(within(d).getByRole('button', { name: 'Change lifetime and sign' }));
    expect(await within(d).findByText(/Enter a duration/)).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  it('Safer mode ON: a flagged lifetime (permanent) needs an explicit acknowledgement even with the key unlocked; the box ticked, it signs', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('machine:requests:saferMode', 'on');
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Change lifetime of echo b' }));
    const d = await screen.findByRole('dialog');
    await user.selectOptions(within(d).getByLabelText('How long is it allowed?'), 'permanent');
    await user.click(within(d).getByRole('button', { name: 'Change lifetime and sign' }));
    expect(await within(d).findByText(/Safer mode is on/)).toBeInTheDocument();
    expect(posts()).toEqual([]);
    await user.click(within(d).getByRole('checkbox', { name: /I understand/ }));
    await user.click(within(d).getByRole('button', { name: 'Change lifetime and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it('Safer mode OFF (the default): the same permanent lifetime signs without the acknowledgement', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Change lifetime of echo b' }));
    const d = await screen.findByRole('dialog');
    await user.selectOptions(within(d).getByLabelText('How long is it allowed?'), 'permanent');
    expect(within(d).queryByRole('checkbox', { name: /I understand/ })).toBeNull();
    await user.click(within(d).getByRole('button', { name: 'Change lifetime and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
});

describe('batch editing with the shared table', () => {
  const select = async (user: ReturnType<typeof userEvent.setup>, ...keys: string[]): Promise<void> => {
    for (const key of keys) {
      await user.click(screen.getByRole('checkbox', { name: `Select row ${key}` }));
    }
  };

  it('a selection shows the floating Batch actions bar; Delete selected confirms with the count and the list of commands, then signs ONE policy', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await select(user, 'default|sh|echo a', 'default|sh|echo c', `${PEER}|sh|peer one`);
    const bar = screen.getByRole('toolbar', { name: 'Batch actions' });
    expect(bar).toHaveTextContent('3 selected');
    await user.click(within(bar).getByRole('button', { name: 'Delete selected' }));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByRole('heading')).toHaveTextContent('Delete 3 allowed commands on desktop?');
    // One read-only field per command (the standard FieldReadOnly), in the order of the selection.
    expect(['Command 1', 'Command 2', 'Command 3'].map((label) => within(d).getByText(label).closest('div')?.parentElement?.textContent)).toEqual([
      expect.stringContaining('sh echo a'),
      expect.stringContaining('sh echo c'),
      expect.stringContaining('sh peer one (own list of thinkcentre)'),
    ]);
    await user.click(await within(d).findByRole('button', { name: 'Delete and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(defaultsOf(posted().policy)).toEqual(['echo b', 'echo d']);
    expect(posted().policy.body.peers[PEER]?.map((e) => e.command)).toEqual(['peer two']);
    expect(posted().policy.body).toMatchObject({ version: 5, baseVersion: 4 });
  });

  it('Change lifetime on a selection signs ONE renewal of every selected entry', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await select(user, 'default|sh|echo a', 'default|sh|echo d');
    await user.click(within(screen.getByRole('toolbar', { name: 'Batch actions' })).getByRole('button', { name: 'Change lifetime' }));
    const d = await screen.findByRole('dialog');
    await user.selectOptions(within(d).getByLabelText('How long is it allowed?'), 'once');
    await user.click(await within(d).findByRole('button', { name: 'Change lifetime and sign' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().policy.body.defaults.map((e) => e.limits?.maxCalls)).toEqual([1, 2, undefined, 1]);
  });

  it('cancelling the confirmation keeps the selection, for both batch actions (keepSelection)', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await select(user, 'default|sh|echo a', 'default|sh|echo c');
    for (const name of ['Delete selected', 'Change lifetime']) {
      await user.click(within(screen.getByRole('toolbar', { name: 'Batch actions' })).getByRole('button', { name }));
      const d = await screen.findByRole('dialog');
      await user.click(within(d).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole('toolbar', { name: 'Batch actions' })).toHaveTextContent('2 selected');
      expect(screen.getByRole('checkbox', { name: 'Select row default|sh|echo a' })).toBeChecked();
    }
    expect(posts()).toHaveLength(0);
  });

  it('standard variants only: the row delete icon is a red outline (danger-outline), never solid; the batch buttons are neutral; no custom width on the actions column', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await opened();
    const del = screen.getByRole('button', { name: 'Delete echo a' });
    expect(del.className).toMatch(/border-danger/);
    expect(del.className).toMatch(/text-danger/);
    expect(del.className).not.toMatch(/(^|\s)bg-(danger|warning|orange)/);
    expect(screen.getByRole('button', { name: 'Change lifetime of echo a' }).className).not.toMatch(/danger/);
    await select(user, 'default|sh|echo a');
    for (const name of ['Delete selected', 'Change lifetime']) {
      const b = within(screen.getByRole('toolbar', { name: 'Batch actions' })).getByRole('button', { name });
      expect(b.className).not.toMatch(/(^|\s)bg-(danger|warning|orange|primary)(\s|$)|border-danger/);
    }
    const th = screen.getAllByRole('columnheader').at(-1) as HTMLElement;
    expect(th.style.width).toBe('');
  });

  it('every selected command has its own read-only field in the dialog, so a long selection is a column of fields (the design-system Dialog has no scroll of its own)', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await opened();
    await select(user, 'default|sh|echo a', 'default|sh|echo b');
    await user.click(within(screen.getByRole('toolbar', { name: 'Batch actions' })).getByRole('button', { name: 'Delete selected' }));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByText('Command 1')).toBeInTheDocument();
    expect(within(d).getByText('Command 2')).toBeInTheDocument();
    expect(within(d).queryByText('Command 3')).toBeNull();
  });

  it('the selection survives the re-read of the page (the 15 s poll or Refresh) and a row that vanished is dropped from the action', async () => {
    const user = userEvent.setup();
    await unlock();
    render(<Host />);
    await opened();
    await select(user, 'default|sh|echo a', 'default|sh|echo c');
    expect(screen.getByRole('toolbar', { name: 'Batch actions' })).toHaveTextContent('2 selected');
    // Another administrator removed echo c in the meantime: the next read no longer has it.
    desktop = signed(SELF, 5, [exact('echo a'), exact('echo b', { maxCalls: 2 }), exact('echo d')], { [PEER]: [exact('peer one'), exact('peer two')] });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Select row default|sh|echo c' })).toBeNull());
    expect(screen.getByRole('checkbox', { name: 'Select row default|sh|echo a' })).toBeChecked();
    await user.click(within(screen.getByRole('toolbar', { name: 'Batch actions' })).getByRole('button', { name: 'Delete selected' }));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByRole('heading')).toHaveTextContent('Delete 1 allowed command on desktop?');
    expect(within(d).getByText('Command').nextSibling).toHaveTextContent('echo a');
    expect(d).not.toHaveTextContent('echo c');
  });
});

describe('failures say the cause and the fix', () => {
  it('a policy that moved since the page was read: refused BEFORE the passphrase, in the dialog, with the fix; nothing signed', async () => {
    const user = userEvent.setup();
    await unlock();
    // The page still shows version 4, the machine is at 6 now.
    contextOver = (uuid, c) => (uuid === SELF ? { ...c, current: signed(SELF, 6, [exact('echo a'), exact('echo c')]) } : c);
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    const d = await screen.findByRole('dialog');
    expect(await within(d).findByText(/changed since this page was read.*version 4.*version 6/s)).toBeInTheDocument();
    expect(within(d).getByText(/Refresh the page/)).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: 'Delete and sign' })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('the daemon refusing a stale base stays in the dialog with its sentence (the person can cancel and refresh)', async () => {
    const user = userEvent.setup();
    await unlock();
    postAnswer = new Error('the policy of "desktop" is at version 5, and this one was edited from version 4: reload the page and allow it again. Nothing was stored or sent');
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    expect(await within(dialog()).findByText(/reload the page/)).toBeInTheDocument();
  });

  it('a delivery that failed AFTER the signature is said on the page with the exact retry command, and the page is read again (the policy is recorded)', async () => {
    const user = userEvent.setup();
    await unlock();
    const retry = 'the policy is signed and recorded (version 3) but the relay did not store it for "laptop": relay down. Run `machine admin distribute --policy C:/cfg/policies/33.json` to send it again; it is safe to run again';
    postAnswer = new Error(retry);
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('tab', { name: /^laptop/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete df -h' }));
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    const line = within(await screen.findByRole('group', { name: 'Last change' })).getByRole('alert');
    expect(line).toHaveTextContent('Signed version 3 for laptop');
    expect(line).toHaveTextContent('machine admin distribute --policy C:/cfg/policies/33.json');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.url === 'GET /api/modules/machine/allowed').length).toBe(2));
  });

  it('the admin key being locked when the dialog signs says so with the fix and signs nothing (no passphrase field was shown, the key expired meanwhile)', async () => {
    const user = userEvent.setup();
    await unlock();
    vi.spyOn(adminKeyHolder, 'current').mockReturnValueOnce(adminKeyHolder.current()).mockReturnValue(null);
    render(<Host />);
    await opened();
    await user.click(screen.getByRole('button', { name: 'Delete echo c' }));
    await user.click(await screen.findByRole('button', { name: 'Delete and sign' }));
    expect(await within(dialog()).findByText(/admin key is locked/)).toBeInTheDocument();
    expect(posts()).toEqual([]);
    vi.restoreAllMocks();
  });
});
