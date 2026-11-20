import { existsSync } from 'node:fs';
import { REQUESTS_LIST_MAX_GROUPS, type RequestsListAnswer } from '@wadeck-app/machine-core';
import { adminKeyFile, unlockAdminKey, type Prompt } from './admin.js';
import { pendingText } from './cliRequests.js';
import { connectionOf, makeWakeEnv, pinnedOf, resolveTrustedPeer, stderrSinks, targetFor, wakeSettingsFor, type TrustedPeer } from './cliWake.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { connectWithWake } from './wakeConnect.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { listRequestsOnPeer } from './requestsRemote.js';

// `machine requests <machine>` and `machine requests --all` (decision 74): the ADMIN machine asks peers for the requests they refused because
// the command is not allowed. Read-only on both sides. The request is signed with the admin key (one passphrase for all the peers), so only the
// admin can read what the other machines tried. Pending list only: the history stays local (it is the audit log of the machine itself).

interface PeerOutcome {
  name: string;
  uuid: string;
  ok: boolean;
  answer?: RequestsListAnswer;
  error?: string;
}

export async function runRemoteRequests(ctx: CommandContext, prompt: Prompt): Promise<number> {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const epochSeconds = () => Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
  const usage = 'usage: machine requests <machine> [--limit <n>] | machine requests --all [--limit <n>] (asks the peers, admin machine only; `machine requests` alone reads this machine)';
  if (rest.length > 1) return fail(`unexpected argument "${rest[1] as string}". ${usage}`, EXIT.usage);
  if (rest.length === 1 && args.all === true) return fail(`a machine and --all cannot be combined. ${usage}`, EXIT.usage);
  if (args.history === true || args.since !== undefined || args.event !== undefined || args.peer !== undefined) {
    return fail('--history, --since, --event and --peer are local only: the history of a machine is its own audit log, run `machine requests --history` on that machine (the remote view lists the pending requests only)', EXIT.usage);
  }
  if (args.all === true && args.address !== undefined) return fail('--address names the address of ONE machine: it cannot be used with --all', EXIT.usage);
  let limit = REQUESTS_LIST_MAX_GROUPS;
  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!/^\d+$/.test(args.limit) || n < 1 || n > REQUESTS_LIST_MAX_GROUPS) return fail(`--limit must be a whole number from 1 to ${REQUESTS_LIST_MAX_GROUPS} for a remote list, got "${args.limit}"`, EXIT.usage);
    limit = n;
  }

  if (!existsSync(adminKeyFile(configDir))) {
    return fail('this machine does not hold the admin key, and only the admin may list the requests of another machine: run this on the admin machine (`machine requests` alone shows this machine\'s own requests)');
  }
  let self;
  try {
    self = readMachine(configDir);
  } catch (e) {
    return fail((e as Error).message);
  }
  const network = loadNetwork(configDir, epochSeconds());
  let peers: TrustedPeer[];
  if (args.all === true) {
    peers = network.directory.machines().flatMap((m) => {
      const peer = network.directory.find(m.uuid);
      return peer === undefined ? [] : [{ self, peer }];
    });
    if (peers.length === 0) return fail('this machine has no trusted peer to ask: see `machine list`');
  } else {
    const trusted = resolveTrustedPeer(ctx, rest[0] as string, { reference: EXIT.reference, failure: EXIT.failure });
    if ('exit' in trusted) return trusted.exit;
    peers = [trusted];
  }

  // One unlock for every peer. The explanation first: what is signed, and that nothing is changed.
  io.stderr(`Signing a read-only request to list the pending requests of ${peers.map((p) => p.peer.name).join(', ')} (nothing is run, nothing is changed). Enter the admin passphrase to confirm, Ctrl-C to cancel.\n`);
  const pair = await unlockAdminKey(configDir, prompt);

  const outcomes: PeerOutcome[] = [];
  for (const trusted of peers) {
    const { peer } = trusted;
    const outcome: PeerOutcome = { name: peer.name, uuid: peer.peerId, ok: false };
    outcomes.push(outcome);
    try {
      const read = connectionOf(ctx, peer);
      if (!read.ok) {
        outcome.error = 'its connection settings are unreadable (reported above)';
        continue;
      }
      const wake = wakeSettingsFor(ctx, peer, read.connection);
      if (!wake.ok) {
        outcome.error = wake.message;
        continue;
      }
      const sinks = stderrSinks(ctx);
      const target = await targetFor(ctx, peer, read.connection, sinks.warn);
      const { connected } = await connectWithWake(makeWakeEnv(ctx, trusted, { requestedBy: 'run', sinks, pinned: pinnedOf(read.connection) }), target, wake.settings);
      try {
        const result = await listRequestsOnPeer(connected.session, { adminPrivateKeyPkcs8: pair.privateKeyPkcs8, source: self.uuid, target: peer.peerId, limit, now: epochSeconds() });
        if (result.ok) {
          outcome.ok = true;
          outcome.answer = result.answer;
        } else outcome.error = `${result.reason}: ${result.message}`;
      } finally {
        connected.session.close();
      }
    } catch (e) {
      outcome.error = (e as Error).message;
    }
  }

  const now = epochSeconds();
  const text: string[] = [];
  for (const o of outcomes) {
    if (!o.ok || o.answer === undefined) {
      io.stderr(`[fail] ${o.name}: ${o.error ?? 'no answer'}\n`);
      continue;
    }
    const a = o.answer;
    if (!a.chain.ok) io.stderr(`[warn] the audit log of ${o.name} is broken at line ${a.chain.line}: what follows is not listed. Keep a copy of it on that machine for the investigation, then move it away (\`machine requests\` there says more)\n`);
    if (text.length > 0) text.push('');
    text.push(...pendingText({ machine: { name: o.name, policyMode: a.policyMode }, adminKeyHere: true, summary: { pending: a.pending, pendingTotal: a.pendingTotal, allowedNow: a.allowedNow }, logPresent: true, now, where: o.name }));
    // The clock of the peer is not the one used for the ages: a large gap is worth a line.
    if (Math.abs(a.now - now) > 120) text.push(`[warn] the clock of ${o.name} differs from this machine by ${Math.abs(a.now - now)} s: the ages above use this machine's clock`);
  }
  const failed = outcomes.filter((o) => !o.ok).length;
  emit({ machines: outcomes }, `${text.join('\n')}${text.length > 0 ? '\n' : ''}`);
  return failed > 0 ? EXIT.failure : EXIT.ok;
}
