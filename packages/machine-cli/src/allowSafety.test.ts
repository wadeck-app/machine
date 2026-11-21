import { entryFromText } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { unsafeTypedWarnings } from './allowSafety.js';

// "What a type cannot make safe" (typed-parameters.md): a typed entry on one of these programs or options is signed with a LOUD warning,
// never refused (the owner decides). An exact entry is not concerned: its text is written whole by the owner.

const warn = (text: string, shell: 'sh' | 'cmd' | 'ps' | 'bash' = 'sh'): string[] => unsafeTypedWarnings(entryFromText(text, shell));

describe('unsafeTypedWarnings', () => {
  it.each([
    'npm run <s:name>',
    'npm test <s:name>',
    'npm install <s:name>',
    'git pull <r:name>',
    'git -C <d:name> status',
    'git -c <k:name> status',
    'git fetch --upload-pack=<x:name>',
    'docker compose -f <f:name> up',
    'docker run <i:name>',
    'docker exec <c:name> ls',
    'find . -exec <c:name>',
    'tar --to-command=<c:name> -xf a.tar',
    'zip -TT <c:name> a.zip',
    'curl -o <f:name> http://x',
    'wget -e <c:name> http://x',
    'ssh -o <o:name> host',
    'ethtool -f <i:name> x',
    'ip netns exec <n:name> ls',
    'sudo <c:name>',
    'node -e <c:name>',
    'npx <p:name>',
    'orch add <j:name>',
    'orch edit <j:name>',
    'orch exec <j:name>',
    'orch stop --kill-jobs <j:name>',
    'queue sub add --command <c:name>',
    'queue dlq clear <q:name>',
    'flow worker source add --command <c:name>',
    'agent-browser eval <c:name>',
    'agent-browser open <u:name>',
    'machine run <m:name>',
    'machine admin allow <m:name>',
    'machine policy allow <m:name>',
    'machine join <r:name> --yes-final-code <c:name>',
    'tool --token <t:name>',
    'tool --invite=<t:name>',
    'tool credentials <u:name> <p:name>',
    'task delete --all <x:name>',
  ])('warns for the typed entry %s', (text) => {
    const w = warn(text);
    expect(w.length, text).toBeGreaterThan(0);
    for (const line of w) expect(line).toMatch(/^\[warn\]/);
  });

  it.each(['orch logs <j:name> --tail <n:int(1,500)>', 'journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager', 'task show <id:hexid(8)> --json', 'git show <r:hexid(40)>', 'ping <p:port>', 'npm.cmd ls <p:name>'])('does not warn for %s', (text) => {
    expect(warn(text)).toEqual([]);
  });

  it('knows the program under a path or an extension', () => {
    expect(warn('/usr/bin/sudo <c:name>').length).toBeGreaterThan(0);
    expect(warn('NPX.CMD <p:name>').length).toBeGreaterThan(0);
    expect(warn('C:/tools/node.exe -e <c:name>', 'cmd').length).toBeGreaterThan(0);
  });

  it('an exact entry is never warned about (its text is written whole by the owner)', () => {
    expect(warn('npm run build')).toEqual([]);
    expect(warn('sudo reboot')).toEqual([]);
  });

  it('says what makes each case unsafe, naming the cause', () => {
    expect(warn('npm run <s:name>').join('\n')).toMatch(/script/);
    expect(warn('sudo <c:name>').join('\n')).toMatch(/executes|writes/);
    expect(warn('orch add <j:name>').join('\n')).toMatch(/stores/);
    expect(warn('machine run <m:name>').join('\n')).toMatch(/relays|widens/);
    expect(warn('tool --token <t:name>').join('\n')).toMatch(/audit log/);
    expect(warn('task delete --all <x:name>').join('\n')).toMatch(/missing parameter/);
    expect(warn('agent-browser eval <c:name>').join('\n')).toMatch(/exact entries|fixed template/);
  });

  it('a warning names the fix: an exact entry', () => {
    expect(warn('sudo <c:name>').join('\n')).toMatch(/exact entry/);
  });
});
