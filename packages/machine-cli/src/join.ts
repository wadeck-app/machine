import { hostname as osHostname } from 'node:os';
import { candidacyCode, newCandidacyRandom } from '@wadeck-app/machine-core';
import { exportMachineInfo } from './network.js';
import { createRelayClient, normalizeRelayUrl, type RelayClient } from './relayClient.js';
import { readRelayConfig, relayFile, writeRelayConfig } from './relayStore.js';

export interface JoinOptions {
  code: string;
  relayUrl: string;
  force: boolean;
  /** Tests inject a client; the default talks to the relay over the network. */
  client?: RelayClient;
  now?: () => Date;
  hostname?: () => string;
}

export interface JoinResult {
  relayUrl: string;
  label: string;
  name: string;
  candidacyId: string;
  /** Verification code, to compare with the one the admin sees (decision 35a). */
  verificationCode: string;
  expiresAt: number;
}

/** Printable ASCII only, 1 to 64 characters (relay-api.md field rules): the hostname is informative, never trusted. */
export function sanitizeHostname(raw: string): string {
  const clean = raw.replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 64);
  return clean.length > 0 ? clean : 'unknown';
}

/**
 * Claim the pairing code, store the machine token, then post this machine's candidacy. The identity is read first so
 * that a machine without identity does not burn a one-shot code.
 */
export async function joinRelay(configDir: string, options: JoinOptions): Promise<JoinResult> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  // Throws NotInitializedError with the fix when `machine init` was not run.
  const info = exportMachineInfo(configDir);
  if (readRelayConfig(configDir) !== undefined && !options.force) {
    throw new Error(`this machine already joined a relay (${relayFile(configDir)}): pass --force to replace it (the old token is then forgotten, not revoked: revoke it in the relay console)`);
  }

  const claimClient = options.client ?? createRelayClient({ baseUrl: relayUrl });
  const claimed = await claimClient.claimPairing(options.code);
  const claimedAt = (options.now?.() ?? new Date()).toISOString();
  writeRelayConfig(configDir, { relayUrl, token: claimed.token, label: claimed.label, claimedAt }, options.force);

  const client = options.client ?? createRelayClient({ baseUrl: relayUrl, token: claimed.token });
  const random = newCandidacyRandom();
  let posted;
  try {
    posted = await client.postCandidacy({
      name: info.name,
      hostname: sanitizeHostname((options.hostname ?? osHostname)()),
      identityPublicKey: info.identityPublicKey,
      random,
    });
  } catch (e) {
    throw new Error(`the token was claimed and saved in ${relayFile(configDir)}, but the candidacy could not be posted: ${(e as Error).message}. The code is used up: ask the admin for a new code and run \`machine join <code> --force\``);
  }
  return {
    relayUrl,
    label: claimed.label,
    name: info.name,
    candidacyId: posted.id,
    verificationCode: candidacyCode(info.identityPublicKey, random),
    expiresAt: posted.expiresAt,
  };
}
