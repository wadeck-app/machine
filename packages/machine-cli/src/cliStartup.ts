import { EXIT, type CommandContext } from './cliTypes.js';
import { disableStartup, enableStartup, startupStatus, StartupError, type EnableResult, type StartupContext } from './startup.js';

// `machine startup enable | disable | status`: thin front-end over startup.ts.

export const ORCH_INSTALL_HINT = 'if orch does not start at login, run: orch install';
const USAGE = 'usage: machine startup enable | disable | status';

/** Tests inject the orch stub and the daemon source through `io.startup`; there is no command line option for it. */
function startupContext(ctx: CommandContext): StartupContext {
  return { configDir: ctx.configDir, env: ctx.env, ...ctx.io.startup };
}

function enableText(r: EnableResult): string {
  return `[ok] startup job "${r.id}" ${r.action}\ncommand: ${r.command}\nport file: ${r.portFile}\n`;
}

/**
 * Enables the job for `machine join --auto-startup`: the text goes to `say`, the orch install line to stderr with --json
 * (so stdout stays one JSON document). Returns the error message when it failed.
 */
export async function enableAfterJoin(ctx: CommandContext, say: (text: string) => void): Promise<string | undefined> {
  try {
    const r = await enableStartup(startupContext(ctx));
    say(enableText(r) + `${ORCH_INSTALL_HINT}\n`);
    return undefined;
  } catch (e) {
    if (e instanceof StartupError) return e.message;
    throw e;
  }
}

export async function runStartupCommand(ctx: CommandContext): Promise<number> {
  const { rest, args, io, emit, fail } = ctx;
  const sub = rest[0];
  if (rest.length !== 1 || (sub !== 'enable' && sub !== 'disable' && sub !== 'status')) {
    return fail(`${rest.length === 0 ? 'startup needs a subcommand' : `unknown startup argument "${rest.join(' ')}"`}: ${USAGE}`, EXIT.usage);
  }
  try {
    const sctx = startupContext(ctx);
    if (sub === 'enable') {
      const r = await enableStartup(sctx);
      emit(r, enableText(r) + (args.json ? '' : `${ORCH_INSTALL_HINT}\n`));
      if (args.json) io.stderr(`${ORCH_INSTALL_HINT}\n`);
      return EXIT.ok;
    }
    if (sub === 'disable') {
      const r = await disableStartup(sctx);
      emit(r, `[ok] startup job "${r.id}" ${r.outcome}\n`);
      return EXIT.ok;
    }
    const s = await startupStatus(sctx);
    if (!s.exists) {
      emit(s, `startup job "${s.id}": absent (run machine startup enable)\n`);
    } else {
      emit(s, `startup job "${s.id}": present\ncommand: ${s.command}\n${s.upToDate ? 'up to date' : 'outdated: run machine startup enable'}\n`);
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof StartupError) return fail(e.message);
    throw e;
  }
}
