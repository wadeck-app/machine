import type { Prompt } from './admin.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Hidden passphrase prompt; defaults to the terminal. Tests inject one. */
  prompt?: Prompt;
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
  peerHost?: string;
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
