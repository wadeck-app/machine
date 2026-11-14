import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runCli, type CliIo } from './cli.js';
import { adminInit } from './admin.js';
import type { Timing } from './cliTypes.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, registerMachine, type MachineInfo } from './network.js';

// Test helpers (not shipped logic): drive the CLI in-process, and provision two machines that trust each other.

export async function cli(configDir: string, args: string[], prompt?: () => Promise<string>, extraIo: Partial<CliIo> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  // Everything after "--" is the remote command: options must come before it.
  const split = args.indexOf('--');
  const argv = split === -1 ? [...args, '--config-dir', configDir] : [...args.slice(0, split), '--config-dir', configDir, ...args.slice(split)];
  const code = await runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), ...(prompt ? { prompt } : {}), ...extraIo }, {});
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

export interface TestAdmin {
  dir: string;
  passphrase: string;
  adminPublicKey: string;
  adminKeyId: string;
}

/** An admin key created in `dir` with the existing admin code (tests only). */
export function makeAdmin(dir: string): TestAdmin {
  const r = adminInit(dir);
  return { dir, passphrase: r.passphrase, adminPublicKey: r.adminPublicKey, adminKeyId: r.adminKeyId };
}

/**
 * The approval an admin console would send for the machine initialized in `candidateDir`, built with the existing admin
 * functions (registerMachine): its own registration, the admin pin document and the registrations of `peerDirs`.
 * `selfInfo` registers another machine than the candidate (mix-up tests).
 */
export async function buildApproval(admin: TestAdmin, candidateDir: string, options: { peerDirs?: string[]; selfInfo?: MachineInfo } = {}): Promise<Record<string, unknown>> {
  const prompt = async () => admin.passphrase;
  const now = () => Math.floor(Date.now() / 1000);
  const register = (info: MachineInfo) => registerMachine(admin.dir, info, { now, prompt, validForDays: 30 });
  const self = await register(options.selfInfo ?? exportMachineInfo(candidateDir));
  const peers = [];
  for (const dir of options.peerDirs ?? []) peers.push(await register(exportMachineInfo(dir)));
  return { v: 1, self, admin: { v: 1, adminPublicKey: admin.adminPublicKey, adminKeyId: admin.adminKeyId }, peers };
}

/** A clock that never waits: sleeping advances it, so a 15 minute wait costs nothing. `onSleep` is the admin's move. */
export function fakeTiming(onSleep: (ms: number, count: number) => void = () => undefined, pollIntervalMs = 3000): Timing & { sleeps: number[]; now: () => number } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    nowMs: () => t,
    pollIntervalMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
      onSleep(ms, sleeps.length);
    },
  };
}
