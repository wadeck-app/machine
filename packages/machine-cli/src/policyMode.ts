import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { keyId, type PolicyMode } from '@wadeck-app/machine-core';
import { SECRETS_DIRNAME } from './paths.js';

// Who manages the allow list of THIS machine (hard rule 4 as amended). No mode file means mode `admin` (delegation, the default).
// The mode file pins the PUBLIC key of the local policy key: it has the trust level of the admin pin file (admin.json), nothing more.
//
// Two policy lines never share a file or a counter, so that a mode change cannot lower a version (T-16):
//   admin line: policy.json + policy-state.json          (signed by the admin key, domain machine/policy/v1)
//   local line: policy-local.json + policy-local-state.json (signed by the local policy key, domain machine/policy-local/v1)

export const policyModeFile = (configDir: string): string => join(configDir, 'policy-mode.json');
export const localPolicyKeyFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'policy.key.json');

export interface PolicyFiles {
  policy: string;
  state: string;
}

export const policyFiles = (configDir: string, mode: PolicyMode): PolicyFiles =>
  mode === 'local'
    ? { policy: join(configDir, 'policy-local.json'), state: join(configDir, 'policy-local-state.json') }
    : { policy: join(configDir, 'policy.json'), state: join(configDir, 'policy-state.json') };

export type ModeInfo = { mode: 'admin' } | { mode: 'local'; localPublicKey: string; localKeyId: string; since: number };

const FIX = `restore it from a backup, or, with the daemon stopped, delete it to go back to mode admin (see "Forgotten local passphrase" in getting-started.md)`;

/** The policy mode of this machine. A mode file that is damaged is an error naming the file, never silently mode `admin`. */
export function readPolicyMode(configDir: string): ModeInfo {
  const file = policyModeFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'admin' };
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} is corrupt or invalid (not valid JSON): ${FIX}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file} is corrupt or invalid (not an object): ${FIX}`);
  const keys = Object.keys(raw);
  const unknown = keys.find((k) => !['v', 'mode', 'localPublicKey', 'localKeyId', 'since'].includes(k));
  if (unknown !== undefined) throw new Error(`${file} is corrupt or invalid (unknown field "${unknown}"): ${FIX}`);
  if (raw.v !== 1 || raw.mode !== 'local' || typeof raw.localPublicKey !== 'string' || typeof raw.localKeyId !== 'string' || typeof raw.since !== 'number') {
    throw new Error(`${file} is corrupt or invalid (unexpected content): ${FIX}`);
  }
  let matches = false;
  try {
    matches = keyId(raw.localPublicKey) === raw.localKeyId;
  } catch {
    matches = false;
  }
  if (!matches) throw new Error(`${file} is corrupt or invalid (the key id does not match the public key): ${FIX}`);
  return { mode: 'local', localPublicKey: raw.localPublicKey, localKeyId: raw.localKeyId, since: raw.since };
}

export function modeFileContent(info: Extract<ModeInfo, { mode: 'local' }>): string {
  return `${JSON.stringify({ v: 1, mode: 'local', localPublicKey: info.localPublicKey, localKeyId: info.localKeyId, since: info.since }, null, 2)}\n`;
}

/** A cheap fingerprint of every file that decides what is allowed: the daemon reloads its network when it changes (a `policy allow` applies at once). */
export function policyFingerprint(configDir: string): string {
  const files = [policyModeFile(configDir), policyFiles(configDir, 'admin').policy, policyFiles(configDir, 'local').policy];
  return files
    .map((file) => {
      try {
        const s = statSync(file);
        return `${s.mtimeMs}:${s.size}:${s.ino}`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw e;
      }
    })
    .join('|');
}
