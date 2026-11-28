import { describe, expect, it } from 'vitest';
import { defaultKeepAwakeWrapper, launchSpec, scrubEnv, withKeepAwake } from './launch.js';

const WIN_ENV = { SystemRoot: 'C:\\Windows' };

describe('launchSpec on Windows', () => {
  it('runs cmd with the approved string as ONE verbatim argument, never re-quoted', () => {
    const spec = launchSpec('cmd', 'echo "a b" & dir', 'win32', WIN_ENV);
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spec.windowsVerbatimArguments).toBe(true);
    // /s makes cmd strip exactly the outer pair of quotes we add, whatever quotes the approved string contains.
    // /v:off: delayed expansion (!var!) cannot be switched on by the registry of the user, the approved string means what it says.
    expect(spec.args).toEqual(['/d', '/v:off', '/s', '/c', '"echo "a b" & dir"']);
  });

  it('runs PowerShell with the string base64-encoded (UTF-16LE), so no quoting layer exists', () => {
    const spec = launchSpec('ps', "Write-Output 'x' \"y\"", 'win32', WIN_ENV);
    expect(spec.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spec.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(spec.args[4] as string, 'base64').toString('utf16le')).toBe("Write-Output 'x' \"y\"");
    expect(spec.windowsVerbatimArguments).toBe(false);
  });

  it.each(['bash', 'sh'] as const)('refuses %s on Windows and says why (bash.exe may be WSL)', (shell) => {
    expect(() => launchSpec(shell, 'ls', 'win32', WIN_ENV)).toThrow(/not supported on Windows/);
  });

  it('finds SystemRoot whatever its case, as Windows does', () => {
    expect(launchSpec('cmd', 'dir', 'win32', { SYSTEMROOT: 'C:\\Windows' }).file).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('names the missing variable when SystemRoot is unknown', () => {
    expect(() => launchSpec('cmd', 'dir', 'win32', {})).toThrow(/SystemRoot/);
  });
});

describe('launchSpec on Unix', () => {
  it.each(['linux', 'darwin'] as const)('runs bash and sh with -c and the string untouched on %s', (platform) => {
    expect(launchSpec('bash', "ls 'a b'", platform, {})).toMatchObject({ file: '/bin/bash', args: ['--noprofile', '--norc', '-c', "ls 'a b'"] });
    expect(launchSpec('sh', 'ls | wc -l', platform, {})).toMatchObject({ file: '/bin/sh', args: ['-c', 'ls | wc -l'] });
  });

  it('refuses cmd on Unix and says why', () => {
    expect(() => launchSpec('cmd', 'dir', 'linux', {})).toThrow(/only exists on Windows/);
  });

  it('runs PowerShell through pwsh', () => {
    expect(launchSpec('ps', 'Get-Date', 'linux', {}).file).toBe('pwsh');
  });
});

describe('launchSpec command checks', () => {
  it.each([
    ['', /empty/],
    ['a\nb', /printable ASCII/],
    ['caf\u00e9', /printable ASCII/],
    ['x'.repeat(2049), /longer than/],
  ])('refuses %j before building any command line', (command, message) => {
    expect(() => launchSpec('sh', command, 'linux', {})).toThrow(message);
  });

  it('refuses an unknown shell', () => {
    expect(() => launchSpec('zsh' as never, 'ls', 'linux', {})).toThrow(/unknown shell/);
  });
});

describe('scrubEnv', () => {
  it('keeps only the allow-listed variables, whatever their case on Windows', () => {
    const out = scrubEnv({ Path: 'p', SYSTEMROOT: 's', NODE_AUTH_TOKEN: 'secret', MACHINE_PASSPHRASE: 'secret', ComSpec: 'c' }, 'win32');
    expect(out).toEqual({ Path: 'p', SYSTEMROOT: 's', ComSpec: 'c', NoDefaultCurrentDirectoryInExePath: '1' });
  });

  it('forces NoDefaultCurrentDirectoryInExePath=1 on Windows, whatever the daemon had, and never on Unix', () => {
    expect(scrubEnv({ NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' }, 'win32')).toEqual({ NoDefaultCurrentDirectoryInExePath: '1' });
    expect(scrubEnv({}, 'win32').NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(scrubEnv({ NoDefaultCurrentDirectoryInExePath: '1' }, 'linux')).toEqual({});
  });

  it('keeps PSModuleAnalysisCachePath on Windows (a path, no secret): without it powershell.exe hung for more than 25 s on the windows-latest runner (measured by an env bisect, CI run 46129290430, #125), with it 0.3 s', () => {
    const out = scrubEnv({ PSMODULEANALYSISCACHEPATH: 'D:\\cache\\ModuleAnalysisCache', PSModulePath: 'x', Path: 'p' }, 'win32');
    expect(out).toEqual({ PSMODULEANALYSISCACHEPATH: 'D:\\cache\\ModuleAnalysisCache', Path: 'p', NoDefaultCurrentDirectoryInExePath: '1' });
    expect(scrubEnv({ PSModuleAnalysisCachePath: 'c' }, 'linux')).toEqual({});
  });

  it('is case-sensitive on Unix', () => {
    const out = scrubEnv({ PATH: 'p', path: 'q', HOME: 'h', AWS_SECRET_ACCESS_KEY: 'secret', LC_ALL: 'C' }, 'linux');
    expect(out).toEqual({ PATH: 'p', HOME: 'h', LC_ALL: 'C' });
  });
});

describe('keep-awake wrapper (macOS, T-71)', () => {
  it('is /usr/bin/caffeinate on darwin and absent elsewhere', () => {
    expect(defaultKeepAwakeWrapper('darwin')).toBe('/usr/bin/caffeinate');
    for (const p of ['linux', 'win32', 'freebsd'] as const) expect(defaultKeepAwakeWrapper(p)).toBeUndefined();
  });

  it('puts `-s` and the unchanged shell launch after the wrapper: the argv of the command is never altered', () => {
    const inner = launchSpec('bash', 'echo "a b" $(x) \'q\'', 'darwin', {});
    const wrapped = withKeepAwake(inner, '/usr/bin/caffeinate');
    expect(wrapped.file).toBe('/usr/bin/caffeinate');
    expect(wrapped.args).toEqual(['-s', '/bin/bash', '--noprofile', '--norc', '-c', 'echo "a b" $(x) \'q\'']);
    expect(wrapped.windowsVerbatimArguments).toBe(inner.windowsVerbatimArguments);
  });

  it('does not modify the spec it wraps', () => {
    const inner = launchSpec('sh', 'ls', 'darwin', {});
    const copy = JSON.parse(JSON.stringify(inner));
    withKeepAwake(inner, '/x');
    expect(inner).toEqual(copy);
  });
});
