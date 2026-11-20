import { resolve } from 'node:path';
import { daemonPortFile } from './daemonPortFile.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { bundleLinkLine } from './bundleLink.js';
import type { DaemonState } from './daemonPortFile.js';
import { disableStartup, enableStartup, startupStatus, StartupError, type DaemonForm, type DaemonOutcome, type EnableResult, type StartupContext } from './startup.js';

// `machine startup enable | disable | status`: thin front-end over startup.ts.

export const ORCH_INSTALL_HINT = 'if orch does not start at login, run: orch install';
const USAGE = 'usage: machine startup [status] | enable | disable (without a subcommand it shows the status); see `machine startup --help`';

/** Tests inject the orch stub and the daemon source through `io.startup`; there is no command line option for it. */
function startupContext(ctx: CommandContext): StartupContext {
  return { configDir: ctx.configDir, env: ctx.env, start: !ctx.args.noStart, ...ctx.io.startup };
}

const FORM_TEXT: Record<DaemonForm | 'unknown', string> = {
  launcher: 'staged launcher',
  'launcher-wrapper': 'staged launcher through a wscript wrapper',
  development: 'development (node + bundle)',
  unknown: 'unknown (not a command this version of machine writes)',
};

/** `daemon: running (peer port N, pid P)`, or `daemon: NOT running: <what to do>` plus the problem found with the port file, if any. */
export function daemonStateText(state: DaemonState, startHint: string): string {
  if (state.running) return `daemon: running (peer port ${state.peerPort}, pid ${state.pid})\n`;
  return `daemon: NOT running: ${startHint}\n${state.problem === undefined ? '' : `[warn] ${state.problem}\n`}`;
}

/** What `enable` says about the daemon: started now, already up, not started on request, or not started (cause and fix). */
function daemonOutcomeText(d: DaemonOutcome, id: string, start: boolean): string {
  if (d.running) return d.started ? `[ok] daemon started (peer port ${d.peerPort})\n` : `[ok] daemon already running (peer port ${d.peerPort}, pid ${d.pid})\n`;
  if (!start) return `[info] daemon not started (--no-start): it starts at the next login of orch, or now with \`orch restart-job ${id}\`${d.reason === undefined ? '' : `\n[warn] ${d.reason}`}\n`;
  return `[warn] ${d.reason ?? 'the daemon is not running'}\n`;
}

function enableText(r: EnableResult, start: boolean): string {
  const daemon = daemonOutcomeText(r.daemon, r.id, start);
  const form = r.form !== 'development' ? `${FORM_TEXT[r.form]} (the job needs Node >= 22 on its PATH: the launcher starts node)` : FORM_TEXT.development;
  const removed = r.pruned && r.pruned.removed.length > 0 ? `removed older staged launchers: ${r.pruned.removed.join(', ')}\n` : '';
  const skipped = r.pruned && r.pruned.skipped.length > 0 ? `older staged launchers still in use, kept until the next run: ${r.pruned.skipped.join(', ')}\n` : '';
  const note = r.formNote === undefined ? '' : `${r.formNote}\n`;
  const link = r.bundleLink === undefined ? '' : `${bundleLinkLine(r.bundleLink)}\n`;
  return `[ok] startup job "${r.id}" ${r.action}\ncommand: ${r.command}\nform: ${form}\n${note}${removed}${skipped}${link}port file: ${r.portFile}\n${daemon}`;
}

/**
 * Enables the job for `machine join --auto-startup`: the text goes to `say`, the orch install line to stderr with --json
 * (so stdout stays one JSON document). Returns the error message when it failed.
 */
export async function enableAfterJoin(ctx: CommandContext, say: (text: string) => void): Promise<string | undefined> {
  try {
    const r = await enableStartup(startupContext(ctx));
    say(enableText(r, !ctx.args.noStart) + `${ORCH_INSTALL_HINT}\n`);
    return undefined;
  } catch (e) {
    if (e instanceof StartupError) return e.message;
    throw e;
  }
}

export async function runStartupCommand(ctx: CommandContext): Promise<number> {
  const { rest, args, io, emit, fail } = ctx;
  // `machine startup` alone is the read-only question the user asks first: it shows the status.
  const sub = rest.length === 0 ? 'status' : rest[0];
  if (rest.length > 1 || (sub !== 'enable' && sub !== 'disable' && sub !== 'status')) {
    return fail(`unknown startup argument "${rest.join(' ')}": ${USAGE}`, EXIT.usage);
  }
  try {
    const sctx = startupContext(ctx);
    if (sub === 'enable') {
      const r = await enableStartup(sctx);
      emit(r, enableText(r, !args.noStart) + (args.json ? '' : `${ORCH_INSTALL_HINT}\n`));
      if (args.json) {
        // One JSON document on stdout: the warning the text carries goes to stderr.
        if (!r.daemon.running && r.daemon.reason !== undefined) io.stderr(`[warn] ${r.daemon.reason}\n`);
        io.stderr(`${ORCH_INSTALL_HINT}\n`);
      }
      return EXIT.ok;
    }
    if (sub === 'disable') {
      const r = await disableStartup(sctx);
      emit(r, `[ok] ${r.stopped ? 'running daemon stopped, ' : ''}startup job "${r.id}" ${r.outcome}\n`);
      return EXIT.ok;
    }
    const s = await startupStatus(sctx);
    if (!s.exists) {
      const note = s.formNote === undefined ? '' : `${s.formNote}\n`;
      emit(s, `startup job "${s.id}": absent (run machine startup enable)\nenable would register the form: ${FORM_TEXT[s.expectedForm]}\n${note}${daemonStateText(s.daemon, 'start it with `machine startup enable` (at login) or `machine daemon`')}`);
    } else {
      const note = s.formNote === undefined ? '' : `${s.formNote}\n`;
      const wrapper = s.wrapper === undefined ? '' : `wrapper script: ${s.wrapper}\n`;
      const forms = `registered form: ${FORM_TEXT[s.registeredForm ?? 'unknown']}\nexpected form: ${FORM_TEXT[s.expectedForm]}\n${wrapper}${note}${s.bundleLink === undefined ? '' : `${bundleLinkLine(s.bundleLink)}\n`}`;
      emit(s, `startup job "${s.id}": present\ncommand: ${s.command}\n${forms}${s.upToDate ? 'up to date' : 'outdated: run machine startup enable'}\n${daemonStateText(s.daemon, `start it with \`orch restart-job ${s.id}\` or \`machine startup enable\``)}`);
    }
    // Loud but not an error: stderr in both modes, so --json stays one document on stdout (it also lists the conflicts).
    for (const c of s.conflicts) {
      io.stderr(
        `[warning] the orch job "${c.id}" (command: ${c.command}) uses the same port file as "${s.id}" (${daemonPortFile(resolve(ctx.configDir))}): two orch jobs supervise one daemon and will fight over it. Remove the extra one with \`orch remove ${c.id}\`\n`,
      );
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof StartupError) return fail(e.message);
    throw e;
  }
}
