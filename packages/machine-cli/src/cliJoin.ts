import { AdminLoginInputError, adminLoginByConsole } from './adminDeviceLogin.js';
import { adminLoginFix } from './adminAccess.js';
import { existsSync } from 'node:fs';
import { adminInit, adminKeyFile, askAdminPassphrase, assertCanInitAdminKey, type Prompt } from './admin.js';
import { missingAdminTokenMessage, runApprove } from './adminApprove.js';
import { enableAfterJoin } from './cliStartup.js';
import { expiryText } from './humanTime.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { ensureMachine, machineExists, readMachine } from './identity.js';
import { createSteps, trackedSay, type StepDef } from './steps.js';
import { classifyJoinArgument, DEFAULT_TIMEOUT_SECONDS, realTiming, runJoin } from './join.js';
import { PromptTimeoutError } from './prompt.js';
import { chooseAllowList, type AllowListMode } from './allowListStep.js';
import { readPolicyMode } from './policyMode.js';
import { runLocalEnable } from './policyLocal.js';
import { AccessLoginUnsupportedError, normalizeRelayUrl, RelayError } from './relayClient.js';
import { readCandidacy, readRelayAdminConfig, readRelayConfig } from './relayStore.js';

// `machine join` and `machine setup` (decision 53): one command per machine. The identity is created on the way; the machine that
// holds the admin key approves its own enrollment; `setup` also creates the admin key and does ONE login in the relay console (decision 59): the
// token of the machine-admin scope is the relay token of this machine AND its admin token (one confirmation, nothing to copy).

/**
 * Create the admin key (decision 51): the passphrase is chosen at the hidden prompt (typed twice) or generated. The
 * existing-key check comes before any question. Nothing secret reaches stdout: a generated passphrase goes to stderr once.
 */
export async function createAdminKey(
  ctx: CommandContext,
  prompt: Prompt,
  ask: (label: string) => Promise<string>,
  /** The output of the prose (default: stdout, or stderr with --json); the caller passes its tracked one so that the step headers see it. */
  say: (text: string) => void = ctx.args.json ? ctx.io.stderr : ctx.io.stdout,
): Promise<ReturnType<typeof adminInit>> {
  const { args, io, configDir } = ctx;
  assertCanInitAdminKey(configDir);
  const { chosen, advice, hint } = await askAdminPassphrase(prompt, {
    generate: args.generate,
    ...(args.hint !== undefined ? { hint: args.hint } : {}),
    say,
    warn: io.stderr,
    ask,
  });
  const r = adminInit(configDir, chosen, hint);
  if (r.generated) {
    // The passphrase goes to the terminal channel only: stdout may be redirected or captured in a log.
    io.stderr(`\nAdmin passphrase (shown only once, write it down now; it cannot be recovered):\n\n  ${r.passphrase}\n\n`);
  } else {
    io.stderr('\n[info] admin passphrase set. It cannot be recovered: if you forget it, no machine can sign or approve any more\n');
    if (advice !== undefined) io.stderr(`[warn] ${advice}\n`);
  }
  return r;
}

export interface JoinCommandOptions {
  setup: boolean;
  /** Hidden passphrase prompt. */
  prompt: Prompt;
  /** Visible question. */
  ask: (label: string) => Promise<string>;
}

