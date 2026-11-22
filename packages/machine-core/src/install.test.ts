import { describe, expect, it } from 'vitest';
import {
  INSTALLABLES,
  INSTALL_USER_PATTERN,
  InstallError,
  classifyInstalled,
  deriveInstallState,
  stateLabel,
  stateNextSteps,
  findInstallable,
  markerLine,
  platformName,
  rootReadArgv,
  sha256Hex,
  unsupportedMessage,
  type FileObservation,
  type InstallFacts,
} from './install.js';

const FACTS: InstallFacts = { platform: 'linux', userName: 'alice', systemctlPath: '/usr/bin/systemctl', sudoPath: '/usr/bin/sudo' };
const suspend = (): NonNullable<ReturnType<typeof findInstallable>> => {
  const def = findInstallable('suspend');
  if (def === undefined) {
    throw new Error('suspend is not registered');
  }
  return def;
};

describe('registry', () => {
  it('lists suspend, for linux only, with a description and the consequence of allowing it', () => {
    expect(INSTALLABLES.map((d) => d.id)).toEqual(['suspend']);
    const def = suspend();
    expect(def.platforms).toEqual(['linux']);
    expect(def.description.length).toBeGreaterThan(10);
    expect(def.consequence).toMatch(/every trusted peer/);
    expect(def.consequence).toMatch(/per-peer list/);
  });

  it('findInstallable answers undefined for an unknown id', () => {
    expect(findInstallable('nothing')).toBeUndefined();
  });

  it('platformName: friendly names, the raw value otherwise', () => {
    expect(platformName('win32')).toBe('windows');
    expect(platformName('darwin')).toBe('macos');
    expect(platformName('linux')).toBe('linux');
    expect(platformName('freebsd')).toBe('freebsd');
  });

  it('unsupportedMessage names the platform and the supported ones', () => {
    expect(unsupportedMessage(suspend(), 'win32')).toBe('not supported on windows yet (supported: linux)');
    expect(unsupportedMessage(suspend(), 'darwin')).toBe('not supported on macos yet (supported: linux)');
  });
});

