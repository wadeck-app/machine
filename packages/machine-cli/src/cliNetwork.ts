import { existsSync, readFileSync } from 'node:fs';
import { SHELLS, resolveMachineRef, type Shell } from '@wadeck-app/machine-core';
import { connectToPeer } from '@wadeck-app/machine-transport';
import { adminInit, adminKeyFile, pinAdminKey, signPolicyFile } from './admin.js';
import { adminLogin, runApprove } from './adminApprove.js';
import { runRevoke, UnresolvedReferenceError } from './adminRevoke.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { writeFileAtomic } from './fsutil.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { classifyJoinArgument, DEFAULT_TIMEOUT_SECONDS, realTiming, runJoin } from './join.js';
import { RelayError } from './relayClient.js';
import { readRelayAdminConfig, readRelayConfig } from './relayStore.js';
import { exportMachineInfo, importPeer, installPolicy, loadNetwork, registerMachine, type MachineInfo, type PeerBundle } from './network.js';
import { promptHidden, promptLine } from './prompt.js';
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

/** An input file must hold a JSON object: anything else is reported by file name, never as a raw TypeError. */
function readObject(file: string, what: string): Record<string, unknown> {
  const value = readJson(file, what);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} ${file} must contain a JSON object: check that you passed the right file`);
  }
  return value as Record<string, unknown>;
}

/** `host:port`, a name or an IPv4 address, or a bracketed IPv6 address such as `[::1]:47921`. */
export function parseAddress(address: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s[\]]+)):(\d{1,5})$/.exec(address);
  if (!m) return undefined;
  const port = Number(m[3]);
  const host = m[1] ?? m[2];
  return host && port >= 1 && port <= 65535 ? { host, port } : undefined;
}

/**
 * The remote exit code, kept in 0..254 and never turned into success: 255 is reserved for machine-level failures
 * (a command that was killed has no code at all).
 */
export function remoteExitCode(code: number | null): number {
  if (code === null) return EXIT.peer;
  if (code === 0) return 0;
  const low = code & 0xff;
  return low === 0 || low === 255 ? 254 : low;
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
      // Everything that can be checked is checked before the admin is asked to type the passphrase.
      if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(`--days must be a whole number from 1 to 3650, got "${args.days}"`, EXIT.usage);
      const reused = args.secretFrom ? readObject(args.secretFrom, 'bundle').pairSecret : undefined;
      if (args.secretFrom && typeof reused !== 'string') return fail(`${args.secretFrom} has no pair secret: pass the bundle produced by \`machine admin register\``);
      const info = readObject(first, 'machine info') as unknown as MachineInfo;
      io.stderr(`Registering "${String(info.name)}" for ${days} day(s). Enter the admin passphrase to sign, Ctrl-C to cancel.\n`);
      const bundle = await registerMachine(configDir, info, { now: epochSeconds, prompt, validForDays: days, ...(typeof reused === 'string' ? { pairSecret: reused } : {}) });
      writeFileAtomic(args.out, `${JSON.stringify(bundle, null, 2)}\n`, 0o600);
      emit({ uuid: bundle.registration.body.uuid, out: args.out }, `[ok] registration written to ${args.out}: copy it to the machine that must trust "${bundle.registration.body.name}" (it contains a secret)\n`);
      return EXIT.ok;
    }
    if (sub === 'login') {
      if (second !== undefined) return fail('usage: machine admin login [<code>] [--relay <url>] [--force]', EXIT.usage);
      // No default relay: given with --relay, or the one of the saved admin token. Checked before a code is asked for.
      const adminRelay = args.relay ?? readRelayAdminConfig(configDir)?.relayUrl;
      if (adminRelay === undefined) return fail('machine admin login needs the relay: `machine admin login <code> --relay <host-or-url>`, for example --relay https://relay.example.com', EXIT.usage);
      let code = first;
      if (code === undefined) {
        try {
          code = await prompt('Full-access pairing code from the relay console: ');
        } catch {
          return fail('no pairing code given and no terminal to ask for it: pass it as `machine admin login <code>` (relay console: Tokens, Add token, WITHOUT "Limited to scopes")', EXIT.usage);
        }
      }
      code = code.trim();
      if (code.length === 0 || code.length > 32) return fail('the pairing code is empty or longer than 32 characters: copy it again from the relay console', EXIT.usage);
      try {
        const r = await adminLogin(configDir, { code, relayUrl: adminRelay, force: args.force });
        if (!existsSync(adminKeyFile(configDir))) io.stderr('[warn] this machine has no admin key yet: run `machine admin init` before `machine admin approve`\n');
        emit({ relayUrl: r.relayUrl, label: r.label }, `[ok] admin token "${r.label}" saved for ${r.relayUrl}; next: \`machine admin approve\` lists the pending candidacies\n`);
        return EXIT.ok;
      } catch (e) {
        if (e instanceof RelayError) return fail(e.message);
        throw e;
      }
    }
    if (sub === 'approve') {
      if (second !== undefined) return fail('usage: machine admin approve [<id>] [--relay <url>] [--days <n>] [--reject]', EXIT.usage);
      // Options of `join` are refused rather than silently ignored: the comparison of the code is never skippable.
      if (args.yesFinalCode !== undefined) return fail('`machine admin approve` has no option to skip the comparison of the code: confirm it at the prompt, in a terminal', EXIT.usage);
      if (args.resume || args.noWait || args.timeout !== undefined) return fail('--resume, --no-wait and --timeout belong to `machine join`, not to `machine admin approve`', EXIT.usage);
      const days = args.days === undefined ? 365 : Number(args.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(`--days must be a whole number from 1 to 3650, got "${args.days}"`, EXIT.usage);
      if (args.reject && first === undefined) return fail('--reject needs the id of the candidacy to reject: run `machine admin approve` to list them', EXIT.usage);
      if (first !== undefined && first.trim().length === 0) return fail('the candidacy id is empty', EXIT.usage);
      try {
        const result = await runApprove(configDir, {
          ...(first !== undefined ? { id: first.trim() } : {}),
          ...(args.relay !== undefined ? { relayUrl: args.relay } : {}),
          days,
          reject: args.reject,
          prompt,
          ask: io.ask ?? promptLine,
          // With --json stdout carries the final JSON only: the human text goes to stderr.
          say: args.json ? io.stderr : io.stdout,
          now: epochSeconds,
        });
        if (result.kind === 'list') {
          emit(result.candidacies, '');
          // A relay that contradicts itself is a failure, not a warning in a list that exits 0.
          return result.candidacies.some((c) => c.blockers.some((b) => b.startsWith('the relay sent a verification code'))) ? EXIT.failure : EXIT.ok;
        }
        if (result.kind === 'rejected') emit({ id: result.candidacy.id, decision: 'reject' }, '');
        else emit({ id: result.candidacy.id, decision: 'approve', name: result.candidacy.name, uuid: result.registered.uuid, adminKeyId: result.adminKeyId, finalCode: result.finalCode }, '');
        return EXIT.ok;
      } catch (e) {
        if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
    }
    if (sub === 'revoke') {
      if (first === undefined || second !== undefined) return fail('usage: machine admin revoke <name|alias|uuid>', EXIT.usage);
      // A revocation has no validity period: refused rather than silently ignored.
      if (args.days !== undefined) return fail('--days does not apply to `machine admin revoke`: a revocation does not expire (it covers the registration serial it names)', EXIT.usage);
      try {
        const r = await runRevoke(configDir, { reference: first, prompt, ask: io.ask ?? promptLine, say: args.json ? io.stderr : io.stdout, now: epochSeconds });
        emit({ revoked: r.uuid, name: r.name, serial: r.serial, scope: 'this machine only' }, '');
        return EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
        if (e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
    }
    return fail('usage: machine admin init | login [<code>] | approve [<id>] | revoke <machine> | pin <admin.json> | register <info.json> --out <bundle> | sign-policy <draft.json>', EXIT.usage);
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
      const bundle = readObject(first, 'bundle') as unknown as PeerBundle;
      if (typeof bundle.registration !== 'object' || bundle.registration === null) throw new Error(`bundle ${first} has no registration: pass the file written by \`machine admin register\``);
      importPeer(configDir, bundle, { now });
      emit({ imported: bundle.registration.body.uuid }, `[ok] this machine now trusts "${bundle.registration.body.name}" (${bundle.registration.body.uuid})\n`);
      return EXIT.ok;
    }
    return fail('usage: machine peer info [--out <file>] | import <bundle.json>', EXIT.usage);
  }

  if (command === 'policy') {
    const [sub, first, second] = rest;
    if (sub !== 'install' || first === undefined || second !== undefined) return fail('usage: machine policy install <signed-policy.json>', EXIT.usage);
    const body = installPolicy(configDir, readObject(first, 'policy') as never, { now });
    emit({ version: body.version }, `[ok] policy version ${body.version} installed (${body.defaults.length} default entries, ${Object.keys(body.peers).length} peer-specific lists)\n`);
    return EXIT.ok;
  }

  if (command === 'join') {
    // Fail before a one-shot code is asked for or spent.
    readMachine(configDir);
    let code: string | undefined;
    let relayUrl = args.relay;
    if (args.resume) {
      if (rest[0] !== undefined) return fail('--resume continues with the saved token and takes no pairing code or relay argument (use --relay to check which relay it belongs to)', EXIT.usage);
      if (args.force) return fail('--resume and --force cannot be combined: --force replaces the token with a new device login or pairing code', EXIT.usage);
    } else {
      if (args.yesFinalCode !== undefined && args.noWait) return fail('--yes-final-code needs the wait: it cannot be combined with --no-wait', EXIT.usage);
      // A positional made of digits is a pairing code, anything else is the relay (URL or bare host). Nothing: device login on the default relay.
      if (rest[0] !== undefined) {
        const given = classifyJoinArgument(rest[0]);
        if (given.kind === 'code') {
          code = given.code;
          if (code.length > 32) return fail('the pairing code is longer than 32 characters: copy it again from the relay console', EXIT.usage);
        } else {
          if (args.relay !== undefined) return fail(`the relay is given twice ("${rest[0]}" and --relay ${args.relay}): give it once`, EXIT.usage);
          relayUrl = given.relayUrl;
        }
      }
    }
    // No default relay, never a silent one: named here, or the one stored by a previous join.
    if (!args.resume) {
      relayUrl ??= readRelayConfig(configDir)?.relayUrl;
      if (relayUrl === undefined) {
        return fail(
          code !== undefined
            ? 'a pairing code needs the relay: `machine join <code> --relay <host-or-url>`, for example --relay relay.example.com (the relay is named once, then stored)'
            : 'machine join needs the relay: `machine join <host>`, for example `machine join relay.example.com` (the relay is named once, then stored)',
          EXIT.usage,
        );
      }
    }
    const timeoutSeconds = args.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(args.timeout);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) return fail(`--timeout must be a whole number of seconds from 1 to 86400, got "${args.timeout}"`, EXIT.usage);

    // Ctrl-C stops the wait cleanly (token and candidacy kept) instead of killing the process mid-write.
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    if (io.timing === undefined) process.once('SIGINT', onSigint);
    const timing = io.timing ?? { ...realTiming(), signal: controller.signal };
    // With --json stdout carries the final JSON only: the human progress goes to stderr.
    const say = args.json ? io.stderr : io.stdout;
    let result;
    try {
      result = await runJoin(configDir, {
        ...(code !== undefined ? { code } : {}),
        resume: args.resume,
        ...(relayUrl !== undefined ? { relayUrl } : {}),
        force: args.force,
        wait: !args.noWait,
        timeoutMs: timeoutSeconds * 1000,
        ...(args.yesFinalCode !== undefined ? { yesFinalCode: args.yesFinalCode } : {}),
        ask: io.ask ?? promptLine,
        timing,
        say,
        // The verification code stands alone on its line, easy to read aloud over a phone or compare in an SSH terminal.
        onPosted: (p) => {
          if (args.json && args.noWait) return;
          say(
            `[ok] ${p.resumed ? 'resuming on' : 'joined'} the relay ${p.relayUrl} as "${p.name}" (token "${p.label}" saved)\n` +
              `Candidacy ${p.candidacyId} posted, valid until ${new Date(p.expiresAt * 1000).toISOString()}.\n` +
              `Verification code (informational, the admin sees the same one; the code that matters is shown after approval):\n\n  ${p.verificationCode}\n\n`,
          );
        },
      });
    } catch (e) {
      if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
      throw e;
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
    // Nothing is started at login by join itself: only a suggestion (stderr with --json, so stdout stays one JSON document).
    const startupHint = 'To start machine at login run: machine startup enable\n';
    if (result.status === 'posted') {
      emit(result.posted, 'next: ask the admin to approve this machine in the admin console and to compare the code above, then run \x60machine join --resume\x60\n' + startupHint);
      if (args.json) io.stderr(startupHint);
      return EXIT.ok;
    }
    const e = result.enrolled;
    const peerLines = e.peers.length > 0 ? 'peers trusted (' + e.peers.length + '):\n' + e.peers.map((p) => '  ' + p.name + ' (' + p.uuid + ')').join('\n') + '\n' : 'peers trusted: none (the admin included none)\n';
    emit(
      { ...e, relayUrl: result.posted.relayUrl },
      '[ok] enrolled "' + e.self.name + '" (' + e.self.uuid + ')\n' + 'admin key pinned: ' + e.adminKeyId + '\n' + peerLines + 'next: the admin installs a policy for this machine, then \x60machine status\x60\n' + startupHint,
    );
    if (args.json) io.stderr(startupHint);
    return EXIT.ok;
  }

  if (command === 'run') {
    // Every failure of `run` that is not the remote command's own exit code is 255, usage errors included.
    try {
      return await runRemote(ctx);
    } catch (e) {
      return fail((e as Error).message, EXIT.peer);
    }
  }

  return undefined;
}

async function runRemote(ctx: CommandContext): Promise<number> {
  const { args, rest, io, configDir } = ctx;
  const fail = ctx.fail;
  const ref = rest[0];
  if (ref === undefined || rest.length > 1 || args.passthrough.length === 0) {
    return fail('usage: machine run <machine> --address <host:port> [--shell cmd|ps|bash|sh] -- <command...>', EXIT.peer);
  }
  const shell = args.shell ?? (process.platform === 'win32' ? 'cmd' : 'sh');
  if (!(SHELLS as readonly string[]).includes(shell)) return fail(`unknown shell "${shell}": expected one of ${SHELLS.join(', ')}`, EXIT.peer);
  if (args.address !== undefined && !parseAddress(args.address)) {
    return fail(`invalid --address "${args.address}": expected <host>:<port>, for example 192.168.1.20:47921 or [::1]:47921`, EXIT.peer);
  }
  // The command is sent byte for byte. Several words are joined with single spaces, which is only faithful when no word
  // holds spaces or quotes: otherwise the user must quote the whole command as one argument.
  if (args.passthrough.length > 1 && args.passthrough.some((word) => /[\s"'`]/.test(word))) {
    return fail('the command has words with spaces or quotes: pass the whole command as ONE quoted argument, for example -- "grep \'foo bar\' file", so that it is sent exactly as written', EXIT.peer);
  }
  const command = args.passthrough.join(' ');

  const self = readMachine(configDir);
  const network = loadNetwork(configDir, epochSeconds());
  const machines = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
  const resolved = resolveMachineRef(ref, machines, readAliases(configDir));
  if (!resolved.ok) return fail(resolved.message, EXIT.peer);
  if (resolved.uuid === self.uuid) return fail('that is this machine: run the command here directly', EXIT.peer);
  const peer = network.directory.find(resolved.uuid);
  if (!peer) return fail(`"${ref}" is not a trusted peer: see \`machine status\` for what was left out and why`, EXIT.peer);
  if (!args.address) {
    return fail(`no address known for "${peer.name}": pass --address <host:port> (automatic address discovery arrives with the relay)`, EXIT.peer);
  }
  const where = parseAddress(args.address) as { host: string; port: number };

  const session = await connectToPeer({
    identity: self.identity,
    host: where.host,
    port: where.port,
    expectedPeerPublicKey: peer.identityPublicKey,
    pairSecret: peer.pairSecret,
  });
  let answer;
  try {
    // The request is dated now, after the connection exists: a slow connection must not age it.
    answer = await runOnPeer(session, { identity: self.identity, source: self.uuid, target: peer.peerId, shell: shell as Shell, command, now: epochSeconds() });
  } finally {
    session.close();
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
  return remoteExitCode(answer.exitCode);
}
