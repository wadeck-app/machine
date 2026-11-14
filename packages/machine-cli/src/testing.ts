import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runCli } from './cli.js';
import { readMachine } from './identity.js';

// Test helpers (not shipped logic): drive the CLI in-process, and provision two machines that trust each other.

export async function cli(configDir: string, args: string[], prompt?: () => Promise<string>): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  // Everything after "--" is the remote command: options must come before it.
  const split = args.indexOf('--');
  const argv = split === -1 ? [...args, '--config-dir', configDir] : [...args.slice(0, split), '--config-dir', configDir, ...args.slice(split)];
  const code = await runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), ...(prompt ? { prompt } : {}) }, {});
  return { code, out, err };
}

export async function ok(configDir: string, args: string[], prompt?: () => Promise<string>): Promise<{ code: number; out: string; err: string }> {
  const r = await cli(configDir, args, prompt);
  if (r.code !== 0) throw new Error(`machine ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r;
}

export interface PolicyDraftEntry {
  shell: string;
  command: string;
  limits?: { maxCalls: number };
}

/**
 * A is the admin machine ("desktop"), B receives commands ("laptop"): initialized, registered with each other through
 * bundles, B pins the admin key and has the policy installed. No daemon is started.
 */
export async function provision(root: string, a: string, b: string, policy: PolicyDraftEntry[]): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  await ok(b, ['init', '--name', 'laptop']);
  const init = await ok(a, ['admin', 'init']);
  const passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  const prompt = async () => passphrase;

  await ok(a, ['peer', 'info', '--out', join(root, 'a-info.json')]);
  await ok(b, ['peer', 'info', '--out', join(root, 'b-info.json')]);
  // One pair secret for the pair: the second registration reuses the first bundle's secret.
  await ok(a, ['admin', 'register', join(root, 'b-info.json'), '--out', join(root, 'for-a.json')], prompt);
  await ok(a, ['admin', 'register', join(root, 'a-info.json'), '--secret-from', join(root, 'for-a.json'), '--out', join(root, 'for-b.json')], prompt);
  await ok(a, ['peer', 'import', join(root, 'for-a.json')]);
  await ok(b, ['admin', 'pin', join(a, 'admin.json')]);
  await ok(b, ['peer', 'import', join(root, 'for-b.json')]);

  const target = readMachine(b).uuid;
  writeFileSync(join(root, 'draft.json'), JSON.stringify({ v: 1, target, version: 1, baseVersion: 0, defaults: policy, peers: {} }));
  await ok(a, ['admin', 'sign-policy', join(root, 'draft.json'), '--out', join(root, 'policy-b.json')], prompt);
  await ok(b, ['policy', 'install', join(root, 'policy-b.json')]);
}
