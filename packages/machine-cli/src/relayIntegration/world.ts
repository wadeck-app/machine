import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCli } from '../cli.js';
import type { Timing } from '../cliTypes.js';
import { startMachineDaemon, type RunningDaemon } from '../daemonEntry.js';
import { loadCreateTestRelay, type TestRelay } from './testRelayModule.js';

// Shared by the integration tests against the REAL relay: one relay server, several machines (temporary configuration folders),
// every command run in-process through `runCli` with injected terminal answers, and a transcript of what each command printed.

export const PASSPHRASE = 'correct horse battery staple';
export const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

export interface TranscriptEntry {
  /** Who ran it (a machine name of the test). */
  who: string;
  command: string;
  /** The questions the person was asked, with the answer given. */
  asked: string[];
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  /** Hidden prompts (passphrase): the answer, or a function of the label. Default: PASSPHRASE. */
  hidden?: string | ((label: string) => string);
  /** Visible questions answered in order; a question beyond the list fails the test loudly. */
  visible?: string[];
  /** What the person does while the command waits (each pause of a wait): `n` counts from 1, `out` is what was printed so far. */
  onWait?: (n: number, out: string) => Promise<void>;
  /** Approve the device login in the relay console as soon as its code is printed (default true). */
  approveDevice?: boolean;
  hostname?: string;
  /** Wait times are fake: this is how far the CLI believes time went when it decides about timeouts. Default: nothing. */
  allowLoopbackPeers?: boolean;
  /** Clock of the CLI (epoch ms), for expiry tests. */
  nowMs?: () => number;
  /** Shown in the transcript instead of the argument list. */
  label?: string;
}

let fetchWrapped = 0;
let originalFetch: typeof fetch | undefined;
let address = 0;

/**
 * The relay trusts one proxy hop and rate limits per address (5 device logins and 5 failed claims per 10 minutes): every request of the
 * tests gets its own source address, like the helper of the relay does for its own calls. Only the test process is affected.
 */
function distinctAddresses(): void {
  if (fetchWrapped++ > 0) return;
  originalFetch = globalThis.fetch;
  const real = originalFetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', `10.0.0.1, 203.0.113.${(address++ % 250) + 1}`);
    return real(input, { ...init, headers });
  }) as typeof fetch;
}
function restoreFetch(): void {
  if (--fetchWrapped === 0 && originalFetch !== undefined) globalThis.fetch = originalFetch;
}

export interface World {
  relay: TestRelay;
  root: string;
  transcript: TranscriptEntry[];
  /** What the daemons of the test said (their log lines). */
  daemonLog: string[];
  /** A fresh configuration folder for a machine of the test. */
  machineDir: (name: string) => string;
  run: (who: string, dir: string, args: string[], options?: RunOptions) => Promise<{ code: number; out: string; err: string }>;
  /** A daemon of the machine in this process: loopback only, its inbox loop driven by hand (`inbox.runOnce()`), stopped by `stop()`. */
  daemon: (dir: string) => Promise<RunningDaemon>;
  stop: () => Promise<void>;
}

export async function startWorld(name: string): Promise<World> {
  // Fails loudly (never skips) when the relay module is not configured.
  const createTestRelay = await loadCreateTestRelay();
  const saved: Record<string, string | undefined> = {};
  const root = mkdtempSync(join(tmpdir(), 'machine-realrelay-'));
  // Nothing of the real user is touched: not ~/.config/machine, not the app-core of this computer, not orch.
  const isolated: Record<string, string> = { MACHINE_CONFIG_DIR: join(root, 'unused-machine-config'), APP_CORE_CONFIG_DIR: join(root, 'unused-app-core'), APP_CORE_PORT: '1' };
  for (const [k, v] of Object.entries(isolated)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  distinctAddresses();
  let relay: TestRelay;
  try {
    relay = await createTestRelay();
  } catch (e) {
    restoreFetch();
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const transcript: TranscriptEntry[] = [];
  const daemons: RunningDaemon[] = [];
  const daemonLog: string[] = [];
  let machines = 0;

  const run: World['run'] = async (who, dir, args, o = {}) => {
    let out = '';
    let err = '';
    const asked: string[] = [];
    const visible = [...(o.visible ?? [])];
    let approved = false;
    let slept = 0;
    let t = Date.now();
    const timing: Timing = {
      nowMs: () => t,
      pollIntervalMs: 3000,
      sleep: async (ms) => {
        t += ms;
        slept++;
        // The relay console: the person types the code shown on the machine.
        const code = /^\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(out)?.[1];
        if (o.approveDevice !== false && !approved && code !== undefined) {
          approved = true;
          await relay.approveDeviceCode(code);
        }
        await o.onWait?.(slept, out);
      },
    };
    const split = args.indexOf('--');
    const argv = split === -1 ? [...args, '--config-dir', dir] : [...args.slice(0, split), '--config-dir', dir, ...args.slice(split)];
    const code = await runCli(
      argv,
      {
        stdout: (text) => (out += text),
        stderr: (text) => (err += text),
        prompt: async (label) => {
          const answer = typeof o.hidden === 'function' ? o.hidden(label) : (o.hidden ?? PASSPHRASE);
          asked.push(`${label.trim()} [hidden]`);
          return answer;
        },
        ask: async (label) => {
          const answer = visible.shift();
          if (answer === undefined) throw new Error(`unexpected question in \`machine ${args.join(' ')}\`: "${label}" (no answer was planned)`);
          asked.push(`${label.trim()} ${answer}`);
          return answer;
        },
        timing,
        ...(o.hostname !== undefined ? { hostname: () => o.hostname as string } : {}),
        ...(o.allowLoopbackPeers ? { allowLoopbackPeers: true } : {}),
        ...(o.nowMs ? { now: () => new Date(o.nowMs?.() as number) } : {}),
      },
      {},
    );
    transcript.push({ who, command: `machine ${o.label ?? args.join(' ')}`, asked, code, out, err });
    return { code, out, err };
  };

  return {
    relay,
    root,
    transcript,
    daemonLog,
    machineDir: (name) => {
      const dir = join(root, `${++machines}-${name}`);
      mkdirSync(dir);
      return dir;
    },
    run,
    daemon: async (dir) => {
      // The inbox loop never ticks by itself: the test calls `runOnce()` when the person would wait.
      const timer = { set: () => 1, clear: () => undefined };
      const d = await startMachineDaemon(dir, {
        port: 0,
        version: 'relay-integration',
        peerPort: 0,
        peerHost: '127.0.0.1',
        advertise: [{ host: '127.0.0.1' }],
        log: (line) => daemonLog.push(`${basename(dir)}: ${line}`),
        inbox: { timer },
        register: async () => undefined,
      });
      daemons.push(d);
      await d.inbox?.ready;
      return d;
    },
    stop: async () => {
      const problems: string[] = [];
      while (daemons.length > 0) await (daemons.pop() as RunningDaemon).stop().catch((e: Error) => problems.push(`daemon: ${e.message}`));
      await relay.close().catch((e: Error) => problems.push(`relay: ${e.message}`));
      restoreFetch();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const target = process.env.MACHINE_RELAY_TRANSCRIPT;
      // The directory the transcripts of the UX audit are written to (one JSON file per test file); nothing is written without it.
      if (target !== undefined && target !== '') {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, `${name}.json`), `${JSON.stringify(transcript, null, 1)}\n`);
      }
      rmSync(root, { recursive: true, force: true });
      if (problems.length > 0) throw new Error(`cleanup problems: ${problems.join('; ')}`);
    },
  };
}
