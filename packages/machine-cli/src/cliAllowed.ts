import { join } from 'node:path';
import { entryKey, resolveMachineRef, type PolicyBody, type PolicyEntry } from '@wadeck-app/machine-core';
import { FileUsageStore } from './stores.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { allowedByShell, recordedPolicy, REMOTE_VIEW_LINE } from './allowedView.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { clockText, relativeText } from './humanTime.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { readAliases } from './state.js';

// `machine allowed <machine>` (decision 71): what a machine allows, read-only (no passphrase, no question, nothing sent, nothing written).
// A peer: the last policy signed on THIS machine (the one `machine admin allow` records), because the target never sends its list (T-03: a
// compromised peer must not learn the allow list of the others). This machine: the installed policy and its mode.

const epochSecondsOf = (ctx: CommandContext): number => Math.floor((ctx.io.now?.() ?? new Date()).getTime() / 1000);

const USAGE = 'usage: machine allowed <machine>   (name, alias, uuid or unique uuid prefix; read-only)';

/** `counters`: the call counters of THIS machine (only known on the target), absent for a policy signed here for another machine. */
function peerBlocks(body: PolicyBody, nameOf: (uuid: string) => string, now: number, counters?: { count(key: string): number }): string[] {
  const usedIn = (scope: string) => (counters === undefined ? undefined : (e: PolicyEntry): number | undefined => (e.limits?.maxCalls === undefined ? undefined : counters.count(entryKey(scope, e))));
  const lines = ['  by default, for every trusted peer without a list of its own:', ...allowedByShell(body.defaults, '    ', now, usedIn('default'))];
  for (const [peer, entries] of Object.entries(body.peers)) lines.push(`  only for ${nameOf(peer)} (own list, it replaces the default):`, ...allowedByShell(entries, '    ', now, usedIn(peer)));
  return lines;
}

export function runAllowed(ctx: CommandContext): number {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const ref = rest[0];
  if (ref === undefined || rest.length > 1) return fail(USAGE, EXIT.usage);
  try {
    const now = epochSecondsOf(ctx);
    const self = readMachine(configDir);
    const network = loadNetwork(configDir, now);
    const everyone = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
    const resolved = resolveMachineRef(ref, everyone, readAliases(configDir));
    if (!resolved.ok) return fail(resolved.message, EXIT.reference);
    const target = everyone.find((m) => m.uuid === resolved.uuid) as { uuid: string; name: string };
    const nameOf = (uuid: string): string => everyone.find((m) => m.uuid === uuid)?.name ?? uuid;

    if (target.uuid === self.uuid) {
      for (const problem of network.problems) io.stderr(`[warn] ${problem}\n`);
      const body = network.policy;
      if (args.json) {
        emit({ uuid: target.uuid, name: target.name, source: 'installed', mode: network.policyMode, version: body?.version ?? 0, defaults: body?.defaults ?? [], peers: body?.peers ?? {} }, '');
        return EXIT.ok;
      }
      if (body === undefined) {
        io.stdout(`Nothing is allowed on this machine "${target.name}" (mode ${network.policyMode}): no policy is installed, so every command is refused. ${network.policyMode === 'local' ? 'Allow one with `machine policy allow -- <command>`' : 'The admin allows one with `machine admin allow ' + target.name + ' -- <command>`'}\n`);
        return EXIT.ok;
      }
      // The counters live on this machine: a limited entry shows the calls left. A counter file that cannot be read is said, never skipped.
      let counters: FileUsageStore | undefined;
      try {
        counters = new FileUsageStore(join(configDir, 'usage.json'));
      } catch (e) {
        io.stderr(`[warn] ${(e as Error).message}; the calls left are not shown\n`);
      }
      io.stdout(`${[`Allowed on this machine "${target.name}" (installed policy version ${body.version}, mode ${network.policyMode}):`, ...peerBlocks(body, nameOf, now, counters)].join('\n')}\n`);
      return EXIT.ok;
    }

    const record = recordedPolicy(configDir, target.uuid);
    if (args.json) {
      emit({ uuid: target.uuid, name: target.name, source: 'signed-here', version: record?.body.version ?? 0, issuedAt: record?.body.issuedAt ?? null, defaults: record?.body.defaults ?? [], peers: record?.body.peers ?? {} }, '');
      return EXIT.ok;
    }
    if (record === undefined) {
      io.stdout(`No policy was signed on this machine for "${target.name}": nothing is known here about what it allows (only policies signed on this machine are on record).\n${REMOTE_VIEW_LINE(target.name)}\n`);
      return EXIT.ok;
    }
    const { body } = record;
    io.stdout(`${[`Allowed on "${target.name}" per the policy signed here (version ${body.version}, signed ${clockText(body.issuedAt, now)} (${relativeText(body.issuedAt, now)})):`, ...peerBlocks(body, nameOf, now), REMOTE_VIEW_LINE(target.name)].join('\n')}\n`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
    if (e instanceof NotInitializedError) return fail(e.message);
    // A policy record that cannot be read names its file and the fix (readPolicyRecord): shown as the failure of this command, never as "no policy".
    return fail((e as Error).message);
  }
}
