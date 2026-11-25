import { describe, expect, it } from 'vitest';
import { InstallError, classifyInstalled, findInstallable, markerLine, unsupportedMessage, type InstallFacts, type PlanArg } from './install.js';
import { idleSuspendInstalledMinutes } from './idleSuspend.js';

const FACTS: InstallFacts = {
  platform: 'linux',
  userName: 'alice',
  systemctlPath: '/usr/bin/systemctl',
  sudoPath: '/usr/bin/sudo',
  configDir: '/home/alice/.config/machine',
  tools: { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', journalctl: '/usr/bin/journalctl' },
};
const def = (): NonNullable<ReturnType<typeof findInstallable>> => {
  const d = findInstallable('idle-suspend');
  if (d === undefined) {
    throw new Error('idle-suspend is not registered');
  }
  return d;
};
const argvText = (argv: PlanArg[]): string => argv.map((a) => (typeof a === 'string' ? a : `<${a.stage}>`)).join(' ');

describe('idle-suspend: the plan', () => {
  it('is registered for linux only, with a consequence that says it only restricts uptime', () => {
    expect(def().platforms).toEqual(['linux']);
    expect(def().consequence).toMatch(/only RESTRICTS uptime/);
    expect(def().consequence).toMatch(/no right for any peer/);
    expect(def().description).toMatch(/--minutes 1\.\.1440/);
  });

  it('three root-owned files with the marker, the right modes, none root-only', () => {
    const plan = def().plan(FACTS);
    expect(plan.files.map((f) => [f.id, f.path, f.mode, f.owner, f.group, f.rootOnly])).toEqual([
      ['script', '/usr/local/bin/machine-idle-suspend', '0755', 'root', 'root', false],
      ['service', '/etc/systemd/system/machine-idle-suspend.service', '0644', 'root', 'root', false],
      ['timer', '/etc/systemd/system/machine-idle-suspend.timer', '0644', 'root', 'root', false],
    ]);
    for (const f of plan.files) expect(f.content.split('\n')).toContain(markerLine('idle-suspend', plan.version));
  });

  it('the units: oneshot service running the script (explicit start timeout), timer every 1 min (the 30/20/20 default) after a 2 min boot delay, 1 s accuracy, wanted by timers.target', () => {
    const files = def().plan(FACTS).files;
    const service = files.find((f) => f.id === 'service')?.content ?? '';
    const timer = files.find((f) => f.id === 'timer')?.content ?? '';
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ExecStart=/usr/local/bin/machine-idle-suspend');
    expect(timer).toContain('OnBootSec=2min');
    expect(timer).toContain('OnUnitActiveSec=1min');
    expect(timer).toContain('AccuracySec=1s');
    expect(service).toContain('TimeoutStartSec=25');
    expect(timer).toContain('WantedBy=timers.target');
  });

  it('the script embeds the measured paths and the default 30 minutes; the units do not depend on the minutes', () => {
    const a = def().plan(FACTS);
    const b = def().plan({ ...FACTS, minutes: 45 });
    const script = (p: typeof a): string => p.files[0]?.content ?? '';
    expect(idleSuspendInstalledMinutes(script(a))).toBe(30);
    expect(idleSuspendInstalledMinutes(script(b))).toBe(45);
    expect(script(a)).toContain("AUDIT_LOG='/home/alice/.config/machine/audit.log'");
    expect(script(a)).toContain("SS='/usr/bin/ss'");
    expect(a.files.slice(1).map((f) => f.sha256)).toEqual(b.files.slice(1).map((f) => f.sha256));
    expect(a.summary).toBe('suspends after 30 min idle (RDP: 20 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 1 min)');
    expect(b.summary).toBe('suspends after 45 min idle (RDP: 20 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 1 min)');
  });

  it('without --minutes the minutes of the installed script are kept; --minutes wins', () => {
    expect(def().plan({ ...FACTS, installedMinutes: 90 }).summary).toBe('suspends after 90 min idle (RDP: 20 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 1 min)');
    expect(def().plan({ ...FACTS, installedMinutes: 90, minutes: 10 }).summary).toBe('suspends after 10 min idle (RDP: 20 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 1 min)');
  });

  it('install order: stage, install the script, the units, reload, enable, restart; each step names its file', () => {
    const steps = def().plan(FACTS).steps;
    expect(steps.map((s) => (s.kind === 'stage' ? `stage ${s.file}` : `${s.purpose} ${s.file}: ${argvText(s.argv)}`))).toEqual([
      'stage script',
      'stage service',
      'stage timer',
      'install script: /usr/bin/sudo install -m 0755 -o root -g root <script> /usr/local/bin/machine-idle-suspend',
      'install service: /usr/bin/sudo install -m 0644 -o root -g root <service> /etc/systemd/system/machine-idle-suspend.service',
      'install timer: /usr/bin/sudo install -m 0644 -o root -g root <timer> /etc/systemd/system/machine-idle-suspend.timer',
      'activate service: /usr/bin/sudo /usr/bin/systemctl daemon-reload',
      'activate timer: /usr/bin/sudo /usr/bin/systemctl enable machine-idle-suspend.timer',
      'activate timer: /usr/bin/sudo /usr/bin/systemctl restart machine-idle-suspend.timer',
    ]);
  });

  it('remove: disable first, then exactly the three files (no glob, no other path), then reload', () => {
    const steps = def().plan(FACTS).removeSteps;
    expect(steps.map((s) => argvText(s.argv))).toEqual([
      '/usr/bin/sudo /usr/bin/systemctl disable --now machine-idle-suspend.timer',
      '/usr/bin/sudo rm -- /etc/systemd/system/machine-idle-suspend.timer',
      '/usr/bin/sudo rm -- /etc/systemd/system/machine-idle-suspend.service',
      '/usr/bin/sudo rm -- /usr/local/bin/machine-idle-suspend',
      '/usr/bin/sudo /usr/bin/systemctl daemon-reload',
    ]);
    expect(steps.every((s) => s.fix.length > 5)).toBe(true);
  });

  it('the probe asks the timer, never prompts and never uses sudo; the plan is marked as a service item', () => {
    const plan = def().plan(FACTS);
    expect(plan.probe).toEqual(['/usr/bin/systemctl', 'is-active', '--quiet', 'machine-idle-suspend.timer']);
    expect(plan.service).toEqual({ unit: 'machine-idle-suspend.timer' });
    expect(plan.tools).toEqual({ sudo: '/usr/bin/sudo', systemctl: '/usr/bin/systemctl' });
  });

  it('the last decision is read from the journal by the tag, one line, no pager, quiet', () => {
    expect(def().plan(FACTS).lastDecisionArgv).toEqual(['/usr/bin/journalctl', '-t', 'machine-idle-suspend', '-n', '1', '--no-pager', '-q', '-o', 'short-iso']);
    const { journalctl: _unused, ...rest } = FACTS.tools ?? {};
    expect(def().plan({ ...FACTS, tools: rest }).lastDecisionArgv).toBeUndefined();
  });

  it('next: names the journal command, both keep-awake files, the until form and the xrdp rule', () => {
    const text = def().next(def().plan(FACTS), 'desktop').join('\n');
    expect(text).toContain('journalctl -t machine-idle-suspend');
    expect(text).toContain('/run/machine-keep-awake');
    expect(text).toContain('/home/alice/.config/machine/keep-awake');
    expect(text).toContain('keep awake until');
    expect(text).toMatch(/disconnected desktop session \(xrdp\) is NOT counted/);
    expect(text).toMatch(/established RDP connection counts only while the X input of the session is more recent than --rdp-minutes/);
    expect(def().afterRemove(def().plan(FACTS), 'desktop').join('\n')).toMatch(/nothing to withdraw/);
  });

  it('decision 102: xprintidle found on this machine: its path is in the script and the plan says what it is used for', () => {
    const plan = def().plan({ ...FACTS, tools: { ...FACTS.tools, xprintidle: '/opt/bin/xprintidle', runuser: '/sbin/runuser', loginctl: '/bin/loginctl' } });
    const script = plan.files[0]?.content ?? '';
    expect(script).toMatch(/^XPRINTIDLE='\/opt\/bin\/xprintidle'$/m);
    expect(script).toMatch(/^RUNUSER='\/sbin\/runuser'$/m);
    expect(script).toMatch(/^LOGINCTL='\/bin\/loginctl'$/m);
    expect(plan.notes?.[0]).toBe('xprintidle found at /opt/bin/xprintidle: the input idle time is checked (30 min, 20 min with an RDP connection)');
  });

  it('decision 102: xprintidle absent: the plan still builds (it never installs it), the note says what to do, the script keeps the default path', () => {
    const plan = def().plan(FACTS);
    expect(plan.notes?.[0]).toBe('xprintidle missing, input idleness is not checked, and an RDP connection counts as activity: sudo apt install xprintidle');
    expect(plan.files[0]?.content).toMatch(/^XPRINTIDLE='\/usr\/bin\/xprintidle'$/m);
    expect(plan.steps.map((s) => (s.kind === 'run' ? argvText(s.argv) : '')).join('\n')).not.toMatch(/apt|xprintidle/);
  });

  it('decision 102: a script installed by the previous build (marker version 3, sockets instead of sessions) is outdated, not current', () => {
    const plan = def().plan(FACTS);
    const file = plan.files[0] as NonNullable<(typeof plan.files)[0]>;
    const old = file.content.replace('version 8', 'version 3').replace(/^LOGINCTL=.*\n/m, '');
    expect(classifyInstalled(file, old)).toMatchObject({ state: 'outdated', version: 3 });
    expect(classifyInstalled(file, file.content).state).toBe('current');
  });

  it('decision 103: --rdp-minutes (default 20) goes into the script and the summary; without the flag the installed value is kept', () => {
    expect(def().plan(FACTS).files[0]?.content).toMatch(/^RDP_MINUTES=20$/m);
    expect(def().plan(FACTS).summary).toBe('suspends after 30 min idle (RDP: 20 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 1 min)');
    expect(def().plan({ ...FACTS, minutes: 5, rdpMinutes: 45 }).files[0]?.content).toMatch(/^RDP_MINUTES=45$/m);
    expect(def().plan({ ...FACTS, minutes: 5, rdpMinutes: 45 }).summary).toBe('suspends after 5 min idle (RDP: 45 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 30 s)');
    expect(def().plan({ ...FACTS, installedRdpMinutes: 60 }).files[0]?.content).toMatch(/^RDP_MINUTES=60$/m);
    expect(def().plan({ ...FACTS, installedRdpMinutes: 60, rdpMinutes: 7 }).files[0]?.content).toMatch(/^RDP_MINUTES=7$/m);
  });

  it('decision 106: a value of 1 is a valid plan (MINUTES=1, RDP_MINUTES=1) and is read back', () => {
    const plan = def().plan({ ...FACTS, minutes: 1, rdpMinutes: 1 });
    const script = plan.files[0]?.content ?? '';
    expect(script).toMatch(/^MINUTES=1$/m);
    expect(script).toMatch(/^RDP_MINUTES=1$/m);
    expect(idleSuspendInstalledMinutes(script)).toBe(1);
    expect(plan.summary).toBe('suspends after 1 min idle (RDP: 1 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 5 min, checked every 30 s)');
  });

  it('decision 109: --ssh-minutes (default 20) goes into the script and the summary; without the flag the installed value is kept', () => {
    expect(def().plan(FACTS).files[0]?.content).toMatch(/^SSH_MINUTES=20$/m);
    expect(def().plan({ ...FACTS, sshMinutes: 45 }).files[0]?.content).toMatch(/^SSH_MINUTES=45$/m);
    expect(def().plan({ ...FACTS, sshMinutes: 45 }).summary).toBe('suspends after 30 min idle (RDP: 20 min, SSH: 45 min, no tty: 2048 B/s, wake grace: 5 min, checked every 1 min)');
    expect(def().plan({ ...FACTS, installedSshMinutes: 60 }).files[0]?.content).toMatch(/^SSH_MINUTES=60$/m);
    expect(def().plan({ ...FACTS, installedSshMinutes: 60, sshMinutes: 7 }).files[0]?.content).toMatch(/^SSH_MINUTES=7$/m);
    expect(def().plan({ ...FACTS, sshMinutes: 1 }).summary).toBe('suspends after 30 min idle (RDP: 20 min, SSH: 1 min, no tty: 2048 B/s, wake grace: 5 min, checked every 30 s)');
  });

  it('decision 111: refuses --ssh-minutes out of range, and the description, the file and next say how every ssh connection is tested (pts input, notty rate 2048 B/s)', () => {
    for (const sshMinutes of [1441, 0, 2.5, -1]) expect(() => def().plan({ ...FACTS, sshMinutes }), String(sshMinutes)).toThrow(/minutes/);
    expect(def().description).toMatch(/--ssh-minutes/);
    expect(def().description).toMatch(/2048 B\/s/);
    const text = def().next(def().plan(FACTS), 'desktop').join('\n');
    expect(text).toMatch(/every established ssh connection is tested: a session WITH A TERMINAL \(tty\) counts while its last input is more recent than --ssh-minutes/);
    expect(text).toMatch(/WITHOUT a tty.*at least 2048 B\/s.*first check of a connection/);
    expect(text).toMatch(/under 2048 B\/s.*can still be cut.*systemd-inhibit/);
    expect(def().plan(FACTS).files[0]?.describe).toMatch(/no ssh session with a terminal that had input in the last 20 min/);
    expect(def().plan(FACTS).files[0]?.describe).toMatch(/2048 B\/s/);
  });

  it('decision 103: refuses --rdp-minutes out of range (a plan never carries it)', () => {
    for (const rdpMinutes of [1441, 0, 2.5, -1]) expect(() => def().plan({ ...FACTS, rdpMinutes }), String(rdpMinutes)).toThrow(/minutes/);
  });

  it('refuses another platform with the supported ones', () => {
    for (const platform of ['win32', 'darwin', 'plan9']) {
      expect(() => def().plan({ ...FACTS, platform })).toThrow(new InstallError(unsupportedMessage(def(), platform)));
    }
  });

  it('refuses, naming the tool and the package, when a tool the script needs is missing (never a silent default)', () => {
    for (const [key, name, pkg] of [['date', 'date', 'coreutils'], ['ss', 'ss', 'iproute2'], ['systemdInhibit', 'systemd-inhibit', 'systemd'], ['logger', 'logger', 'util-linux']] as const) {
      const { [key]: _gone, ...rest } = FACTS.tools ?? {};
      const run = (): unknown => def().plan({ ...FACTS, tools: rest });
      expect(run, name).toThrow(InstallError);
      expect(run, name).toThrow(new RegExp(`${name} was not found.*${pkg}`));
    }
    expect(() => def().plan({ ...FACTS, tools: undefined })).toThrow(/date was not found/);
  });

  it('refuses a config folder that cannot be written into a root script, and an unknown one', () => {
    for (const configDir of ['/home/alice smith/.config/machine', "/home/o'neil/.config/machine", 'relative', '/home/$USER/.config', '/home/x/../root']) {
      expect(() => def().plan({ ...FACTS, configDir }), configDir).toThrow(InstallError);
    }
    expect(() => def().plan({ ...FACTS, configDir: undefined })).toThrow(/configuration folder of machine is unknown/);
  });

  it('refuses minutes out of range (a plan never carries them)', () => {
    for (const minutes of [1441, 0, 2.5, -1]) expect(() => def().plan({ ...FACTS, minutes }), String(minutes)).toThrow(/minutes/);
  });

  it('refuses an unsafe sudo or systemctl path', () => {
    expect(() => def().plan({ ...FACTS, sudoPath: 'sudo' })).toThrow(/sudo/);
    expect(() => def().plan({ ...FACTS, systemctlPath: '/usr/bin/sys temctl' })).toThrow(/systemctl/);
  });

  // ---- decision 113: cadence, wake grace
  const timerOf = (plan: ReturnType<typeof def>['plan'] extends (f: InstallFacts) => infer P ? P : never): string => plan.files.find((f) => f.id === 'timer')?.content ?? '';

  it('decision 113: the timer text follows the smallest of the three minutes (30 s below 10, 1 min up to 30, 2 min above), the script and the service do not depend on it', () => {
    expect(timerOf(def().plan({ ...FACTS, minutes: 9, rdpMinutes: 9, sshMinutes: 9 }))).toContain('OnUnitActiveSec=30s');
    expect(timerOf(def().plan({ ...FACTS, minutes: 9, rdpMinutes: 45, sshMinutes: 45 }))).toContain('OnUnitActiveSec=30s');
    expect(timerOf(def().plan({ ...FACTS, minutes: 10, rdpMinutes: 10, sshMinutes: 10 }))).toContain('OnUnitActiveSec=1min');
    expect(timerOf(def().plan({ ...FACTS, minutes: 60, rdpMinutes: 30, sshMinutes: 45 }))).toContain('OnUnitActiveSec=1min');
    expect(timerOf(def().plan({ ...FACTS, minutes: 60, rdpMinutes: 45, sshMinutes: 40 }))).toContain('OnUnitActiveSec=2min');
    expect(timerOf(def().plan({ ...FACTS, minutes: 31, rdpMinutes: 31, sshMinutes: 31 }))).toContain('OnUnitActiveSec=2min');
    const a = def().plan({ ...FACTS, minutes: 9, rdpMinutes: 9, sshMinutes: 9 });
    const b = def().plan({ ...FACTS, minutes: 60, rdpMinutes: 45, sshMinutes: 40 });
    expect(a.files.find((f) => f.id === 'service')?.sha256).toBe(b.files.find((f) => f.id === 'service')?.sha256);
    expect(a.files.find((f) => f.id === 'timer')?.sha256).not.toBe(b.files.find((f) => f.id === 'timer')?.sha256);
  });

  it('decision 113: without options the installed minutes of the three keep the cadence they gave (a status never calls the timer outdated for that)', () => {
    const installed = def().plan({ ...FACTS, installedMinutes: 9, installedRdpMinutes: 20, installedSshMinutes: 20 });
    expect(timerOf(installed)).toContain('OnUnitActiveSec=30s');
    const fromOptions = def().plan({ ...FACTS, minutes: 9 });
    expect(timerOf(fromOptions)).toBe(timerOf(installed));
  });

  it('decision 113: --wake-grace-minutes (default 5) goes into the script and the summary; without the flag the installed value is kept', () => {
    expect(def().plan(FACTS).files[0]?.content).toMatch(/^WAKE_GRACE_MINUTES=5$/m);
    expect(def().plan({ ...FACTS, wakeGraceMinutes: 12 }).files[0]?.content).toMatch(/^WAKE_GRACE_MINUTES=12$/m);
    expect(def().plan({ ...FACTS, wakeGraceMinutes: 12 }).summary).toBe('suspends after 30 min idle (RDP: 20 min, SSH: 20 min, no tty: 2048 B/s, wake grace: 12 min, checked every 1 min)');
    expect(def().plan({ ...FACTS, installedWakeGraceMinutes: 20 }).files[0]?.content).toMatch(/^WAKE_GRACE_MINUTES=20$/m);
    expect(def().plan({ ...FACTS, installedWakeGraceMinutes: 20, wakeGraceMinutes: 1 }).files[0]?.content).toMatch(/^WAKE_GRACE_MINUTES=1$/m);
    for (const wakeGraceMinutes of [0, 61, 2.5, -1]) expect(() => def().plan({ ...FACTS, wakeGraceMinutes }), String(wakeGraceMinutes)).toThrow(/wake grace/);
  });

  it('decision 113: the plan prints the computed delay (suspends N+c to N+2c with RDP, 2N without) and the cadence', () => {
    const notes = def().plan(FACTS).notes ?? [];
    expect(notes[1]).toBe('suspends 21 to 22 min after the last input with an RDP connection, 60 to 61 min without one (checked every 1 min)');
    expect((def().plan({ ...FACTS, minutes: 9, rdpMinutes: 9, sshMinutes: 9 }).notes ?? [])[1]).toBe('suspends 9.5 to 10 min after the last input with an RDP connection, 18 to 18.5 min without one (checked every 30 s)');
    expect((def().plan({ ...FACTS, minutes: 60, rdpMinutes: 45, sshMinutes: 40 }).notes ?? [])[1]).toBe('suspends 47 to 49 min after the last input with an RDP connection, 120 to 122 min without one (checked every 2 min)');
  });

  it('decision 113: the installed timer that does not run at the cadence the options give is said (outdated), with the fix; the same cadence says nothing', () => {
    const differs = def().plan({ ...FACTS, minutes: 9, installedCadenceSeconds: 120 });
    expect(differs.notes?.join('\n')).toContain('the installed timer runs every 2 min but these options give every 30 s: the timer is outdated, run `machine install idle-suspend --refresh`');
    expect(def().plan({ ...FACTS, installedCadenceSeconds: 60 }).notes?.join('\n')).not.toMatch(/outdated/);
    expect(def().plan(FACTS).notes?.join('\n')).not.toMatch(/outdated/);
  });

  it('decision 113: texts no longer say that the timer runs every 2 minutes, and the wake grace and the cadence are in the description, the file lines and the next steps', () => {
    const plan = def().plan(FACTS);
    expect(def().description).toMatch(/--wake-grace-minutes 1\.\.60/);
    expect(def().description).not.toMatch(/every 2 min/);
    expect(def().summaryLine).not.toMatch(/every 2 min/);
    expect(plan.files[0]?.describe).toMatch(/every 1 min/);
    expect(plan.files[0]?.describe).not.toMatch(/every 2 minutes/);
    expect(plan.files[2]?.describe).toBe('the systemd timer that starts the service 2 minutes after boot and then every 1 min');
    const text = def().next(plan, 'desktop').join('\n');
    expect(text).not.toMatch(/checks every 2 minutes|checked every 2 minutes/);
    expect(text).toMatch(/one line per check/);
    expect(text).toMatch(/--wake-grace-minutes/);
    expect(text).toMatch(/--minutes 5 --rdp-minutes 5 --ssh-minutes 5 --wake-grace-minutes 1 --refresh/);
  });
});