describe('suspend plan (linux)', () => {
  it('writes the script with the marker, the absolute sudo and the absolute systemctl', () => {
    const plan = suspend().plan(FACTS);
    const script = plan.files.find((f) => f.id === 'script');
    expect(script?.path).toBe('/usr/local/bin/machine-suspend');
    expect(script?.mode).toBe('0755');
    expect(script?.content).toBe(
      [
        '#!/bin/sh',
        '# managed by machine install suspend, version 1',
        '# Suspend this box 3 s after the call, so the caller still gets its answer.',
        '# Written by `machine install suspend`; `machine install suspend --remove` removes it.',
        '( sleep 3; exec /usr/bin/sudo -n /usr/bin/systemctl suspend ) >/dev/null 2>&1 &',
        '',
      ].join('\n'),
    );
  });

  it('writes the sudoers drop-in with the marker and ONE rule for the exact command', () => {
    const plan = suspend().plan({ ...FACTS, userName: 'bob_2-x', systemctlPath: '/bin/systemctl' });
    const sudoers = plan.files.find((f) => f.id === 'sudoers');
    expect(sudoers?.path).toBe('/etc/sudoers.d/machine-suspend');
    expect(sudoers?.mode).toBe('0440');
    expect(sudoers?.content).toBe(
      [
        '# managed by machine install suspend, version 1',
        '# Written by `machine install suspend`: this user may suspend this machine without a password (this one command, nothing else).',
        'bob_2-x ALL=(root) NOPASSWD: /bin/systemctl suspend',
        '',
      ].join('\n'),
    );
    expect(sudoers?.content.split('\n').filter((l) => l !== '' && !l.startsWith('#'))).toHaveLength(1);
  });

  it('both files are root-owned and carry the hash of their content', () => {
    const plan = suspend().plan(FACTS);
    for (const f of plan.files) {
      expect(f.owner).toBe('root');
      expect(f.group).toBe('root');
      expect(f.sha256).toBe(sha256Hex(f.content));
      expect(f.content.split('\n')).toContain(markerLine('suspend', plan.version));
    }
  });

  it('the install steps, in order: stage both, validate with visudo, install the script, install the sudoers file', () => {
    const plan = suspend().plan(FACTS);
    expect(plan.steps.map((s) => (s.kind === 'stage' ? `stage ${s.file}` : `${s.purpose} ${s.file}`))).toEqual(['stage script', 'stage sudoers', 'validate sudoers', 'install script', 'install sudoers']);
    const validate = plan.steps.find((s) => s.kind === 'run' && s.purpose === 'validate');
    expect(validate?.kind === 'run' && validate.argv).toEqual(['/usr/bin/sudo', 'visudo', '-c', '-f', { stage: 'sudoers' }]);
    const script = plan.steps.find((s) => s.kind === 'run' && s.purpose === 'install' && s.file === 'script');
    expect(script?.kind === 'run' && script.argv).toEqual(['/usr/bin/sudo', 'install', '-m', '0755', '-o', 'root', '-g', 'root', { stage: 'script' }, '/usr/local/bin/machine-suspend']);
    const sudoers = plan.steps.find((s) => s.kind === 'run' && s.purpose === 'install' && s.file === 'sudoers');
    expect(sudoers?.kind === 'run' && sudoers.argv).toEqual(['/usr/bin/sudo', 'install', '-m', '0440', '-o', 'root', '-g', 'root', { stage: 'sudoers' }, '/etc/sudoers.d/machine-suspend']);
  });

  it('the remove steps take the sudoers rule first, then the script, and name only those two paths', () => {
    const plan = suspend().plan(FACTS);
    expect(plan.removeSteps.map((s) => s.argv)).toEqual([
      ['/usr/bin/sudo', 'rm', '--', '/etc/sudoers.d/machine-suspend'],
      ['/usr/bin/sudo', 'rm', '--', '/usr/local/bin/machine-suspend'],
    ]);
  });

  it('the probe is the non-interactive listing of the exact command', () => {
    expect(suspend().plan(FACTS).probe).toEqual(['/usr/bin/sudo', '-n', '-l', '/usr/bin/systemctl', 'suspend']);
  });

  it('rootReadArgv reads a file as root and exits 3 when it does not exist', () => {
    expect(rootReadArgv('/usr/bin/sudo', '/etc/sudoers.d/machine-suspend')).toEqual(['/usr/bin/sudo', 'sh', '-c', 'test -e "$1" || exit 3; cat -- "$1"', 'machine-install', '/etc/sudoers.d/machine-suspend']);
  });

  it('the next steps, in order: paths, local test, allow line, use, wake', () => {
    const def = suspend();
    const lines = def.next(def.plan(FACTS), 'desktop').join('\n');
    const at = (s: string): number => lines.indexOf(s);
    expect(at('/usr/local/bin/machine-suspend')).toBeGreaterThanOrEqual(0);
    expect(at('sudo -n -l /usr/bin/systemctl suspend')).toBeGreaterThan(at('/etc/sudoers.d/machine-suspend'));
    expect(at('machine admin allow desktop --shell sh -- /usr/local/bin/machine-suspend')).toBeGreaterThan(at('sudo -n -l'));
    expect(at('machine run desktop -- /usr/local/bin/machine-suspend')).toBeGreaterThan(at('machine admin allow'));
    expect(at('machine wake desktop')).toBeGreaterThan(at('machine run desktop'));
    expect(lines).toMatch(/every trusted peer/);
  });
});

describe('suspend: after a removal', () => {
  it('names the entry to withdraw on the admin machine', () => {
    const def = suspend();
    expect(def.afterRemove(def.plan(FACTS), 'desktop').join('\n')).toContain('machine admin allow desktop --shell sh --remove -- /usr/local/bin/machine-suspend');
  });
});

