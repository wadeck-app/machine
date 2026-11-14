import type { Prompt } from './admin.js';
import type { PromptTimer } from './prompt.js';
import type { DaemonSource, OrchCommand } from './startup.js';

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
  /** Limit timer of the prompts; tests inject a fake one. */
  promptTimer?: PromptTimer;
  /** Tests only: the orch stub and the daemon source for `machine startup` (no command line option exists for it). */
  startup?: { orch?: OrchCommand; daemon?: DaemonSource; platform?: NodeJS.Platform };
  /** Clock of the approval age and the candidacy expiry; tests inject a fake one. */
  now?: () => Date;
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
  replace: boolean;
  force: boolean;
  name?: string;
  out?: string;
  configDir?: string;
  address?: string;
  shell?: string;
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
  timeout?: string;
  promptTimeout?: string;
  policy?: string;
  yesFinalCode?: string;
}

export class UsageError extends Error {}

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
