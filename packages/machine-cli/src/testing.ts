import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runCli, type CliIo } from './cli.js';
import { adminInit } from './admin.js';
import type { Timing } from './cliTypes.js';
import { readMachine } from './identity.js';
import type { PromptTimer } from './prompt.js';
import { approvalSealContext, pairSecretContext, sealApproval, sealBundle, type SealedBundle } from './approval.js';
import { PLACEHOLDER, registerDraft } from './approvalDraft.js';
import { NotInitializedError } from './errors.js';
import { exportMachineInfo, registerMachine, type MachineInfo } from './network.js';
import { documentSealContext, openSealed, sealTo } from '@wadeck-app/machine-core';

// Test helpers (not shipped logic): drive the CLI in-process, and provision two machines that trust each other.

/**
 * Like `cliRaw`, but `join` and `setup` get `--policy admin` unless the test names one (or posts only, `--no-wait`): the "Allow list" question
 * (decision 70) is not what most tests are about. The tests of that question call `cliRaw`.
 */
export async function cli(configDir: string, args: string[], prompt?: (label: string) => Promise<string>, extraIo: Partial<CliIo> = {}): Promise<{ code: number; out: string; err: string }> {
  const asksAllowList = (args[0] === 'join' || args[0] === 'setup') && !args.includes('--policy') && !args.includes('--no-wait');
  return cliRaw(configDir, asksAllowList ? [...args.slice(0, args.includes('--') ? args.indexOf('--') : args.length), '--policy', 'admin', ...args.slice(args.includes('--') ? args.indexOf('--') : args.length)] : args, prompt, extraIo);
}

export async function cliRaw(configDir: string, args: string[], prompt?: (label: string) => Promise<string>, extraIo: Partial<CliIo> = {}): Promise<{ code: number; out: string; err: string }> {
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
  input?: { format: string; maxBytes: number; chars: string[] };
  shell: string;
  command: string;
  limits?: { maxCalls: number };
}

/**
 * A is the admin machine ("desktop"), B receives commands ("laptop"): initialized, registered with each other through
 * bundles, B pins the admin key and has the policy installed. No daemon is started.
 */
