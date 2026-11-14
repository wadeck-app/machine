import { existsSync, readFileSync } from 'node:fs';
import { SHELLS, resolveMachineRef, type Shell } from '@wadeck-app/machine-core';
import { connectToPeer } from '@wadeck-app/machine-transport';
import { adminInit, pinAdminKey, signPolicyFile } from './admin.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { writeFileAtomic } from './fsutil.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, importPeer, installPolicy, loadNetwork, registerMachine, type MachineInfo, type PeerBundle } from './network.js';
import { promptHidden } from './prompt.js';
import { readAliases } from './state.js';
import { runOnPeer } from './peerService.js';

// The commands that deal with the network: admin signing, peers, policy and remote execution.

const epochSeconds = () => Math.floor(Date.now() / 1000);

function readJson(file: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${what} ${file} does not exist`);
    throw new Error(`cannot read ${what} ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} ${file} is not valid JSON: ${(e as Error).message}`);
  }
}

function parseAddress(address: string): { host: string; port: number } | undefined {
  const m = /^([^:\s]+):(\d{1,5})$/.exec(address);
  if (!m) return undefined;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1] as string, port } : undefined;
}

/** Writing a secret or a signed document: never over an existing file by accident, never half written. */
function writeOutput(ctx: CommandContext, file: string, content: string, mode: number): number | undefined {
  if (existsSync(file) && !ctx.args.force) return ctx.fail(`${file} already exists: choose another file or pass --force to overwrite it`);
  writeFileAtomic(file, content, mode);
  return undefined;
}

export async function runNetworkCommand(command: string, ctx: CommandContext): Promise<number | undefined> {
  const { args, rest, io, configDir, env, fail, emit } = ctx;
  const now = epochSeconds();
  const prompt = io.prompt ?? promptHidden;

  if (command === 'admin') {
    const [sub, first, second] = rest;
    for (const name of ['MACHINE_PASSPHRASE', 'MACHINE_ADMIN_PASSPHRASE']) {
      if (env[name] !== undefined) {
        io.stderr(`[warn] ${name} is set but ignored: passphrases are only read from the terminal prompt, never from the environment. Unset it\n`);
      }
    }
    if (sub === 'init') {
      if (first !== undefined) return fail(`unexpected argument "${first}" for \`machine admin init\``, EXIT.usage);
      const r = adminInit(configDir);
      // The passphrase goes to the terminal channel only: stdout may be redirected or captured in a log.
      io.stderr(`Admin passphrase (shown only once, write it down now; it cannot be recovered):\n  ${r.passphrase}\n`);
      emit({ adminKeyId: r.adminKeyId, adminPublicKey: r.adminPublicKey }, `[ok] admin key created (id ${r.adminKeyId})\n`);
      return EXIT.ok;
    }
    if (sub === 'pin') {
      if (first === undefined || second !== undefined) return fail('usage: machine admin pin <admin.json>', EXIT.usage);
      const pin = pinAdminKey(configDir, first);
      emit(pin, `[ok] this machine now trusts admin key ${pin.adminKeyId}\n`);
      return EXIT.ok;
    }
    if (sub === 'sign-policy') {
      if (first === undefined || second !== undefined) return fail('usage: machine admin sign-policy <draft.json> [--out <file>]', EXIT.usage);
      // Fail before the passphrase is typed, not after the key was unlocked.
      if (args.out && existsSync(args.out) && !args.force) return fail(`${args.out} already exists: choose another file or pass --force to overwrite it`);
      const { signed } = await signPolicyFile(configDir, first, {
        now,
        prompt,
        onSummary: (summary) => io.stderr(`${summary}\nSigning this exact policy. Enter the admin passphrase to confirm, Ctrl-C to cancel.\n`),
      });
      const text = `${JSON.stringify(signed, null, 2)}\n`;
      if (args.out) {
        writeFileAtomic(args.out, text, 0o644);
        io.stderr(`[ok] signed policy written to ${args.out}\n`);
      } else {
        io.stdout(text);
      }
      return EXIT.ok;
    }
    if (sub === 'register') {
      if (first === undefined || second !== undefined) return fail('usage: machine admin register <info.json> --out <bundle.json> [--days <n>] [--secret-from <bundle.json>]', EXIT.usage);
      // The bundle holds a pair secret: it is only ever written to a file, never to stdout or a log.
      if (!args.out) return fail('register needs --out <bundle.json>: the bundle contains a secret and is never printed', EXIT.usage);
      if (existsSync(args.out) && !args.force) return fail(`${args.out} already exists: choose another file or pass --force to overwrite it`);
      const days = args.days === undefined ? 365 : Number(args.days);
      const reused = args.secretFrom ? (readJson(args.secretFrom, 'bundle') as Partial<PeerBundle>).pairSecret : undefined;
      if (args.secretFrom && typeof reused !== 'string') return fail(`${args.secretFrom} has no pair secret: pass the bundle produced by \`machine admin register\``);
      const info = readJson(first, 'machine info') as MachineInfo;
      io.stderr(`Registering "${String((info as { name?: unknown }).name)}" for ${days} day(s). Enter the admin passphrase to sign, Ctrl-C to cancel.\n`);
      const bundle = await registerMachine(configDir, info, { now, prompt, validForDays: days, ...(reused ? { pairSecret: reused } : {}) });
      writeFileAtomic(args.out, `${JSON.stringify(bundle, null, 2)}\n`, 0o600);
      emit({ uuid: bundle.registration.body.uuid, out: args.out }, `[ok] registration written to ${args.out}: copy it to the machine that must trust "${bundle.registration.body.name}" (it contains a secret)\n`);
      return EXIT.ok;
    }
    return fail('usage: machine admin init | pin <admin.json> | register <info.json> --out <bundle> | sign-policy <draft.json>', EXIT.usage);
  }

  if (command === 'peer') {
    const [sub, first, second] = rest;
    if (sub === 'info') {
      if (first !== undefined) return fail(`unexpected argument "${first}" for \`machine peer info\``, EXIT.usage);
      const info = exportMachineInfo(configDir);
      const text = `${JSON.stringify(info, null, 2)}\n`;
      if (args.out) {
        const refused = writeOutput(ctx, args.out, text, 0o644);
        if (refused !== undefined) return refused;
        io.stderr(`[ok] machine info written to ${args.out}: give it to the admin\n`);
      } else {
        io.stdout(text);
      }
      return EXIT.ok;
    }
    if (sub === 'import') {
      if (first === undefined || second !== undefined) return fail('usage: machine peer import <bundle.json>', EXIT.usage);
      const bundle = readJson(first, 'bundle') as PeerBundle;
      importPeer(configDir, bundle, { now });
      emit({ imported: bundle.registration.body.uuid }, `[ok] this machine now trusts "${bundle.registration.body.name}" (${bundle.registration.body.uuid})\n`);
      return EXIT.ok;
    }
    return fail('usage: machine peer info [--out <file>] | import <bundle.json>', EXIT.usage);
  }

  if (command === 'policy') {
    const [sub, first, second] = rest;
    if (sub !== 'install' || first === undefined || second !== undefined) return fail('usage: machine policy install <signed-policy.json>', EXIT.usage);
    const body = installPolicy(configDir, readJson(first, 'policy') as never, { now });
    emit({ version: body.version }, `[ok] policy version ${body.version} installed (${body.defaults.length} default entries, ${Object.keys(body.peers).length} peer-specific lists)\n`);
    return EXIT.ok;
  }

  if (command === 'run') {
    const ref = rest[0];
    if (ref === undefined || rest.length > 1 || args.passthrough.length === 0) {
      return fail('usage: machine run <machine> --address <host:port> [--shell cmd|ps|bash|sh] -- <command...>', EXIT.usage);
    }
    const shell = args.shell ?? (process.platform === 'win32' ? 'cmd' : 'sh');
    if (!(SHELLS as readonly string[]).includes(shell)) return fail(`unknown shell "${shell}": expected one of ${SHELLS.join(', ')}`, EXIT.usage);

    const self = readMachine(configDir);
    const network = loadNetwork(configDir, now);
    const machines = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
    const resolved = resolveMachineRef(ref, machines, readAliases(configDir));
    if (!resolved.ok) return fail(resolved.message, EXIT.peer);
    if (resolved.uuid === self.uuid) return fail('that is this machine: run the command here directly', EXIT.peer);
    const peer = network.directory.find(resolved.uuid);
    if (!peer) return fail(`"${ref}" is not a trusted peer: see \`machine status\` for what was left out and why`, EXIT.peer);
    if (!args.address) {
      return fail(`no address known for "${peer.name}": pass --address <host:port> (automatic address discovery arrives with the relay)`, EXIT.peer);
    }
    const where = parseAddress(args.address);
    if (!where) return fail(`invalid --address "${args.address}": expected <host>:<port>, for example 192.168.1.20:47921`, EXIT.usage);

    let answer;
    try {
      const session = await connectToPeer({
        identity: self.identity,
        host: where.host,
        port: where.port,
        expectedPeerPublicKey: peer.identityPublicKey,
        pairSecret: peer.pairSecret,
      });
      try {
        answer = await runOnPeer(session, { identity: self.identity, source: self.uuid, target: peer.peerId, shell: shell as Shell, command: args.passthrough.join(' '), now });
      } finally {
        session.close();
      }
    } catch (e) {
      return fail((e as Error).message, EXIT.peer);
    }
    if (answer.type === 'refused') {
      return fail(`refused by ${peer.name}: ${answer.reason}: ${answer.message}`, EXIT.peer);
    }
    if (args.json) {
      io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
    } else {
      if (answer.stdout) io.stdout(answer.stdout);
      if (answer.stderr) io.stderr(answer.stderr);
    }
    if (answer.timedOut) io.stderr('[warn] the command was stopped: it exceeded the time limit of the peer\n');
    if (answer.truncated) io.stderr('[warn] the output was cut: it exceeded the output limit of the peer\n');
    if (answer.outputNotUtf8) io.stderr('[warn] the output is not valid UTF-8 (probably an OEM code page): accented characters may be wrong\n');
    // A command that was killed has no exit code: report it as a machine-level failure, not as a success.
    return answer.exitCode === null ? EXIT.peer : Math.min(Math.max(answer.exitCode, 0), 254);
  }

  return undefined;
}
