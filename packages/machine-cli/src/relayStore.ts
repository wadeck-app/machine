import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import { SECRETS_DIRNAME } from './paths.js';

// The relay token of this machine. It lives only in <configDir>/_secrets_/relay.json (mode 0600) and is never part of
// an error, a log line or a command answer: errors here name the file, never its content.

export interface RelayConfig {
  relayUrl: string;
  token: string;
  label: string;
  claimedAt: string;
}

export const relayFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'relay.json');

export function readRelayConfig(configDir: string): RelayConfig | undefined {
  const path = relayFile(configDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const corrupt = (why: string) => new Error(`${path} is corrupt or invalid (${why}): delete it and run \`machine join <code>\` again with a new code from the admin`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw corrupt('not a JSON object');
  const o = raw as Record<string, unknown>;
  for (const key of ['relayUrl', 'token', 'label', 'claimedAt'] as const) {
    if (typeof o[key] !== 'string') throw corrupt(`${key} is missing`);
  }
  if ((o.token as string).length === 0 || (o.relayUrl as string).length === 0) throw corrupt('relayUrl or token is empty');
  return { relayUrl: o.relayUrl as string, token: o.token as string, label: o.label as string, claimedAt: o.claimedAt as string };
}

/** Without `replace`, an existing relay.json is never overwritten (exclusive link, no check-then-write race). */
export function writeRelayConfig(configDir: string, config: RelayConfig, replace: boolean): void {
  const target = relayFile(configDir);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (replace) {
    writeFileAtomic(target, content, 0o600);
    return;
  }
  mkdirSync(join(configDir, SECRETS_DIRNAME), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${target} already exists: this machine already joined a relay; pass --force to replace it`);
    throw e;
  } finally {
    unlinkSync(temp);
  }
}
