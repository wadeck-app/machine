import React from 'react';
import { generateSigningKeyPair, encryptAdminKey, keyId, type SignedPolicy } from '@wadeck-app/machine-core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signingsSettled } from '../lib/allowFlow.js';
import { lifetimeMemory } from '../lib/quickAllow.js';
import { HeldRequests, type HeldRequestRow } from './HeldRequests.js';

// A request whose command is RECOGNISED as read-only (machine-core classifyReadOnly) starts from Permanent; any other starts from the usual default. Only a
// pre-selection: nothing is signed here, the owner still clicks. Precedence: the caller's ask, then (renewal), then read-only, then the last choice, then Once.

const SELF = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, 'correct horse battery staple 7391'));
const ALLOW = { available: true, machine: { uuid: SELF, name: 'desktop' }, note: '' };

const row = (id: string, command: string, extra: Partial<HeldRequestRow> = {}): HeldRequestRow => ({ id, peerText: 'thinkcentre', peer: PEER, shell: 'sh', command, secondsLeft: 300, askedText: '5 s ago', countText: 'waiting now', nextCommand: `machine admin allow desktop --shell sh -- ${command}`, nextWhere: '', ...extra });
const context = () => ({ ok: true, target: { uuid: SELF, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: keyId(admin.publicKey), adminPublicKey: admin.publicKey, current: null as SignedPolicy | null, source: 'installed on this machine', delivery: 'install' });

const posts: string[] = [];
beforeEach(() => {
  posts.length = 0;
  const fetcher = async (url: string) => {
    if (url.startsWith('GET /api/modules/machine/allow/')) {
      return context();
    }
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFile };
    }
    if (url === 'POST /api/modules/machine/allow') {
      posts.push(url);
      return { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' };
    }
    if (url.startsWith('GET /api/modules/machine/hold-progress/')) {
      return { state: 'held' };
    }
    throw new Error(`unexpected call ${url}`);
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate: vi.fn(async () => undefined), fetcher }, configurable: true, writable: true });
});
afterEach(async () => {
  await signingsSettled();
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
  lifetimeMemory.reset();
  window.localStorage.clear();
});

const itemOf = (command: string) => screen.getByRole('listitem', { name: `Held request ${command}` });
const lifetimeOf = (command: string) => within(itemOf(command)).getByLabelText('Lifetime');
const chipOf = (command: string) => within(itemOf(command)).queryByTestId('read-only-chip');
const inline = (rows: HeldRequestRow[]) => render(<HeldRequests rows={rows} allow={ALLOW} allowStyle="inline" />);

describe('a recognised read-only request starts from Permanent (inline style, the select of the card)', () => {
  it('hostname: the select says Permanent and a neutral chip says why, with the matched rule in its tooltip; nothing is signed', () => {
    inline([row('aaaa1111', 'hostname')]);
    expect(lifetimeOf('hostname')).toHaveValue('permanent');
    const chip = chipOf('hostname');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent('read-only (recognised): permanent by default');
    // Neutral, not a warning (the badge "Chosen: permanent" of the flagged lifetime stays next to it as information).
    expect(chip?.className).not.toMatch(/warning|error/);
    expect(within(itemOf('hostname')).getByRole('button', { name: /About: read-only/ })).toHaveAccessibleDescription(/hostname: prints the host name/);
    expect(posts).toEqual([]);
  });

  it('a command that is not recognised starts from Once and has no chip', () => {
    inline([row('bbbb2222', 'orch deploy')]);
    expect(lifetimeOf('orch deploy')).toHaveValue('once');
    expect(chipOf('orch deploy')).toBeNull();
  });

  it.each(['hostname; reboot', 'ls $(reboot)', 'cat /etc/hostname > /etc/x', 'systemctl stop xrdp', 'ethtool -s enp0s31f6 advertise 0x008', 'grep -rhE ^Idle /etc/systemd/logind.conf', 'journalctl --vacuum-size=1M'])('%s is not recognised: Once, no chip', (command) => {
    inline([row('cccc3333', command)]);
    expect(lifetimeOf(command)).toHaveValue('once');
    expect(chipOf(command)).toBeNull();
  });

  it('the shell is part of the question: a posix command in cmd is not recognised, a Windows one in cmd is', () => {
    inline([row('dddd4444', 'ls', { shell: 'cmd' }), row('eeee5555', 'ipconfig /all', { shell: 'cmd' })]);
    expect(lifetimeOf('ls')).toHaveValue('once');
    expect(lifetimeOf('ipconfig /all')).toHaveValue('permanent');
  });

  it("the caller's ask wins over read-only: 3 calls stays 3 calls, and the chip does not claim Permanent", () => {
    inline([row('ffff6666', 'hostname', { ask: { times: 3 } })]);
    expect(lifetimeOf('hostname')).toHaveValue('custom');
    expect(within(itemOf('hostname')).getByLabelText('Number of calls (1 to 10000)')).toHaveValue('3');
    expect(chipOf('hostname')).toHaveTextContent('read-only (recognised)');
    expect(chipOf('hostname')).not.toHaveTextContent('permanent by default');
  });

  it('read-only wins over the last choice of the session, which is still the default of the other cards', async () => {
    inline([row('aaaa1111', 'hostname'), row('bbbb2222', 'orch deploy'), row('cccc3333', 'orch status extra')]);
    await userEvent.selectOptions(lifetimeOf('orch deploy'), '1h');
    expect(lifetimeOf('hostname')).toHaveValue('permanent');
    // A card that was not touched and is not read-only starts from the remembered choice, as before.
    expect(lifetimeMemory.get()).toMatchObject({ kind: '1h' });
  });

  it('the owner can still pick anything on a recognised card', async () => {
    inline([row('aaaa1111', 'hostname')]);
    await userEvent.selectOptions(lifetimeOf('hostname'), '15m');
    expect(lifetimeOf('hostname')).toHaveValue('15m');
    expect(posts).toEqual([]);
  });
});

describe('the dialog and the batch bar start from the same rule', () => {
  it('dialog style, locked key: the dialog of a recognised request opens on Permanent, of another on Once', async () => {
    render(<HeldRequests rows={[row('aaaa1111', 'hostname'), row('bbbb2222', 'orch deploy')]} allow={ALLOW} allowStyle="dialog" />);
    await userEvent.click(within(itemOf('hostname')).getByRole('button', { name: 'Allow' }));
    expect(await screen.findByLabelText('How long is it allowed?')).toHaveValue('permanent');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(itemOf('orch deploy')).getByRole('button', { name: 'Allow' }));
    expect(await screen.findByLabelText('How long is it allowed?')).toHaveValue('once');
    expect(posts).toEqual([]);
  });

  const batch = async (commands: string[]) => {
    inline(commands.map((c, i) => row(`a${i}a${i}a${i}a${i}`, c)));
    for (const c of commands) await userEvent.click(screen.getByRole('checkbox', { name: `Select ${c}` }));
    await userEvent.click(screen.getByRole('button', { name: `Allow ${commands.length} selected` }));
    return screen.findByLabelText('How long is it allowed?');
  };

  it('a batch of recognised requests starts from Permanent', async () => {
    expect(await batch(['hostname', 'uptime'])).toHaveValue('permanent');
  });

  it('a batch that holds ONE request that is not recognised starts from Once (one lifetime for all: the safest default)', async () => {
    expect(await batch(['hostname', 'orch deploy'])).toHaveValue('once');
  });
});
