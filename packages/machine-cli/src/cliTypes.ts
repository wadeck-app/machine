import type { Prompt } from './admin.js';
import type { PromptTimer } from './prompt.js';
import type { CliMetaDeps } from './cliMeta.js';
import type { StartupContext } from './startup.js';
import type { AddressEntry, ConnectFailureKind, LocalInterface } from '@wadeck-app/machine-core';
import type { WakeSender } from './wakeSender.js';
import type { InstallEnv } from './installEnv.js';

/** Waiting for the admin's decision. Tests inject a fake clock so that a 15 minute wait takes no time. */
export interface Timing {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowMs: () => number;
  pollIntervalMs: number;
  /** Stops the wait like Ctrl-C does. */
  signal?: AbortSignal;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Hidden passphrase prompt; defaults to the terminal. Tests inject one. */
  prompt?: Prompt;
  /** Visible one-line question (y/N); rejects when there is no terminal. Defaults to the terminal; tests inject one. */
  ask?: (label: string) => Promise<string>;
  /** Defaults to the real clock and Ctrl-C; tests inject a fake one. */
  timing?: Timing;
  /** Tests only: the width of the terminal in columns, or undefined when unknown (the default reads process.stdout when it is a terminal). */
  columns?: () => number | undefined;
  /** Limit timer of the prompts; tests inject a fake one. */
  promptTimer?: PromptTimer;
  /** Tests only: the orch stub and the daemon source for `machine startup` (no command line option exists for it). */
  startup?: Partial<StartupContext>;
  /** Tests only: the platform, the user, the terminal, the files and the commands behind `machine install` (no command line option exists for it): nothing in a test runs sudo or touches /etc. */
  install?: Partial<InstallEnv>;
  /** Tests only: the updater process, npm, orch and the daemon behind `machine cli` (no command line option exists for it). */
  cliMeta?: Partial<CliMetaDeps>;
  /** Tests only (no command line option exists): let `machine run` and `machine list` use loopback addresses of a peer record. */
  allowLoopbackPeers?: boolean;
  /** Tests only: how often `machine run --wait` prints its progress line (default 30 s). */
  waitProgressMs?: number;
  /** Tests only: how long `machine run` waits for an answer before it says that the wait is on by default (2 s). */
  waitNoticeMs?: number;
  /** Tests only: the computer name that default machine names are derived from (default: os.hostname()). */
  hostname?: () => string;
  /** Clock of the approval age and the candidacy expiry; tests inject a fake one. */
  now?: () => Date;
  /** Tests only (no command line option exists): the packet sender, the interfaces and the clock of a Wake-on-LAN. Nothing in a test sends a real packet. */
  wake?: Partial<WakeIo>;
}

export interface WakeIo {
  sender: WakeSender;
  interfaces: () => LocalInterface[];
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  /**
   * Tests only: a sleeping peer. Called before each real connection attempt; a kind makes the attempt fail with it (a `ConnectError`, as a real
   * timeout would) without touching the network. A refused loopback port is NOT a sleeping peer (the host answered), so tests use this.
   */
  simulateFailure: (address: AddressEntry) => ConnectFailureKind | undefined;
}

/**
 * `machine run` returns the exit code of the remote command, so its own failures must not collide with 1 to 4: like ssh,
 * every machine-level failure of `run` (refused by the peer, unknown machine, no connection) is 255, reason on stderr.
 */
export const EXIT = { ok: 0, failure: 1, usage: 2, reference: 3, peer: 255 } as const;

