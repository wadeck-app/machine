import { expect } from 'vitest';
import { SHELL, type World } from './world.js';

// The enrollment steps shared by the suites: the first machine (setup) and a second machine (join + admin approve), against the real relay.

// The only question is the passphrase hint (Enter = none): the full-access login and the machine login are both confirmed in the relay console.
export async function setupFirst(w: World, dir: string, hostname = 'Desktop'): Promise<void> {
  const r = await w.run('desktop', dir, ['setup', w.relay.url], { hostname, visible: [''] });
  expect(r.code, r.err).toBe(0);
}

/** `machine join` on the new machine while the admin machine approves during its wait. Returns both results. */
export async function joinSecond(w: World, adminDir: string, dir: string, who = 'laptop', hostname = 'Laptop') {
  let approved: { code: number; out: string; err: string } | undefined;
  const joined = await w.run(who, dir, ['join', w.relay.url], {
    hostname,
    visible: ['y'],
    onWait: async (_n, out) => {
      if (approved === undefined && /Candidacy \S+ posted/.test(out)) approved = await w.run('desktop', adminDir, ['admin', 'approve'], { visible: ['y'] });
    },
  });
  expect(approved?.code, approved?.err).toBe(0);
  expect(joined.code, joined.err).toBe(0);
  return { joined, approved: approved as { code: number; out: string; err: string } };
}

/** Allow `echo <word>` on `target`, from the admin machine. */
export async function allowEcho(w: World, adminDir: string, target: string, word: string): Promise<void> {
  const r = await w.run('desktop', adminDir, ['admin', 'allow', target, '--shell', SHELL, '--', `echo ${word}`], { visible: ['y'] });
  expect(r.code, r.err).toBe(0);
}

export const relayGet = async (w: World, path: string, token: string) => {
  const r = await fetch(`${w.relay.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
