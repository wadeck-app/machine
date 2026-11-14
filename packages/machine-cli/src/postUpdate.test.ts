import { describe, expect, it } from 'vitest';
import { postUpdate, type PostUpdateDeps } from './postUpdate.js';

// T9: `machine cli post-update`, run by the NEW install after an update or a rollback. Fake orch and fake daemon: nothing real.

const NEW = '2026.11.14-592-bbbbbbbb';
const OLD = '2026.11.14-590-aaaaaaaa';

function make(over: { job?: boolean; daemon?: { version: string } | undefined; enableFails?: string; quitFails?: string } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const job = over.job ?? true;
  const daemon = 'daemon' in over ? over.daemon : { version: OLD };
  const deps: PostUpdateDeps = {
    newVersion: NEW,
    startup: {
      status: async () => {
        calls.push('status');
        return { exists: job };
      },
      enable: async () => {
        calls.push('enable');
        if (over.enableFails) throw new Error(over.enableFails);
        return { action: 'updated' };
      },
    },
    daemon: {
      version: async () => {
        calls.push('version');
        return daemon?.version;
      },
      quit: async () => {
        calls.push('quit');
        if (over.quitFails) throw new Error(over.quitFails);
      },
    },
    say: (line) => lines.push(line),
  };
  return { deps, calls, lines };
}

describe('post-update', () => {
  it('job absent: nothing is enabled and nothing is restarted', async () => {
    const t = make({ job: false });
    expect(await postUpdate(t.deps)).toEqual({ startup: 'absent', daemon: 'left-alone' });
    expect(t.calls).toEqual(['status']);
  });

  it('job absent: a daemon started by hand is never stopped (nobody would restart it), and a line tells how to restart it', async () => {
    const t = make({ job: false });
    await postUpdate(t.deps);
    expect(t.calls).not.toContain('quit');
    expect(t.lines.join('\n')).toMatch(/no startup job.*machine stop/s);
  });

  it('job present: startup enable runs, then an older daemon gets exactly one quit', async () => {
    const t = make();
    expect(await postUpdate(t.deps)).toEqual({ startup: 'enabled', daemon: 'restarted' });
    expect(t.calls).toEqual(['status', 'enable', 'version', 'quit']);
    expect(t.lines.join('\n')).toMatch(/\[ok\] startup job.*updated/);
    expect(t.lines.join('\n')).toMatch(new RegExp(`daemon v${OLD}.*restart`));
  });

  it('job present and the daemon already runs the new version (enable restarted it): no quit', async () => {
    const t = make({ daemon: { version: NEW } });
    expect(await postUpdate(t.deps)).toEqual({ startup: 'enabled', daemon: 'current' });
    expect(t.calls).toEqual(['status', 'enable', 'version']);
  });

  it('job present and no daemon running: nothing to restart', async () => {
    const t = make({ daemon: undefined });
    expect(await postUpdate(t.deps)).toEqual({ startup: 'enabled', daemon: 'not-running' });
    expect(t.calls).not.toContain('quit');
  });

  it('a failing startup enable is raised with the manual command, and the daemon is not touched', async () => {
    const t = make({ enableFails: 'orch refused' });
    await expect(postUpdate(t.deps)).rejects.toThrow(/orch refused.*machine startup enable/s);
    expect(t.calls).not.toContain('quit');
  });

  it('a failing quit is raised with the way to restart by hand', async () => {
    const t = make({ quitFails: 'timeout' });
    await expect(postUpdate(t.deps)).rejects.toThrow(/timeout.*machine stop/s);
  });
});
