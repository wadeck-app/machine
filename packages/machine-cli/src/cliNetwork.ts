import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_WAIT_NOTICE_DELAY_MS, MAX_DENY_REASON_LENGTH, NO_DENY_REASON_MESSAGE, printable, PROGRESS_INTERVAL_SECONDS, SHELLS, defaultWaitNotice, holdLimitAdvice, notHeldWarning, parseAddress, progressPrinter, resolveRunShell, resolveRunWait, type RunWait, type Shell } from '@wadeck-app/machine-core';
import { refusalListLine } from './allowedView.js';
import { runAllowed } from './cliAllowed.js';
import { whenText } from './humanTime.js';
import { describeAddress, PeerAddressError } from './peerAddresses.js';
import { adminKeyFile, assertCanInitAdminKey, pinAdminKey, signPolicyFile } from './admin.js';
import { createSteps, trackedSay, type Steps } from './steps.js';
import { createAdminKey, runJoinCommand } from './cliJoin.js';
import { recordSignedPolicy, runAllow } from './adminAllow.js';
import { enableAfterJoin } from './cliStartup.js';
import { adminLogin, runApprove } from './adminApprove.js';
import { adminLoginByConsole, AdminLoginInputError, adminLoginName } from './adminDeviceLogin.js';
import { FULL_ACCESS_WARNING } from './adminAccess.js';
import { runDistribute } from './adminDistribute.js';
import { runNotifyTo } from './adminNotifyTo.js';
import { runForgetRelayRecord } from './adminForget.js';
import { runForgetPeerRecord } from './peerForget.js';
import { adminMachineUuid, adminRelayAccess, distributePolicy, formatDistribution } from './distribute.js';
import { directDeliveryFor } from './directDelivery.js';
import { runRevoke, UnresolvedReferenceError } from './adminRevoke.js';
import { EXIT, parseIndex, type CommandContext } from './cliTypes.js';
import { runRemoteRequests } from './cliRequestsRemote.js';
import { connectionOf, makeWakeEnv, pinnedOf, resolveTrustedPeer, runPeerConnect, stderrSinks, targetFor, wakeSettingsFor } from './cliWake.js';
import { connectWithWake } from './wakeConnect.js';
import { writeFileAtomic } from './fsutil.js';
import { NotInitializedError } from './errors.js';
import { APPROVAL_MAX_AGE_SECONDS, classifyJoinArgument, DEFAULT_TIMEOUT_SECONDS, realTiming, runJoin } from './join.js';
import { createRelayClient, RelayError } from './relayClient.js';
import { candidacyFile, readRelayAdminConfig, readRelayConfig } from './relayStore.js';
import { exportMachineInfo, importPeer, installPolicy, installRevocation, loadNetwork, recordRevocationSeen, registerMachine, revocationState, type MachineInfo, type PeerBundle } from './network.js';
import { DEFAULT_PROMPT_TIMEOUT_SECONDS, MAX_PROMPT_TIMEOUT_SECONDS, promptHidden, promptLine, PromptTimeoutError, withPromptTimeout, type PromptLimits } from './prompt.js';
import { runOnPeer } from './peerService.js';
// run-log: every machine run is recorded in the outgoing run log (run-log.md)
import { recordRun, type RunRecorder } from './runLogRecord.js';
import { readRunDefaults } from './runDefaultsStore.js';
import { catchUpRevocations } from './revocationSync.js';
import { runPingCommand } from './cliPing.js';
import { pendingPolicyLine } from './pendingPolicy.js';
import { unknownSubcommandMessage } from './cliHelp.js';
import { runPolicyModeCommand } from './cliPolicy.js';

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

// The same rules as the host of a published address record (machine-core): one definition of what an address is.
export { parseAddress };

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

