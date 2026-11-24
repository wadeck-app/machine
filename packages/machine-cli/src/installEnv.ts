import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// What `machine install` touches outside machine-core: the platform, the user, a terminal, a temporary folder and child processes.
// Everything goes through this interface so that the tests never touch /etc, never run sudo and never need a terminal.

export interface ExecResult {
  /** The exit code; null when the process did not start or was killed (then `error` says why). */
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface InstallFs {
  /** The text of a file, undefined when it does not exist; any other failure (permission, a folder...) throws with the cause. */
  readText: (path: string) => string | undefined;
  /** A new private temporary folder (mode 0700). */
  makeTempDir: () => string;
  writeFile: (path: string, content: string, mode: number) => void;
  removeDir: (path: string) => void;
}

export interface InstallEnv {
  /** `process.platform`. */
  platform: string;
  userName: () => string;
  /** An interactive terminal on both the input and the prompts: sudo asks the password there. */
  isTty: () => boolean;
  fs: InstallFs;
  /** Runs one program (never a shell string). The terminal stays the one of the owner: the password is typed to sudo itself. */
  exec: (argv: string[]) => Promise<ExecResult>;
  /** What the command line says that the plans need (the configuration folder of machine, `--minutes`): set by `machine install`, never by the environment. */
  context?: { configDir: string; minutes?: number; rdpMinutes?: number; sshMinutes?: number };
}

const realFs: InstallFs = {
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new Error(`cannot read ${path}: ${(e as Error).message}`);
    }
  },
  makeTempDir: () => mkdtempSync(join(tmpdir(), 'machine-install-')),
  writeFile: (path, content, mode) => {
    writeFileSync(path, content, { mode });
  },
  removeDir: (path) => rmSync(path, { recursive: true, force: true }),
};

/**
 * stdin is the terminal of the owner (sudo opens /dev/tty itself for the password; machine never reads, stores or passes it);
 * stdout and stderr are captured so that a failure is reported with the command and what it said.
 */
function realExec(argv: string[]): Promise<ExecResult> {
  const [program, ...args] = argv;
  return new Promise((resolve) => {
    if (program === undefined) {
      resolve({ code: null, stdout: '', stderr: '', error: 'internal: empty command' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(program, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolve({ code: null, stdout, stderr, error: (e as Error).message });
      return;
    }
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => resolve({ code: null, stdout, stderr, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${program}: not found` : (e as Error).message }));
    child.on('close', (code, signal) => resolve({ code, stdout, stderr, ...(code === null ? { error: `ended by the signal ${signal ?? 'unknown'}` } : {}) }));
  });
}

export function realInstallEnv(): InstallEnv {
  return {
    platform: process.platform,
    userName: () => userInfo().username,
    isTty: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
    fs: realFs,
    exec: realExec,
  };
}