export interface Parsed {
  /** Words before `--`. */
  positional: string[];
  /** Words after `--`: the command to run on the peer, untouched. */
  passthrough: string[];
  json: boolean;
  help: boolean;
  version: boolean;
  replace: boolean;
  force: boolean;
  name?: string;
  /** `machine policy allow --peer <machine>`: edit the own list of that peer instead of the default list. */
  peer?: string;
  /** `admin allow` / `policy allow`: the lifetime of the entry, at most one of the three (permanent by default). Text, validated by machine-core. */
  times?: string;
  for?: string;
  until?: string;
  /** `admin allow --remove` / `policy allow --remove`: the number shown by `machine allowed` instead of the command. Text, validated by the command. */
  index?: string;
  out?: string;
  configDir?: string;
  address?: string;
  /** Every `--address` (repeatable for `machine peer connect`, once elsewhere). */
  addressList: string[];
  /** `machine run` and `machine ping`: wake the peer when it cannot be reached / never. */
  wake: boolean;
  noWake: boolean;
  /** `machine peer connect <machine> --show`. */
  show: boolean;
  /** `machine peer connect` settings. */
  type?: string;
  wakeMac?: string;
  wakeBroadcast?: string;
  wakeProbe?: string;
  wakeWait?: string;
  wakeMaxUnicast?: string;
  wakeMaxBroadcast?: string;
  wakeConnectTimeout?: string;
  wakeSettle?: string;
  /** `machine ping <machine> --count <n>`: rounds, 1 to 10 (validated by `parsePingCount`). */
  count?: string;
  /** `machine run`, `admin allow`, `policy allow`: the shell of the command. `machine peer connect`: the default shell of that peer. */
  shell?: string;
  /** `machine peer connect <machine> --no-shell`: forget the default shell of that peer. */
  noShell: boolean;
  days?: string;
  secretFrom?: string;
  peerPort?: string;
  apiPort?: string;
  peerHost?: string;
  /** `--advertise <host[:port]>`, repeatable (machine daemon). */
  advertise: string[];
  relay?: string;
  resume: boolean;
  noWait: boolean;
  reject: boolean;
  autoStartup: boolean;
  /** `--no-start` (startup enable, join/setup --auto-startup): register the startup job without starting the daemon now. */
  noStart: boolean;
  /** `machine admin login --full-access`: ask for a FULL-ACCESS token (it can also manage tokens) instead of a machine-admin one. An explicit opt-in. */
  fullAccess: boolean;
  /** `machine requests`: `--history` (the log instead of the pending list), `--all` (every peer, remote), `--since`, `--event`, `--limit`. Set only when given. */
  history?: true;
  all?: true;
  /** `machine log --follow --width <n>`: the columns the rows are fitted to (40 to 300); checked by the command. */
  width?: string;
  since?: string;
  event?: string;
  limit?: string;
  /** `machine log` (run-log.md): one direction, the other machine, an outcome, a text, the page offset. Set only when given. */ // run-log
  sent?: true; // run-log
  received?: true; // run-log
  machine?: string; // run-log
  outcome?: string; // run-log
  text?: string; // run-log
  offset?: string; // run-log
  /** `machine requests --full`: the whole command (wrapped) and the exact allow command of every row. */
  full?: true;
  /** `machine run --wait <duration>`: hold the request on the target up to this long when it is not allowed yet (hold-for-approval.md). */
  wait?: string;
  /** `machine run --on-refusal wait|fail` and `machine run-defaults --on-refusal wait|fail`: what to do when the target does not allow the command yet (raw text, validated by machine-core). */
  onRefusal?: string;
  /** `machine run-defaults --reset`: delete the machine setting. */
  reset?: true;
  /** `machine hold-limits --per-peer <n> --per-machine <n>`: requests this machine holds (raw text, validated by machine-cli). */
  perPeer?: string;
  perMachine?: string;
  /** `machine requests --deny <id> [--reason <text>]`: refuse a request that a peer holds. */
  deny?: string;
  reason?: string;
  /** `--verbose` (join, setup, admin approve): also shows the candidacy code, which is internal by default (decision 55). */
  verbose: boolean;
  /** `machine cli self-check --quiet`. */
  quiet: boolean;
  /** `machine admin init --generate` and `machine setup --generate`: a random passphrase, no question. */
  generate: boolean;
  /** `machine admin init --hint <text>` and `machine setup --hint <text>` (decision 57): the passphrase hint, no question. */
  hint?: string;
  /** `machine admin allow <machine> --list` / `--remove`. */
  list: boolean;
  remove: boolean;
  /** `machine install <id>`: skip the y/N question, print the plan only, report the state only. */
  yes: boolean;
  dryRun: boolean;
  check: boolean;
  /** `machine install <id> --refresh`: write the whole plan again, even when the status says up to date. */
  refresh: boolean;
  /** `machine cli logs --follow` (-f), and `machine log --follow` (-f): the live stream of the activity of this machine. */
  follow: boolean;
  /** `machine cli register --force-register`: register even when the config dir is under the OS temporary folder. */
  forceRegister: boolean;
  timeout?: string;
  promptTimeout?: string;
  policy?: string;
  yesFinalCode?: string;
  /** Unknown "--word" kept as a positional after `admin approve` (a candidacy id may start with "--"): refused later when it names no pending candidacy. */
  optionLike: string[];
}

export class UsageError extends Error {}

export type ParsedIndex = { ok: true; index: number | undefined } | { ok: false; message: string };

/** The number of `--index <n>` (undefined when the flag is absent), or the message when it is not a number from 1 to 200 (the entries of a list). */
export function parseIndex(text: string | undefined): ParsedIndex {
  if (text === undefined) {
    return { ok: true, index: undefined };
  }
  const n = Number(text);
  if (!/^[1-9][0-9]{0,2}$/.test(text) || n > 200) {
    return { ok: false, message: `--index must be the number shown by \`machine allowed\` before an entry, from 1 to 200, got ${JSON.stringify(text)}` };
  }
  return { ok: true, index: n };
}

export interface CommandContext {
  args: Parsed;
  /** Positional words after the command name. */
  rest: string[];
  io: CliIo;
  configDir: string;
  env: Record<string, string | undefined>;
  fail: (message: string, code?: number) => number;
  emit: (value: unknown, text: string) => void;
}