/** What the person must know after a prompt expired: what was NOT done and how to run it again. */
function promptTimeoutAdvice(e: PromptTimeoutError, command: string, ctx: CommandContext): string {
  const [sub] = ctx.rest;
  const slower = `(\`--prompt-timeout <seconds>\`, 1 to ${MAX_PROMPT_TIMEOUT_SECONDS}, allows a slower answer)`;
  if (command === 'join' || command === 'setup') {
    return `${e.message}. The admin key was NOT pinned and nothing was imported. The approval is kept for ${APPROVAL_MAX_AGE_SECONDS / 60} minutes in ${candidacyFile(ctx.configDir)}: run \`machine join --resume\` and answer in time ${slower}`;
  }
  const done: Record<string, string> = {
    approve: 'Nothing was signed or sent to the relay',
    revoke: 'Nothing was signed or revoked',
    distribute: 'Nothing was signed or sent to the relay',
    'forget-relay-record': 'Nothing was deleted',
    'sign-policy': 'Nothing was signed and no file was written',
    register: 'Nothing was signed and no file was written',
    login: 'Nothing was claimed or stored',
  };
  return `${e.message}. ${done[sub ?? ''] ?? 'Nothing was done'}. Run \`machine ${[command, ...ctx.rest].join(' ')}\` again and answer in time ${slower}`;
}

export async function runNetworkCommand(command: string, ctx: CommandContext): Promise<number | undefined> {
  try {
    return await runNetworkCommandBody(command, ctx);
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw new Error(promptTimeoutAdvice(e, command, ctx));
    throw e;
  }
}