export async function runJoinCommand(ctx: CommandContext, o: JoinCommandOptions): Promise<number> {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const epochSeconds = () => Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
  // With --json stdout carries the final JSON only: the human progress goes to stderr.
  const say = trackedSay(args.json ? io.stderr : io.stdout);
  const verb = o.setup ? 'setup' : 'join';

  let code: string | undefined;
  let relayUrl = args.relay;
  if (o.setup) {
    if (args.resume) return fail('`machine setup` has no --resume: to continue an enrollment that was interrupted run `machine join --resume`', EXIT.usage);
    if (args.noWait) return fail('--no-wait does not apply to `machine setup`: this machine approves its own enrollment, there is nothing to wait for', EXIT.usage);
    if (args.yesFinalCode !== undefined) return fail('--yes-final-code does not apply to `machine setup`: this machine created the admin key, there is no code to compare', EXIT.usage);
    if (rest[0] !== undefined) {
      const given = classifyJoinArgument(rest[0]);
      if (given.kind === 'code') return fail('`machine setup` takes the relay, not a pairing code: it asks for the relay login itself (one request you confirm in the relay console) (`machine setup <relay-host>`)', EXIT.usage);
      if (args.relay !== undefined) return fail(`the relay is given twice ("${rest[0]}" and --relay ${args.relay}): give it once`, EXIT.usage);
      relayUrl = given.relayUrl;
    }
  } else if (args.resume) {
    if (rest[0] !== undefined) return fail('--resume continues with the saved token and takes no pairing code or relay argument (use --relay to check which relay it belongs to)', EXIT.usage);
    if (args.force) return fail('--resume and --force cannot be combined: --force replaces the token with a new device login or pairing code', EXIT.usage);
  } else {
    if (args.yesFinalCode !== undefined && args.noWait) return fail('--yes-final-code needs the wait: it cannot be combined with --no-wait', EXIT.usage);
    // A positional made of digits is a pairing code, anything else is the relay (URL or bare host). Nothing: device login on the stored relay.
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
          : `machine ${verb} needs the relay: \`machine ${verb} <host>\`, for example \`machine ${verb} relay.example.com\` (the relay is named once, then stored)`,
        EXIT.usage,
      );
    }
  }
  const timeoutSeconds = args.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(args.timeout);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) return fail(`--timeout must be a whole number of seconds from 1 to 86400, got "${args.timeout}"`, EXIT.usage);

  // Decision 70: who manages the allow list of this machine. The choice is asked after the enrolment; the flag answers it up front.
  const policyFlag = args.policy as AllowListMode | undefined;
  if (policyFlag !== undefined && args.noWait) {
    return fail('--policy cannot be combined with --no-wait: the allow list is chosen once this machine is enrolled; give --policy to `machine join --resume` (or answer the question there)', EXIT.usage);
  }
  const alreadyLocal = readPolicyMode(configDir).mode === 'local';
  if (policyFlag === 'admin' && alreadyLocal) {
    return fail('--policy admin: this machine already manages its own allow list (policy mode local); `machine policy delegate` gives it back to the admin', EXIT.usage);
  }
  // The steps of the path this command takes (decision 67): known now, so that the total is exact. A step already done is shown as one line.
  const allowListStep: StepDef[] = args.noWait ? [] : [{ key: 'allow-list', title: 'Allow list', ...(alreadyLocal ? { skipped: 'policy mode local' } : {}) }];
  const holdsKey = existsSync(adminKeyFile(configDir));
  const selfApproving = o.setup || (holdsKey && !args.noWait);
  const identityDone = machineExists(configDir);
  const approvalKept = args.resume && readCandidacy(configDir)?.approval !== undefined;
  const plan: StepDef[] = o.setup
    ? [
        { key: 'identity', title: 'Identity', ...(identityDone ? { skipped: true as const } : {}) },
        { key: 'admin-key', title: 'Admin passphrase', ...(holdsKey ? { skipped: true as const } : {}) },
        { key: 'login', title: 'Relay login', ...(readRelayAdminConfig(configDir) !== undefined ? { skipped: true as const } : {}) },
        { key: 'candidacy', title: 'Enrolment of this machine' },
        ...allowListStep,
        { key: 'done', title: 'Summary and next steps' },
      ]
    : [
        { key: 'identity', title: 'Identity', ...(identityDone ? { skipped: true as const } : {}) },
        { key: 'login', title: 'Relay login', ...(args.resume ? { skipped: true as const } : {}) },
        {
          key: 'candidacy',
          title: args.noWait ? 'Candidacy posted' : selfApproving ? 'Candidacy posted and approved by this machine' : 'Candidacy posted, waiting for the admin',
          ...(approvalKept ? { skipped: true as const } : {}),
        },
        // Nothing to compare when this machine approves itself, and no approval to compare before the admin acted.
        ...(selfApproving || args.noWait ? [] : [{ key: 'compare', title: 'Security code comparison' }]),
        ...allowListStep,
        { key: 'done', title: args.noWait ? 'Next steps' : 'Done' },
      ];
  const steps = createSteps(say, plan);
  const skippedKeys = new Set(plan.filter((d) => d.skipped !== undefined).map((d) => d.key));
  // A step that is not on this path (or is already done) is not entered: the callers of runJoin do not know which path they are on.
  const enter = (key: string): void => {
    if (steps.has(key) && !skippedKeys.has(key)) steps.begin(key);
  };

  // The identity: created here when there is none (name from --name or from the computer name, decision 52). Before any one-shot code is spent.
  try {
    if (!identityDone) enter('identity');
    if (args.resume) {
      readMachine(configDir);
      if (args.name !== undefined) ensureMachine(configDir, { name: args.name });
    } else {
      const ensured = ensureMachine(configDir, { ...(args.name !== undefined ? { name: args.name } : {}), ...(io.hostname ? { hostname: io.hostname } : {}) });
      if (ensured.note !== undefined) io.stderr(`[info] ${ensured.note}\n\n`);
      // The step says what it did (an identity that already existed is "(already done)" and says nothing).
      if (ensured.created) say(`[ok] identity created: "${ensured.machine.name}" (${ensured.machine.uuid})\n`);
    }
  } catch (e) {
    if (e instanceof NotInitializedError) return fail(e.message);
    throw e;
  }

  const effectiveRelay = args.resume ? readRelayConfig(configDir)?.relayUrl : relayUrl === undefined ? undefined : normalizeRelayUrl(relayUrl);
  let passphrase: string | undefined;
  // Ctrl-C stops a wait cleanly (token and candidacy kept) instead of killing the process mid-write.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  const timing = io.timing ?? { ...realTiming(), signal: controller.signal };

  // `setup`: the admin key and the relay login, when this machine has none yet. Both are kept on a re-run.
  if (o.setup) {
    try {
      if (!holdsKey) {
        // The existing-key check comes before any question, and before the header.
        assertCanInitAdminKey(configDir);
        enter('admin-key');
        const created = await createAdminKey(ctx, o.prompt, o.ask, say);
        passphrase = created.passphrase;
        say(`[ok] admin key created (id ${created.adminKeyId})\n`);
      } else if (args.hint !== undefined) {
        io.stderr('[warn] --hint ignored: the admin key already exists on this machine, its hint cannot change here\n\n');
      }
      if (readRelayAdminConfig(configDir) === undefined) {
        enter('login');
        // ONE login confirmed in the relay console (decision 59): a token of the machine-admin scope. Without a relay token yet it is also this machine's
        // relay token (relay.json), so the second login of the old flow is gone. A relay that predates the scope fails loudly, never falls back to full access.
        const alsoMachineToken = readRelayConfig(configDir) === undefined;
        if (io.timing === undefined) process.once('SIGINT', onSigint);
        try {
          const login = await adminLoginByConsole(configDir, {
            relayUrl: effectiveRelay as string,
            force: false,
            name: readMachine(configDir).name,
            timing,
            say,
            restart: 'run `machine setup` again (what was created is kept)',
            asMachineToken: alsoMachineToken,
            setup: true,
            ...(io.now ? { now: io.now } : {}),
          });
          say(
            alsoMachineToken
              ? `[ok] relay token "${login.label}" saved for ${login.relayUrl}: it is the token of this machine and its admin token (MACHINE ADMIN: it cannot manage tokens)\n\n`
              : `[ok] admin token "${login.label}" saved for ${login.relayUrl} (MACHINE ADMIN: it cannot manage tokens)\n\n`,
          );
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      }
    } catch (e) {
      if (e instanceof AdminLoginInputError) return fail(e.message, EXIT.usage);
      // A relay that predates the scope: the message already names what to run next.
      if (e instanceof AccessLoginUnsupportedError) return fail(`${e.message}. What was created (identity, admin key) is kept`);
      if (e instanceof RelayError) return fail(`${e.message}. Nothing else was done; run \`machine setup\` again (what was created is kept)`);
      throw e;
    }
  }

  // The machine that holds the admin key approves its own candidacy: it needs the admin relay token, said BEFORE anything is spent.
  const holdsAdminKey = existsSync(adminKeyFile(configDir));
  const selfApproves = holdsAdminKey && !args.noWait;
  if (selfApproves) {
    const adminToken = readRelayAdminConfig(configDir);
    if (adminToken === undefined) {
      return fail(`this machine holds the admin key, so it approves its own enrollment, but one step is missing. ${missingAdminTokenMessage(configDir, effectiveRelay)}; then run \`machine ${args.resume ? 'join --resume' : `join${effectiveRelay !== undefined ? ` ${effectiveRelay}` : ''}`}\` again`);
    }
    if (effectiveRelay !== undefined && adminToken.relayUrl !== effectiveRelay) {
      return fail(`the admin token of this machine belongs to ${adminToken.relayUrl}, not ${effectiveRelay}: join that relay, or ${adminLoginFix({ relay: effectiveRelay, force: true })} (an admin login of ${effectiveRelay})`);
    }
  }

  if (io.timing === undefined) process.once('SIGINT', onSigint);
  let distributionFailed = false;
  let result;
  try {
    result = await runJoin(configDir, {
      ...(code !== undefined ? { code } : {}),
      resume: args.resume,
      // `setup` saved the relay token of this machine (or an earlier run did): no second login.
      ...(o.setup && readRelayConfig(configDir) !== undefined ? { useSavedToken: true } : {}),
      ...(relayUrl !== undefined ? { relayUrl } : {}),
      force: args.force,
      wait: !args.noWait,
      timeoutMs: timeoutSeconds * 1000,
      ...(args.yesFinalCode !== undefined ? { yesFinalCode: args.yesFinalCode } : {}),
      ask: o.ask,
      timing,
      ...(io.now ? { now: io.now } : {}),
      ...(io.hostname ? { hostname: io.hostname } : {}),
      say,
      step: enter,
      // Decision 55: the candidacy code is internal (the admin machine recomputes it and refuses a different one); a person compares the security code only.
      onPosted: (p) => {
        if (args.json && args.noWait) return;
        say(
          `[ok] ${p.resumed ? 'resuming on' : 'joined'} the relay ${p.relayUrl} as "${p.name}"${o.setup ? '' : ` (token "${p.label}" saved)`}\n` +
            // The machine that holds the admin key approves its own candidacy a moment later: the id and the expiry are noise there.
            (selfApproves ? '\n' : `Candidacy ${p.candidacyId} posted: it ${expiryText(p.expiresAt, epochSeconds())}.\n`) +
            (args.verbose && !selfApproves ? `Candidacy code (--verbose; the admin machine recomputes it itself, there is nothing to compare):\n\n  ${p.verificationCode}\n\n` : ''),
        );
      },
      ...(selfApproves
        ? {
            beforeWait: async (state) => {
              const own = readMachine(configDir);
              // The passphrase just chosen by `setup` signs this enrollment too: it is typed once, not three times.
              let reuse = passphrase;
              const signPrompt: Prompt = async (label) => {
                if (reuse === undefined) return o.prompt(label);
                const typed = reuse;
                reuse = undefined;
                return typed;
              };
              try {
                const approved = await runApprove(configDir, {
                  id: state.id,
                  selfJoin: { id: state.id, uuid: own.uuid, identityPublicKey: own.identity.publicKey, random: state.random, name: state.name },
                  ...(effectiveRelay !== undefined ? { relayUrl: effectiveRelay } : {}),
                  days: 365,
                  reject: false,
                  verbose: args.verbose,
                  prompt: signPrompt,
                  // The passphrase just set signs this enrollment: said once instead of the usual "Enter the admin passphrase".
                  ...(passphrase !== undefined ? { signingNote: '\nSigning with the admin passphrase you just set.\n' } : {}),
                  ask: o.ask,
                  say,
                  now: epochSeconds,
                });
                if (approved.kind === 'approved') {
                  if (approved.distribution.formatted.err) io.stderr(approved.distribution.formatted.err);
                  if (approved.distribution.formatted.failed) distributionFailed = true;
                }
                return approved.kind === 'approved';
              } catch (e) {
                if (e instanceof PromptTimeoutError) throw e;
                throw new Error(`${(e as Error).message}. This machine's candidacy ${state.id} ${expiryText(state.expiresAt, epochSeconds())}: run \`machine join --resume\` to try again`);
              }
            },
          }
        : {}),
    });
  } catch (e) {
    // `setup` keeps the relay token it saved: say so, the re-run reuses it (no second login).
    const savedToken = o.setup && readRelayConfig(configDir) !== undefined ? '. The relay token of this machine is saved: run `machine setup` again, it is reused (no new login)' : '';
    if (e instanceof RelayError || e instanceof NotInitializedError) return fail(`${e.message}${savedToken}`);
    throw e;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  // Nothing is started at login unless --auto-startup was given: otherwise only a suggestion (stderr with --json, so stdout stays one JSON document).
  const startupHint = args.autoStartup ? '' : 'To start machine at login run: machine startup enable\n';
  // A paragraph of its own (the human reads the next steps, then the optional one).
  const startupSpaced = startupHint === '' ? '' : `\n${startupHint}`;
  // Decision 70: the step "Allow list", once this machine is enrolled. A failure here never undoes the enrolment: the machine keeps the default (the admin), the failure is reported at the end.
  let allowMode: AllowListMode = alreadyLocal ? 'local' : 'admin';
  let allowKeyId: string | undefined;
  let allowProblem: string | undefined;
  if (result.status === 'enrolled' && !alreadyLocal) {
    enter('allow-list');
    const selfName = readMachine(configDir).name;
    const chosen = await chooseAllowList({ ...(policyFlag !== undefined ? { flag: policyFlag } : {}), selfName, ask: o.ask, say, warn: io.stderr });
    if (chosen.mode === 'local') {
      try {
        say('\n');
        const enabled = await runLocalEnable(configDir, { prompt: o.prompt, ask: o.ask, say, warn: io.stderr, now: epochSeconds });
        allowMode = 'local';
        allowKeyId = enabled.keyId;
        say(`[ok] this machine manages its own allow list (policy key ${enabled.keyId})\n`);
      } catch (e) {
        if (e instanceof PromptTimeoutError) throw e;
        allowProblem = `this machine is enrolled, but its allow list could not be taken over: ${(e as Error).message}. The admin still manages it (the default); run \`machine policy local enable\` to try again`;
      }
    } else if (chosen.how !== 'default-no-terminal') {
      say('[ok] the admin manages the allow list of this machine\n');
    }
  }
  const allowLine = allowMode === 'local' ? `allow list: managed by this machine (policy mode local${allowKeyId !== undefined ? `, key ${allowKeyId}` : ''})\n` : 'allow list: managed by the admin (policy mode admin)\n';
  enter('done');
  if (result.status === 'posted') {
    emit(result.posted, 'next: on the admin machine run `machine admin approve`; it prints a security code for this machine. Then run `machine join --resume` here: it shows the security code, which must read exactly the same on the admin machine\n' + startupSpaced);
  } else {
    const e = result.enrolled;
    const peerLines =
      e.peers.length > 0
        ? `peers trusted (${e.peers.length}):\n${e.peers.map((p) => `  ${p.name} (${p.uuid})`).join('\n')}\n`
        : e.isAdminMachine
          ? 'no other machine yet: this machine is the first of the network\n'
          : 'peers trusted: none (the admin included none)\n';
    const localAllow = '`machine policy allow -- <command>` on this machine';
    const next = e.isAdminMachine
      ? `next:\n  another machine: run \`machine join ${result.posted.relayUrl}\` on it, then \`machine admin approve\` here\n  allow a command: ${allowMode === 'local' ? `${localAllow}, or \`machine admin allow <machine> -- <command>\` for another machine` : '`machine admin allow <machine> -- <command>` (this machine or another)'}\n`
      : allowMode === 'local'
        ? `next: allow a command on this machine (${localAllow}), then \`machine status\`\n`
        : 'next: the admin allows commands on this machine (`machine admin allow <this machine> -- <command>`, run on the admin machine), then `machine status`\n';
    emit({ ...e, relayUrl: result.posted.relayUrl, policyMode: allowMode }, `[ok] enrolled "${e.self.name}" (${e.self.uuid})\nadmin key pinned: ${e.adminKeyId}\n${peerLines}${allowLine}\n${next}${startupSpaced}`);
  }
  if (args.json && startupHint) io.stderr(startupHint);
  if (args.autoStartup) {
    // A failure here never undoes the join: it is reported and the exit code says so.
    const problem = await enableAfterJoin(ctx, say);
    if (problem !== undefined) return fail(`joined the relay, but the startup job could not be enabled: ${problem}\nthe join is kept; fix the cause, then run \`machine startup enable\``);
  }
  if (allowProblem !== undefined) return fail(allowProblem);
  return distributionFailed ? EXIT.failure : EXIT.ok;
}
