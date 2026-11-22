import type { ExecResult, InstallEnv } from './installEnv.js';

// Test helper (not shipped logic): a machine that is only a map of files and a log of commands. Nothing here touches the disk, /etc or sudo.

export interface FakeInstallOptions {
  platform?: string;
  userName?: string;
  tty?: boolean;
  /** Files the owner can read (the script). */
  userFiles?: Record<string, string>;
  /** Files only root can read (the sudoers drop-in). */
  rootFiles?: Record<string, string>;
  /** `command -v <tool>` answers; a tool that is absent from the map is not found. */
  tools?: Record<string, string>;
  /** `visudo -c -f` answers this message with exit 1. */
  visudoFails?: string;
  /** `sudo install ... <target>` for these targets fails with that stderr. */
  installFails?: Record<string, string>;
  /** Reading a root-only file fails with that stderr (a wrong password...). */
  rootReadFails?: string;
  /** What `sudo -n -l` answers when the rule is not in the fake sudoers (default: exit 1). */
  probeAllowsWithoutRule?: boolean;
  /** `sudo rm -- <path>` answers 0 for these paths but leaves the file there (a removal that did not take). */
  rmLeaves?: string[];
  /** The timer of idle-suspend runs from the start (an installed fixture). */
  timerRunning?: boolean;
  /** What `journalctl -t machine-idle-suspend` prints (default: nothing, like a journal the user cannot read). */
  journal?: string;
  /** `sudo systemctl <verb> ...` for these verbs fails with exit 1 and this message. */
  systemctlFails?: Record<string, string>;
}

export interface FakeInstall {
  env: InstallEnv;
  userFiles: Map<string, string>;
  rootFiles: Map<string, string>;
  /** Every command run, as one text. */
  calls: string[];
  /** The mode given to `install -m` for each target. */
  modes: Map<string, string>;
  /** Temporary files written (path to content and mode). */
  staged: Map<string, { content: string; mode: number }>;
  removedDirs: string[];
  tempDirs: string[];
  /** The state of the timer unit of idle-suspend. */
  timer: { enabled: boolean; running: boolean };
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

export function fakeInstall(o: FakeInstallOptions = {}): FakeInstall {
  const userFiles = new Map(Object.entries(o.userFiles ?? {}));
  const rootFiles = new Map(Object.entries(o.rootFiles ?? {}));
  const tools = o.tools ?? { systemctl: '/usr/bin/systemctl', sudo: '/usr/bin/sudo', date: '/usr/bin/date', ss: '/usr/bin/ss', 'systemd-inhibit': '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', journalctl: '/usr/bin/journalctl' };
  const timer = { enabled: o.timerRunning === true, running: o.timerRunning === true };
  const calls: string[] = [];
  const modes = new Map<string, string>();
  const staged = new Map<string, { content: string; mode: number }>();
  const removedDirs: string[] = [];
  const tempDirs: string[] = [];
  // The units of /etc/systemd/system are world-readable: the owner reads them like the script.
  const isRootPath = (p: string): boolean => p.startsWith('/etc/') && !p.startsWith('/etc/systemd/');
  const store = (p: string): Map<string, string> => (isRootPath(p) ? rootFiles : userFiles);

  const exec = async (argv: string[]): Promise<ExecResult> => {
    calls.push(argv.join(' '));
    const [program, ...rest] = argv;
    if (program === 'sh' && rest[0] === '-c') {
      const tool = /^command -v ([\w-]+)$/.exec(rest[1] ?? '')?.[1];
      const found = tool === undefined ? undefined : tools[tool];
      return found === undefined ? fail('', 127) : ok(`${found}\n`);
    }
    if (program === '/usr/bin/systemctl' && rest[0] === 'is-active') {
      return timer.running ? ok() : { code: 3, stdout: '', stderr: '' };
    }
    if (program === '/usr/bin/journalctl') {
      return ok(o.journal ?? '');
    }
    if (program !== '/usr/bin/sudo') {
      return fail(`unexpected program ${program ?? ''}`, 127);
    }
    const [verb, ...args] = rest;
    if (verb === 'sh') {
      // The read of a root-only file: ['sh', '-c', script, name, path]
      if (o.rootReadFails !== undefined) {
        return fail(o.rootReadFails);
      }
      const path = args[3] ?? '';
      const text = rootFiles.get(path);
      return text === undefined ? { code: 3, stdout: '', stderr: '' } : ok(text);
    }
    if (verb === 'visudo') {
      const path = args[2] ?? '';
      if (!staged.has(path)) {
        return fail(`visudo: ${path}: No such file or directory`);
      }
      return o.visudoFails === undefined ? ok(`${path}: parsed OK\n`) : fail(o.visudoFails);
    }
    if (verb === 'install') {
      const target = args[args.length - 1] ?? '';
      const source = args[args.length - 2] ?? '';
      if (o.installFails?.[target] !== undefined) {
        return fail(o.installFails[target] as string);
      }
      const content = staged.get(source)?.content;
      if (content === undefined) {
        return fail(`install: cannot stat '${source}': No such file or directory`);
      }
      store(target).set(target, content);
      modes.set(target, args[args.indexOf('-m') + 1] ?? '');
      return ok();
    }
    if (verb === '/usr/bin/systemctl') {
      const [action, ...more] = args;
      if (o.systemctlFails?.[action ?? ''] !== undefined) {
        return fail(o.systemctlFails[action ?? ''] as string);
      }
      if (action === 'enable' || action === 'restart') {
        if (!userFiles.has('/etc/systemd/system/machine-idle-suspend.timer')) {
          return fail(`Failed to ${action} machine-idle-suspend.timer: Unit file machine-idle-suspend.timer does not exist.`);
        }
        timer.enabled = timer.enabled || action === 'enable';
        timer.running = timer.running || action === 'restart';
      }
      if (action === 'disable' && more.includes('--now')) {
        timer.enabled = false;
        timer.running = false;
      }
      return ok();
    }
    if (verb === 'rm') {
      const target = args[args.length - 1] ?? '';
      if (o.rmLeaves?.includes(target) === true) {
        return ok();
      }
      if (!store(target).delete(target)) {
        return fail(`rm: cannot remove '${target}': No such file or directory`);
      }
      return ok();
    }
    if (verb === '-n' && args[0] === '-l') {
      const allowed = [...rootFiles.values()].some((c) => /NOPASSWD: \S+ suspend$/m.test(c)) || o.probeAllowsWithoutRule === true;
      return allowed ? ok(`${args[1] ?? ''} suspend\n`) : fail('sudo: a password is required');
    }
    return fail(`unexpected sudo command ${rest.join(' ')}`, 127);
  };

  const env: InstallEnv = {
    platform: o.platform ?? 'linux',
    userName: () => o.userName ?? 'alice',
    isTty: () => o.tty ?? true,
    fs: {
      readText: (path) => userFiles.get(path),
      makeTempDir: () => {
        const dir = `/tmp/machine-install-fake${tempDirs.length}`;
        tempDirs.push(dir);
        return dir;
      },
      writeFile: (path, content, mode) => void staged.set(path, { content, mode }),
      removeDir: (path) => void removedDirs.push(path),
    },
    exec,
    context: { configDir: '/home/alice/.config/machine' },
  };
  return { env, userFiles, rootFiles, calls, modes, staged, removedDirs, tempDirs, timer };
}