async function runNetworkCommandBody(command: string, ctx: CommandContext): Promise<number | undefined> {
  const { args, rest, io, configDir, env, fail, emit } = ctx;
  // The clock is injectable: the age of an approval and the expiry of a candidacy are checked against it.
  const epochSeconds = () => Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
  const now = epochSeconds();
  // Every wait for a person has a limit (--prompt-timeout, validated by the CLI before this point). Never an implicit answer.
  const limits: PromptLimits = { timeoutSeconds: args.promptTimeout === undefined ? DEFAULT_PROMPT_TIMEOUT_SECONDS : Number(args.promptTimeout), ...(io.promptTimer ? { timer: io.promptTimer } : {}) };
  const prompt = io.prompt ? withPromptTimeout(io.prompt, limits) : (label: string) => promptHidden(label, undefined, limits);
  const askLine = io.ask ? withPromptTimeout(io.ask, limits) : (label: string) => promptLine(label, undefined, limits);

  if (command === 'admin') {
    const [sub, first, second] = rest;
    for (const name of ['MACHINE_PASSPHRASE', 'MACHINE_ADMIN_PASSPHRASE']) {
      if (env[name] !== undefined) {
        io.stderr(`[warn] ${name} is set but ignored: passphrases are only read from the terminal prompt, never from the environment. Unset it\n`);
      }
    }
    if (sub === undefined) {
      // `machine admin` alone (decision 66): what waits for approval, read-only. The list of `admin approve`, without any question and without an approval.
      if (args.reject) return fail('--reject needs the id of the candidacy: `machine admin approve <id> --reject` (`machine admin` alone only lists)', EXIT.usage);
      if (args.days !== undefined) return fail('--days belongs to `machine admin approve <id> --days <n>` (`machine admin` alone only lists)', EXIT.usage);
      const never = (what: string) => async (): Promise<string> => {
        throw new Error(`internal error: \`machine admin\` alone must not ask ${what}`);
      };
      try {
        const result = await runApprove(configDir, {
          listOnly: true,
          ...(args.relay !== undefined ? { relayUrl: args.relay } : {}),
          days: 365,
          reject: false,
          verbose: args.verbose,
          prompt: never('the passphrase'),
          ask: never('a question'),
          say: args.json ? io.stderr : io.stdout,
          now: epochSeconds,
        });
        if (result.kind !== 'list') throw new Error('internal error: `machine admin` alone must only list');
        emit(result.candidacies, '');
        return result.candidacies.some((c) => c.blockers.some((b) => b.startsWith('the relay sent a verification code'))) ? EXIT.failure : EXIT.ok;
      } catch (e) {
        if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
    }
    if (sub === 'init') {
      if (first !== undefined) return fail(`unexpected argument "${first}" for \`machine admin init\``, EXIT.usage);
      // The existing-key check comes before any question, and before the first header.
      assertCanInitAdminKey(configDir);
      const say = trackedSay(args.json ? io.stderr : io.stdout);
      const steps = createSteps(say, [
        { key: 'passphrase', title: 'Admin passphrase' },
        { key: 'done', title: 'Done' },
      ]);
      steps.begin('passphrase');
      const r = await createAdminKey(ctx, prompt, askLine, say);
      steps.begin('done');
      emit({ adminKeyId: r.adminKeyId, adminPublicKey: r.adminPublicKey }, `[ok] admin key created (id ${r.adminKeyId})\n\nnext: \`machine join <relay>\` enrolls this machine (it approves itself), \`machine setup <relay>\` does everything in one command\n`);
      return EXIT.ok;
    }
    if (sub === 'allow') {
      const usage = 'usage: machine admin allow <machine> [--shell cmd|ps|bash|sh] [--times <n> | --for <duration> | --until <date>] [--renew] [--out <file>] -- <command...> | machine admin allow <machine> --remove [--shell <shell>] (-- <command...> | --index <n>) | machine admin allow <machine> --list';
      if (first === undefined) return fail(usage, EXIT.usage);
      if (args.list && args.remove) return fail(`--list and --remove cannot be combined. ${usage}`, EXIT.usage);
      if (args.shell !== undefined && !(SHELLS as readonly string[]).includes(args.shell)) return fail(`unknown shell "${args.shell}": expected one of ${SHELLS.join(', ')}`, EXIT.usage);
      // The command is what follows "--", or the words after the machine; sent byte for byte like `machine run`.
      const words = args.passthrough.length > 0 ? args.passthrough : rest.slice(2);
      const parsedIndex = parseIndex(args.index);
      const index = parsedIndex.ok ? parsedIndex.index : undefined;
      if (!parsedIndex.ok) {
        return fail(parsedIndex.message, EXIT.usage);
      }
      if (index !== undefined && words.length > 0) {
        return fail(`--index replaces the command: give one or the other. ${usage}`, EXIT.usage);
      }
      if (args.list) {
        if (words.length > 0) return fail(`--list takes no command. ${usage}`, EXIT.usage);
      } else if (index === undefined) {
        if (words.length === 0) return fail(usage, EXIT.usage);
        if (words.length > 1 && words.some((word) => /[\s"'`]/.test(word))) {
          return fail('the command has words with spaces or quotes: pass the whole command as ONE quoted argument, for example -- "grep \'foo bar\' file", so that it is allowed exactly as written', EXIT.usage);
        }
      }
      if (args.out && existsSync(args.out) && !args.force) return fail(`${args.out} already exists: choose another file or pass --force to overwrite it`);
      const mode = args.list ? 'list' : args.remove ? 'remove' : 'allow';
      try {
        const r = await runAllow(configDir, {
          reference: first,
          mode,
          ...(mode !== 'list' && index === undefined ? { command: words.join(' ') } : {}),
          ...(index !== undefined ? { index } : {}),
          ...(mode === 'allow' ? { lifetime: { ...(args.times !== undefined ? { times: args.times } : {}), ...(args.for !== undefined ? { for: args.for } : {}), ...(args.until !== undefined ? { until: args.until } : {}) } } : {}),
          ...(mode === 'allow' && args.renew ? { renew: true } : {}),
          ...(args.shell !== undefined ? { shell: args.shell as Shell } : {}),
          ...(args.out !== undefined ? { out: args.out } : {}),
          prompt,
          ask: askLine,
          say: args.json ? io.stderr : io.stdout,
          now: epochSeconds,
        });
        emit(r, '');
        return r.kind === 'signed' && r.failed ? EXIT.failure : EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
        if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
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
      const { signed, privateKeyPkcs8 } = await signPolicyFile(configDir, first, {
        now,
        prompt,
        onSummary: (summary) => io.stderr(`${summary}\nSigning this exact policy. Enter the admin passphrase to confirm, Ctrl-C to cancel.\n`),
      });
      // The base of the next `machine admin allow` for this machine.
      recordSignedPolicy(configDir, signed);
      const text = `${JSON.stringify(signed, null, 2)}\n`;
      if (args.out) {
        writeFileAtomic(args.out, text, 0o644);
        io.stderr(`[ok] signed policy written to ${args.out}\n`);
      } else {
        io.stdout(text);
      }
      // The file is written first: a distribution problem never loses the signed policy.
      const access = adminRelayAccess(configDir);
      if (access === undefined) {
        const how = args.out ? `machine admin distribute --policy ${args.out}` : 'save it with --out <file>, then run `machine admin distribute --policy <file>`';
        io.stderr(`[warn] policy NOT distributed to the relay: this machine has no admin relay token. Run \`machine admin login\` (confirm the request in the relay console), then \`${how}\`; or install the file on the target with \`machine policy install\`\n`);
        return EXIT.ok;
      }
      const report = await distributePolicy(signed, { client: access.client, adminPrivateKeyPkcs8: privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: epochSeconds, configDir, direct: directDeliveryFor(configDir) });
      const formatted = formatDistribution(report, 'the signed policy', args.out ? `machine admin distribute --policy ${args.out}` : 'machine admin distribute --policy <file>');
      if (formatted.out) io.stderr(formatted.out);
      if (formatted.failed) {
        io.stderr(formatted.err);
        return EXIT.failure;
      }
      return EXIT.ok;
    }
    if (sub === 'distribute') {
      if (second !== undefined || (first === undefined) === (args.policy === undefined)) {
        return fail('usage: machine admin distribute <machine|uuid> | machine admin distribute --policy <signed-policy.json>', EXIT.usage);
      }
      try {
        const r = await runDistribute(configDir, {
          ...(first !== undefined ? { reference: first } : {}),
          ...(args.policy !== undefined ? { policyFile: args.policy } : {}),
          prompt,
          say: args.json ? io.stderr : io.stdout,
          now: epochSeconds,
        });
        io.stdout(args.json ? '' : r.formatted.out);
        if (args.json) io.stdout(`${JSON.stringify({ what: r.what, ...r.report }, null, 2)}\n`);
        if (r.formatted.failed) {
          io.stderr(r.formatted.err);
          return EXIT.failure;
        }
        return EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
        if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
    }
    if (sub === 'notify-to') {
      // Which machines receive request notices (request-notices.md): `--list` reads, machines sign and send a new list.
      const names = rest.slice(1);
      if ((args.list && names.length > 0) || (!args.list && names.length === 0)) {
        return fail('usage: machine admin notify-to <machine> [<machine>...] | machine admin notify-to --list', EXIT.usage);
      }
      try {
        const r = await runNotifyTo(configDir, { ...(args.list ? {} : { references: names }), prompt, say: args.json ? io.stderr : io.stdout, now: epochSeconds });
        io.stdout(args.json ? `${JSON.stringify({ recipients: r.recipients, ...(r.report ?? {}) }, null, 2)}
` : r.out);
        if (r.formatted?.failed) {
          io.stderr(r.formatted.err);
          return EXIT.failure;
        }
        return EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) {
          const { message } = e;
          return fail(message, EXIT.reference);
        }
        if (e instanceof RelayError || e instanceof NotInitializedError) {
          const { message } = e;
          return fail(message);
        }
        throw e;
      }
    }
    if (sub === 'forget-relay-record') {
      if (first === undefined || second !== undefined) return fail('usage: machine admin forget-relay-record <machine|uuid>', EXIT.usage);
      try {
        const r = await runForgetRelayRecord(configDir, { reference: first, ask: askLine, say: args.json ? io.stderr : io.stdout, now: epochSeconds });
        emit({ forgot: r.uuid, ...(r.name !== undefined ? { name: r.name } : {}) }, '');
        return EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
        if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
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
      if (second !== undefined) return fail('usage: machine admin login [<code>] [--relay <url>] [--force] [--full-access]', EXIT.usage);
      // No default relay: given with --relay, or the one of the saved admin token. Checked before a code is asked for.
      const adminRelay = args.relay ?? readRelayAdminConfig(configDir)?.relayUrl;
      if (adminRelay === undefined) return fail('machine admin login needs the relay: `machine admin login --relay <host-or-url>`, for example --relay https://relay.example.com (the relay is named once, then the stored one is reused)', EXIT.usage);
      // `warnFull`: the console login already said it (a [warn] line); the pairing code path says it here.
      const finish = (r: { relayUrl: string; label: string; scopes: string[] | null }, warnFull: boolean, steps?: Steps): number => {
        steps?.begin('done');
        if (!existsSync(adminKeyFile(configDir))) io.stderr('[warn] this machine has no admin key yet: run `machine admin init` before `machine admin approve`\n');
        if (r.scopes === null && warnFull) io.stderr(`${FULL_ACCESS_WARNING}\n`);
        emit({ relayUrl: r.relayUrl, label: r.label, scopes: r.scopes }, `[ok] admin token "${r.label}" saved for ${r.relayUrl}${r.scopes === null ? '' : ' (MACHINE ADMIN: it cannot manage tokens)'}; next: \`machine admin approve\` lists the pending candidacies\n`);
        return EXIT.ok;
      };
      try {
        if (first !== undefined) {
          // A code: the pairing path, kept for scripts and for relays that predate the confirm-only login.
          const code = first.trim();
          if (code.length === 0 || code.length > 32) return fail('the pairing code is empty or longer than 32 characters: copy it again from the relay console', EXIT.usage);
          return finish(await adminLogin(configDir, { code, relayUrl: adminRelay, force: args.force, fullAccess: args.fullAccess }), true);
        }
        // No code: the admin confirms a request in the relay console (decision 59). Ctrl-C stops the wait cleanly.
        const controller = new AbortController();
        const onSigint = () => controller.abort();
        if (io.timing === undefined) process.once('SIGINT', onSigint);
        // The pairing-code path above is one action and has no header; the console login is a request, a wait, then the result.
        const say = trackedSay(args.json ? io.stderr : io.stdout);
        const steps = createSteps(say, [
          { key: 'login', title: 'Relay login' },
          { key: 'done', title: 'Done' },
        ]);
        try {
          const timing = io.timing ?? { ...realTiming(), signal: controller.signal };
          steps.begin('login');
          const r = await adminLoginByConsole(configDir, {
            relayUrl: adminRelay,
            force: args.force,
            name: adminLoginName(configDir, io.hostname),
            timing,
            say,
            askPairingCode: () => prompt('Full-access pairing code (8 digits): '),
            ...(args.fullAccess ? { access: 'full' as const } : {}),
            ...(io.now ? { now: io.now } : {}),
          });
          return finish(r, false, steps);
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      } catch (e) {
        if (e instanceof AdminLoginInputError) return fail(e.message, EXIT.usage);
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
          verbose: args.verbose,
          headers: true,
          prompt,
          ask: askLine,
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
        else {
          emit({ id: result.candidacy.id, decision: 'approve', name: result.candidacy.name, uuid: result.registered.uuid, adminKeyId: result.adminKeyId, finalCode: result.finalCode, distribution: result.distribution.report ?? null }, '');
          // The approval stands whatever happened to the distribution; a failure is loud and exits 1 so that a script notices.
          if (result.distribution.formatted.err) io.stderr(result.distribution.formatted.err);
          if (result.distribution.formatted.failed) return EXIT.failure;
        }
        return EXIT.ok;
      } catch (e) {
        if (first !== undefined && args.optionLike.includes(first) && e instanceof Error && e.message.startsWith('no pending candidacy matches')) {
          return fail(`unknown option "${first}": see \`machine --help\` (and it is not the id of a pending candidacy either: run \`machine admin approve\` to list them)`, EXIT.usage);
        }
        if (e instanceof RelayError || e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
    }
    if (sub === 'revoke') {
      if (first === undefined || second !== undefined) return fail('usage: machine admin revoke <name|alias|uuid>', EXIT.usage);
      // A revocation has no validity period: refused rather than silently ignored.
      if (args.days !== undefined) return fail('--days does not apply to `machine admin revoke`: a revocation does not expire (it covers the registration serial it names)', EXIT.usage);
      try {
        const r = await runRevoke(configDir, { reference: first, prompt, ask: askLine, say: args.json ? io.stderr : io.stdout, now: epochSeconds });
        emit({ revoked: r.uuid, name: r.name, serial: r.serial, distribution: r.distribution?.report ?? null }, '');
        if (r.distribution?.formatted.err) io.stderr(r.distribution.formatted.err);
        // The revocation stands; a distribution failure is loud and exits 1.
        return r.distribution?.formatted.failed ? EXIT.failure : EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
        if (e instanceof NotInitializedError) return fail(e.message);
        throw e;
      }
    }
    return fail(unknownSubcommandMessage('admin', sub), EXIT.usage);
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
    if (sub === 'connect') return await runPeerConnect(ctx);
    if (sub === 'forget-record') {
      if (first === undefined || second !== undefined) return fail('usage: machine peer forget-record <peer>', EXIT.usage);
      try {
        const r = await runForgetPeerRecord(configDir, { reference: first, ask: askLine, say: args.json ? io.stderr : io.stdout, now: epochSeconds });
        emit({ forgot: r.uuid, ...(r.name !== undefined ? { name: r.name } : {}), hadRecord: r.hadRecord }, '');
        return EXIT.ok;
      } catch (e) {
        if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
        if (e instanceof NotInitializedError || e instanceof PeerAddressError) return fail(e.message);
        throw e;
      }
    }
    return fail(unknownSubcommandMessage('peer', sub), EXIT.usage);
  }

  if (command === 'policy') {
    const [sub, first, second] = rest;
    if (sub === 'local' || sub === 'delegate' || sub === 'allow') return await runPolicyModeCommand(ctx, { prompt, ask: askLine });
    if (sub !== 'install') return fail(unknownSubcommandMessage('policy', sub), EXIT.usage);
    if (first === undefined || second !== undefined) return fail('usage: machine policy install <signed-policy.json>; see `machine policy --help`', EXIT.usage);
    const body = installPolicy(configDir, readObject(first, 'policy') as never, { now });
    emit({ version: body.version }, `[ok] policy version ${body.version} installed (${body.defaults.length} default entries, ${Object.keys(body.peers).length} peer-specific lists)\n`);
    return EXIT.ok;
  }

  if (command === 'join' || command === 'setup') return await runJoinCommand(ctx, { setup: command === 'setup', prompt, ask: askLine });

  if (command === 'ping') return await runPingCommand(ctx);

  // `machine requests <machine>` and `--all` (decision 74); `machine requests` alone is handled by cli.ts (this machine's own log).
  if (command === 'requests') return await runRemoteRequests(ctx, prompt);

  if (command === 'allowed') return runAllowed(ctx);

  if (command === 'run') {
    // Every failure of `run` that is not the remote command's own exit code is 255, usage errors included.
    try {
      return await recordRun({ configDir: ctx.configDir, stderr: ctx.io.stderr }, (recorder) => runRemote(ctx, recorder)); // run-log
    } catch (e) {
      return fail((e as Error).message, EXIT.peer);
    }
  }

  return undefined;
}

async function runRemote(ctx: CommandContext, recorder: RunRecorder): Promise<number> { // run-log
  const { args, rest, io, configDir } = ctx;
  const fail = ctx.fail;
  const ref = rest[0];
  if (ref === undefined || rest.length > 1 || args.passthrough.length === 0) {
    return fail('usage: machine run <machine> [--address <host:port>] [--shell cmd|ps|bash|sh] [--no-wait | --wait <10s..60m> | --on-refusal wait|fail] -- <command...>', EXIT.peer);
  }
  // What to do when the target does not allow the command yet: flags, then the machine setting, then the built-in default (wait 10m). A bad flag, a contradiction and a damaged setting are refused before anything is read or sent.
  let wait: RunWait;
  try {
    wait = resolveRunWait({ ...(args.onRefusal !== undefined ? { onRefusal: args.onRefusal } : {}), ...(args.wait !== undefined ? { wait: args.wait } : {}), ...(args.noWait ? { noWait: true } : {}) }, readRunDefaults(configDir));
  } catch (e) {
    return fail((e as Error).message, EXIT.peer);
  }
  const waitSeconds = wait.onRefusal === 'wait' ? wait.seconds : undefined;
  // An unknown --shell is refused before anything is read or sent; the shell itself is chosen below, once the connections.json of the peer is read.
  if (args.shell !== undefined && !(SHELLS as readonly string[]).includes(args.shell)) return fail(`unknown shell "${args.shell}": expected one of ${SHELLS.join(', ')}`, EXIT.peer);
  if (args.address !== undefined && !parseAddress(args.address)) {
    return fail(`invalid --address "${args.address}": expected <host>:<port>, for example 192.168.1.20:47921 or [::1]:47921`, EXIT.peer);
  }
  // The command is sent byte for byte. Several words are joined with single spaces, which is only faithful when no word
  // holds spaces or quotes: otherwise the user must quote the whole command as one argument.
  if (args.passthrough.length > 1 && args.passthrough.some((word) => /[\s"'`]/.test(word))) {
    return fail('the command has words with spaces or quotes: pass the whole command as ONE quoted argument, for example -- "grep \'foo bar\' file", so that it is sent exactly as written', EXIT.peer);
  }
  const command = args.passthrough.join(' ');

  const trusted = resolveTrustedPeer(ctx, ref, { reference: EXIT.peer, failure: EXIT.peer });
  if ('exit' in trusted) return trusted.exit;
  const { self, peer } = trusted;
  // How this machine reaches the peer (decision 62): pinned addresses win over the relay record, and the type or --wake / --no-wake decides whether a peer that cannot be reached is woken.
  const read = connectionOf(ctx, peer);
  if (!read.ok) return EXIT.peer;
  // The shell is part of the exact entry: --shell, else the default of this peer on this machine (`machine peer connect <peer> --shell`), else the platform of this machine.
  const chosen = resolveRunShell({ explicit: args.shell, peerDefault: read.connection?.shell, platform: process.platform });
  const shell: Shell = chosen.shell;
  if (chosen.source === 'peer-default') io.stderr(`[info] shell ${shell}: the default of ${peer.name} (machine peer connect ${peer.name} --shell; --shell overrides it)\n`);
  const wakeSettings = wakeSettingsFor(ctx, peer, read.connection);
  if (!wakeSettings.ok) return fail(wakeSettings.message, EXIT.peer);
  // run-log: from here the run is recorded, whatever its end
  recorder.target({ self: { name: self.name, uuid: self.uuid }, peer: { name: peer.name, uuid: peer.peerId }, shell, command, wait });
  // The same resolution and connection as `machine ping` (peerConnect.ts): the address override, the pinned addresses, or the verified record of the relay.
  const sinks = stderrSinks(ctx);
  const target = await targetFor(ctx, peer, read.connection, sinks.warn);
  const { connected } = await connectWithWake(makeWakeEnv(ctx, trusted, { requestedBy: 'run', sinks, pinned: pinnedOf(read.connection) }), target, wakeSettings.settings);
  for (const failure of connected.failures) io.stderr(`[warn] ${failure}; connected through ${describeAddress(connected.address)}
`);
  const session = connected.session;
  // Said once: a wait nobody typed must never be a surprise (stderr only, --json keeps stdout one document). Only when the answer is not
  // immediate, so that an allowed command keeps a clean stderr (the target sends no "held" frame, and an older caller would not understand one).
  const notice = defaultWaitNotice(peer.name, wait);
  let answer;
  try {
    // Before any request: exchange the revocation lists (a revocation the relay never delivered still reaches whoever meets a peer that has it).
    const catchUp = await catchUpRevocations(session, {
      state: () => revocationState(configDir),
      install: (signed) => installRevocation(configDir, signed, { now: epochSeconds() }),
      seen: (peerUuid, announced) => recordRevocationSeen(configDir, peerUuid, announced, epochSeconds(), (warning) => io.stderr(`[warn] ${warning}
`)),
      peerId: peer.peerId,
      peerLabel: peer.name,
      peerTrusted: () => loadNetwork(configDir, epochSeconds()).directory.find(peer.peerId) !== undefined,
    });
    for (const warning of catchUp.warnings) io.stderr(`[warn] ${warning}
`);
    if (catchUp.installed) io.stderr(`[info] ${peer.name} handed over revocations this machine did not have yet: they are installed
`);
    // The request is dated now, after the connection exists: a slow connection must not age it.
    recorder.sending(); // run-log
    // One line per minute: the tick is every 30 s but the text changes once a minute (a repeated line is not printed).
    const nextProgress = progressPrinter(peer.name);
    answer = await runOnPeer(session, {
      identity: self.identity,
      source: self.uuid,
      target: peer.peerId,
      shell: shell as Shell,
      command,
      now: epochSeconds(),
      ...(waitSeconds !== undefined
        ? {
            waitSeconds,
            ...(notice !== undefined ? { notice: { afterMs: io.waitNoticeMs ?? DEFAULT_WAIT_NOTICE_DELAY_MS, onNotice: () => io.stderr(`[info] ${notice}\n`) } } : {}),
            // stderr only: --json keeps stdout one document.
            progress: { everyMs: io.waitProgressMs ?? PROGRESS_INTERVAL_SECONDS * 1000, onTick: (left: number) => {
              const line = nextProgress(left);
              if (line !== undefined) {
                io.stderr(`[info] ${line}\n`);
              }
            } },
          }
        : {}),
    });
  } finally {
    session.close();
  }
  recorder.answered(answer); // run-log
  if (answer.type === 'refused') {
    // The fix is the command to run on the admin machine, with this exact command (an exact match is the only rule).
    // A peer that manages its own list (policy mode local) cannot be changed from here: its refusal message names the owner (the caller does not know the mode).
    const quoted = /[\s"'`]/.test(command) ? `"${command}"` : command;
    // When the target says the same command is allowed under another shell, adding it under this one would widen the list for nothing: its hint is the whole advice.
    const otherShell = answer.allowedShells !== undefined && answer.allowedShells.length > 0;
    // The owner (or the deadline) already answered a held request: the fix is to ask again, with a longer wait or after the owner is ready.
    const notHeld = waitSeconds !== undefined && answer.held === undefined && (answer.reason === 'not-listed' || answer.reason === 'no-policy') && !otherShell;
    const how = answer.reason === 'not-listed' && !otherShell ? `. To allow it, on the admin machine run: machine admin allow ${peer.name} --shell ${shell} -- ${quoted} (if ${peer.name} manages its own allow list, run \`machine policy allow --shell ${shell} -- ${quoted}\` on ${peer.name} instead)` : '';
    // Decision 70: a policy signed here a moment ago and not installed yet explains no-policy / not-listed: say so (one line).
    const pending = pendingPolicyLine(configDir, { uuid: peer.peerId, name: peer.name }, { reason: answer.reason, shell, command, selfUuid: self.uuid }, epochSeconds(), (w) => io.stderr(`[warn] ${w}\n`));
    // What the policy signed HERE allows for this machine (local knowledge: the target never sends its list, T-03).
    const listed = answer.reason === 'not-listed' ? refusalListLine(configDir, { uuid: peer.peerId, name: peer.name }, self.uuid, (w) => io.stderr(`[warn] ${w}\n`)) : undefined;
    const notHeldText = notHeld ? notHeldWarning(peer.name, wait) : undefined;
    const heldNote = notHeldText !== undefined ? `\n[warn] ${notHeldText}` : '';
    // The hold limits of the target now apply to every default run: say what to do.
    const limitAdvice = waitSeconds !== undefined ? holdLimitAdvice(answer.reason, peer.name) : undefined;
    // A Deny: the text is the owner's (a peer's text reaches this terminal: control characters become `?`, T-42), and the fixed no-reason sentence already says "denied".
    const why = answer.reason === 'denied' ? (answer.message === NO_DENY_REASON_MESSAGE ? answer.message : `denied: ${printable(answer.message, MAX_DENY_REASON_LENGTH + 3)}`) : `${answer.reason}: ${answer.message}`;
    return fail(`refused by ${peer.name}: ${why}${how}${limitAdvice !== undefined ? `. ${limitAdvice}` : ''}${heldNote}${pending !== undefined ? `\n${pending}` : ''}${listed !== undefined ? `\n${listed}` : ''}`, EXIT.peer);
  }
  if (args.json) {
    io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
  } else {
    if (answer.stdout) io.stdout(answer.stdout);
    if (answer.stderr) io.stderr(answer.stderr);
  }
  if (answer.timedOut) io.stderr('[warn] the command was stopped: it exceeded the time limit of the peer\n');
  if (answer.truncated) io.stderr('[warn] the output was cut: it exceeded the output limit of the peer\n');
  // A peer older than decision 70 never sends it. The value comes from the peer: only a plain code page name is shown.
  if (typeof answer.decodedFrom === 'string' && /^cp\d{3,5}$/.test(answer.decodedFrom)) io.stderr(`[info] output decoded from the target's code page ${answer.decodedFrom}\n`);
  if (answer.outputNotUtf8) io.stderr('[warn] the output is not valid UTF-8 (probably an OEM code page): accented characters may be wrong\n');
  return remoteExitCode(answer.exitCode);
}