describe('suspend plan: refusals', () => {
  it.each(['win32', 'darwin', 'freebsd'])('refuses %s with the exact message and no plan', (platform) => {
    expect(() => suspend().plan({ ...FACTS, platform })).toThrowError(new InstallError(unsupportedMessage(suspend(), platform)));
  });

  it.each(['', 'Alice', '1abc', '-abc', 'a b', 'a;b', 'a\nb', 'root ALL=(ALL) NOPASSWD: ALL', 'a'.repeat(33), 'domain\\user', 'user.name', 'é'])('refuses the user name %j', (userName) => {
    expect(() => suspend().plan({ ...FACTS, userName })).toThrow(InstallError);
    expect(() => suspend().plan({ ...FACTS, userName })).toThrow(/user name/);
  });

  it.each(['alice', '_svc', 'a', 'a'.repeat(32), 'bob-1_x'])('accepts the user name %j', (userName) => {
    expect(INSTALL_USER_PATTERN.test(userName)).toBe(true);
    expect(() => suspend().plan({ ...FACTS, userName })).not.toThrow();
  });

  it.each(['systemctl', './systemctl', '', '/usr/bin/system ctl', '/usr/bin/systemctl,/bin/sh', '/usr/bin/sys\nctl', '/usr/bin/sys:ctl', '/usr/bin/sys=ctl', '/usr/bin/sys\\ctl'])('refuses the systemctl path %j', (systemctlPath) => {
    expect(() => suspend().plan({ ...FACTS, systemctlPath })).toThrow(InstallError);
    expect(() => suspend().plan({ ...FACTS, systemctlPath })).toThrow(/systemctl/);
  });

  it('refuses a relative sudo path too', () => {
    expect(() => suspend().plan({ ...FACTS, sudoPath: 'sudo' })).toThrow(/sudo/);
  });
});

describe('classifyInstalled', () => {
  const file = suspend().plan(FACTS).files[0]!;
  it('absent when nothing is there', () => {
    expect(classifyInstalled(file, undefined)).toEqual({ state: 'absent' });
  });
  it('current when the content is the one this build ships', () => {
    expect(classifyInstalled(file, file.content)).toEqual({ state: 'current', sha256: file.sha256 });
  });
  it('outdated when it carries the marker and another content, with the installed version and hash', () => {
    const old = file.content.replace('version 1', 'version 0').replace('3 s', '5 s');
    expect(classifyInstalled(file, old)).toEqual({ state: 'outdated', sha256: sha256Hex(old), version: 0 });
  });
  it('foreign when there is no marker: never touched', () => {
    expect(classifyInstalled(file, '#!/bin/sh\nsystemctl suspend\n')).toEqual({ state: 'foreign', sha256: sha256Hex('#!/bin/sh\nsystemctl suspend\n') });
  });
  it('a marker of ANOTHER installable is foreign', () => {
    expect(classifyInstalled(file, '# managed by machine install wake, version 1\n').state).toBe('foreign');
  });
});

// ---------------------------------------------------------------- lifecycle (install.md, "Lifecycle")