export async function provision(root: string, a: string, b: string, policy: PolicyDraftEntry[]): Promise<string> {
  await ok(a, ['init', '--name', 'desktop']);
  await ok(b, ['init', '--name', 'laptop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
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
  writeFileSync(join(root, 'draft.json'), JSON.stringify({ v: policy.some((e) => e.input !== undefined) ? 3 : 1, target, version: 1, baseVersion: 0, defaults: policy, peers: {} }));
  await ok(a, ['admin', 'sign-policy', join(root, 'draft.json'), '--out', join(root, 'policy-b.json')], prompt);
  await ok(b, ['policy', 'install', join(root, 'policy-b.json')]);
  // The admin passphrase, for tests that sign again from the admin machine.
  return passphrase;
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
 * The pair secrets are sealed like `machine admin approve` does, but only when the fake relay stores the approval (the
 * candidacy random is not known before): see approvalDraft.ts. `sealRecipientKey`, `sealRandom` and `sealPlaintext` seal
 * wrongly on purpose (refusal tests).
 */
export async function buildApproval(
  admin: TestAdmin,
  candidateDir: string,
  options: { peerDirs?: string[]; selfInfo?: MachineInfo; sealRecipientKey?: string; sealRandom?: string; sealPlaintext?: Uint8Array } = {},
): Promise<Record<string, unknown>> {
  const prompt = async () => admin.passphrase;
  const now = () => Math.floor(Date.now() / 1000);
  const register = (info: MachineInfo) => registerMachine(admin.dir, info, { now, prompt, validForDays: 30 });
  const self = await register(options.selfInfo ?? exportMachineInfo(candidateDir));
  const peers: Awaited<ReturnType<typeof register>>[] = [];
  for (const dir of options.peerDirs ?? []) peers.push(await register(exportMachineInfo(dir)));
  let adminUuid: string | null = null;
  try {
    adminUuid = exportMachineInfo(admin.dir).uuid;
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
  }
  const candidate = exportMachineInfo(candidateDir);
  const placeholder = (b: { registration: SealedBundle['registration'] }): SealedBundle => ({ registration: b.registration, sealedPairSecret: PLACEHOLDER });
  const placeholders = { self: placeholder(self), peers: peers.map(placeholder) };
  const approval = { v: 1, self: placeholders.self, admin: { v: 1, adminPublicKey: admin.adminPublicKey, adminKeyId: admin.adminKeyId }, adminUuid, peers: placeholders.peers };
  registerDraft(approval, {
    secrets: { self: self.pairSecret, peers: peers.map((p) => p.pairSecret) },
    complete: (random) => {
      const sealRandom = options.sealRandom ?? random;
      const key = options.sealRecipientKey ?? candidate.identityPublicKey;
      const seal = (bundle: typeof self, slot: string): SealedBundle => {
        const parts = { adminUuid, candidateUuid: candidate.uuid, random: sealRandom, slot };
        if (options.sealPlaintext === undefined) return sealBundle(bundle, key, parts);
        return { registration: bundle.registration, sealedPairSecret: sealTo(key, options.sealPlaintext, pairSecretContext(parts)) };
      };
      const fill = (target: SealedBundle, bundle: typeof self, slot: string): void => {
        if (target.sealedPairSecret === PLACEHOLDER) target.sealedPairSecret = seal(bundle, slot).sealedPairSecret;
      };
      // Fill the entries this draft created: a test may have replaced approval.self or approval.peers since.
      fill(placeholders.self, self, 'self');
      placeholders.peers.forEach((p, i) => fill(p, peers[i] as typeof self, `peer:${(peers[i] as typeof self).registration.body.uuid}`));
      // The whole approval is sealed to the real candidate key like `machine admin approve` does (options.sealRecipientKey only breaks the pair secrets).
      return sealApproval({ ...approval, random }, candidate.identityPublicKey, candidate.uuid);
    },
  });
  return approval;
}

/**
 * The inner approval of what the relay stores for a candidacy (decision 78: it is one sealed blob). Tests only: it needs the identity key of the candidate,
 * which the relay never has. Throws when the stored approval is not sealed to that candidate.
 */
export function openApprovalFor(candidateDir: string, stored: unknown): any {
  const outer = stored as { random: string; sealed: string };
  const me = readMachine(candidateDir);
  return JSON.parse(Buffer.from(openSealed(me.identity.privateKeyPkcs8, outer.sealed, approvalSealContext(me.uuid, outer.random))).toString('utf8'));
}

/** The clear payload of an inbox document addressed to the machine in `dir` (decision 78: sealed to it). Tests only. */
export function openDocumentFor(dir: string, document: unknown): any {
  const { kind, to, id, payload } = (document as { body: { kind: 'peer' | 'policy' | 'revocation'; to: string; id: string; payload: { sealed: string } } }).body;
  return JSON.parse(Buffer.from(openSealed(readMachine(dir).identity.privateKeyPkcs8, payload.sealed, documentSealContext(kind, to, id))).toString('utf8'));
}

/** What a hostile relay cannot do (it cannot open) but a test of the candidate's checks needs: change the inner approval of a stored one, sealed again in place. */
export function rewriteApprovalFor(candidateDir: string, stored: unknown, change: (inner: any) => void): void {
  const outer = stored as { v: 2; random: string; sealed: string };
  const inner = openApprovalFor(candidateDir, stored);
  change(inner);
  outer.sealed = sealApproval(inner, exportMachineInfo(candidateDir).identityPublicKey, exportMachineInfo(candidateDir).uuid).sealed;
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

/** A prompt timer that never waits: the test fires it by hand and reads the delay that was asked for. */
export function fakePromptTimer(): { timer: PromptTimer; pending: () => number; delays: number[]; fire: () => void } {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;
  return {
    timer: {
      set: (fn, ms) => {
        delays.push(ms);
        pending.set(++next, fn);
        return next;
      },
      clear: (handle) => void pending.delete(handle as number),
    },
    pending: () => pending.size,
    delays,
    fire: () => {
      const all = [...pending.values()];
      pending.clear();
      for (const fn of all) fn();
    },
  };
}