describe('lifecycle contract: every installable of the registry', () => {
  it.each(INSTALLABLES.map((d) => [d.id, d] as const))('%s provides status, install, refresh and remove', (_id, def) => {
    // The id is a word of the command line: it can never be the sub-command `status` (or an option).
    expect(def.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(def.id).not.toBe('status');
    expect(def.platforms.length).toBeGreaterThan(0);
    const facts: InstallFacts = { ...FACTS, platform: def.platforms[0] as string };
    const plan = def.plan(facts);
    expect(plan.id).toBe(def.id);
    // install and refresh: both run plan.steps; every file is staged and installed by a step that names it.
    expect(plan.files.length).toBeGreaterThan(0);
    for (const f of plan.files) {
      expect(f.content.split('\n'), `${f.path} carries the marker`).toContain(markerLine(def.id, plan.version));
      expect(f.sha256).toBe(sha256Hex(f.content));
      expect(plan.steps.some((s) => s.kind === 'stage' && s.file === f.id), `${f.path} is staged`).toBe(true);
      expect(plan.steps.some((s) => s.kind === 'run' && s.purpose === 'install' && s.file === f.id), `${f.path} is installed`).toBe(true);
      // remove: every file has a removal step, with the fix to apply by hand.
      const removal = plan.removeSteps.filter((s) => s.file === f.id);
      expect(removal, `${f.path} is removed`).toHaveLength(1);
      expect(removal[0]?.fix.length).toBeGreaterThan(5);
    }
    expect(plan.removeSteps.every((s) => plan.files.some((f) => f.id === s.file))).toBe(true);
    // status: a probe that never prompts (sudo -n) when a file is root-only, and the lines of the three outcomes.
    expect(plan.probe.length).toBeGreaterThan(0);
    if (plan.files.some((f) => f.rootOnly)) {
      expect(plan.probe).toContain('-n');
    }
    expect(def.next(plan, 'desktop').length).toBeGreaterThan(0);
    expect(def.afterRemove(plan, 'desktop').length).toBeGreaterThan(0);
  });

  it('refuses a platform it does not list, with the supported ones', () => {
    for (const def of INSTALLABLES) {
      expect(() => def.plan({ ...FACTS, platform: 'plan9' })).toThrow(unsupportedMessage(def, 'plan9'));
    }
  });
});

describe('deriveInstallState', () => {
  const F = (path: string, rootOnly: boolean, observed: FileObservation) => ({ path, rootOnly, observed });

  it('every part there and current: installed', () => {
    expect(deriveInstallState([F('/a', false, 'current'), F('/b', true, 'unread')], true)).toEqual({ state: 'installed', missing: [] });
    expect(deriveInstallState([F('/a', false, 'current'), F('/b', true, 'current')], undefined)).toEqual({ state: 'installed', missing: [] });
  });

  it('nothing there: not installed', () => {
    expect(deriveInstallState([F('/a', false, 'absent'), F('/b', true, 'unread')], false)).toEqual({ state: 'not installed', missing: ['/a', '/b'] });
  });

  it('one part without the other: partial, naming what is missing', () => {
    expect(deriveInstallState([F('/a', false, 'current'), F('/b', true, 'unread')], false)).toEqual({ state: 'partial', missing: ['/b'] });
    expect(deriveInstallState([F('/a', false, 'absent'), F('/b', true, 'unread')], true)).toEqual({ state: 'partial', missing: ['/a'] });
  });

  it('a file machine did not write wins over everything: foreign; then outdated', () => {
    expect(deriveInstallState([F('/a', false, 'foreign'), F('/b', true, 'unread')], true).state).toBe('foreign');
    expect(deriveInstallState([F('/a', false, 'outdated'), F('/b', true, 'unread')], true).state).toBe('outdated');
    expect(deriveInstallState([F('/a', false, 'outdated'), F('/b', true, 'foreign')], undefined).state).toBe('foreign');
  });

  it('without a question to sudo (undefined) the root-only files are left out of the verdict', () => {
    expect(deriveInstallState([F('/a', false, 'current'), F('/b', true, 'unread')], undefined)).toEqual({ state: 'installed', missing: [] });
    expect(deriveInstallState([F('/a', false, 'absent'), F('/b', true, 'unread')], undefined)).toEqual({ state: 'not installed', missing: ['/a'] });
  });
});

describe('state vocabulary', () => {
  it('stateLabel spells out "installed, up to date"; the other states keep their name', () => {
    expect(stateLabel('installed')).toBe('installed, up to date');
    expect(stateLabel('not installed')).toBe('not installed');
    expect(stateLabel('outdated')).toBe('outdated (this build ships newer content)');
    expect(stateLabel('unsupported here')).toBe('unsupported here');
  });

  it('stateNextSteps: the command that moves each state forward', () => {
    expect(stateNextSteps('suspend', 'installed', [])).toEqual([]);
    expect(stateNextSteps('suspend', 'unsupported here', [])).toEqual([]);
    expect(stateNextSteps('suspend', 'not installed', [])).toEqual(['machine install suspend']);
    expect(stateNextSteps('suspend', 'outdated', [])).toEqual(['machine install suspend --refresh']);
    expect(stateNextSteps('suspend', 'partial', [])).toEqual(['machine install suspend']);
    expect(stateNextSteps('suspend', 'foreign', ['/x/y'])).toEqual(['sudo rm -- /x/y   (after reading it: machine never touches a file it did not write)', 'machine install suspend']);
  });
});
