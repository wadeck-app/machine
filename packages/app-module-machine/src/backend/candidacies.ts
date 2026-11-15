import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidacyCode, isUuid, machineNameProblem, tryKeyId } from '@wadeck-app/machine-core';
import { SECRETS_DIRNAME } from './configDir.js';

// Lists the pending candidacies with the full-access token of `machine admin login` (<configDir>/_secrets_/relay-admin.json,
// read at EVERY call). The relay is untrusted: the verification code is recomputed from the key and random AS RECEIVED, the
// code a relay may send is only compared, never shown. The token lives in local variables: never in a result, a log or an error.
//
// Copy of the minimal pure logic of machine-cli (adminApprove.ts `reviewCandidacy`, relayClient.ts `normalizeRelayUrl`,
// relayStore.ts `readRelayAdminConfig`): machine-cli exports none of them and this module must not widen it. Keep in step.
// Binding fields follow the deployed ownership-at-approval contract (uuidBound, boundTokenLabel, boundToCandidateToken), as in adminApprove.ts.

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;
// Same sentences as machine-cli fullAccess.ts (the two packages do not import each other).
const FULL_ACCESS_WHY = 'approving a machine needs a full-access relay token (the machines themselves only get a limited one)';
const FULL_ACCESS_CLICK_PATH = 'in the relay console open Tokens, Add token, WITHOUT "Limited to scopes"';
// The confirm-only login first (decision 58), the pairing code as the alternative.
const LOGIN_ADVICE = `run \`machine admin login --force\` and type the code it shows in the relay console (Tokens page, the request marked FULL ACCESS); or with a pairing code: ${FULL_ACCESS_CLICK_PATH}, then run \`machine admin login <code> --force\``;

/** There is no usable admin token on this machine: absent file, corrupt file, relay URL not acceptable. Status 503 for the page. */
export class RelayNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayNotConfiguredError';
  }
}

/** The relay was asked and did not give a usable answer. Status 0 means it was not reached at all. */
export class RelayRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RelayRequestError';
    this.status = status;
  }
}

export interface CandidacyListView {
  id: string;
  name: string;
  hostname: string;
  observedIp: string;
  uuid: string | undefined;
  createdAt: number;
  expiresAt: number;
  ageSeconds: number;
  /** The relay says the uuid is already bound to a token (approving replaces the binding). Absent: the relay did not say. */
  uuidBound: boolean | undefined;
  /** The token the uuid is bound to may be revoked: the relay then sends the label "(revoked token)". */
  boundTokenLabel: string | undefined;
  /** The uuid is bound to the token of THIS candidacy (a re-approval). Absent: the relay did not say, or sent a non-boolean. */
  boundToCandidateToken: boolean | undefined;
  /** Approving replaces a binding to ANOTHER token: `uuidBound && !boundToCandidateToken`. An unknown or invalid boundToCandidateToken is read as a rebind (safe reading). */
  rebind: boolean;
  /** Set when the rebind reading rests on a missing or invalid boundToCandidateToken. */
  bindingNote: string | undefined;
  /** Recomputed here from the key and random received, never taken from the relay. Absent when it cannot be computed. */
  code: string | undefined;
  /** Why this candidacy must not be approved (it can still be rejected). */
  problems: string[];
}

interface AdminConfig {
  relayUrl: string;
  token: string;
}

const adminFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'relay-admin.json');

function readAdminConfig(configDir: string): AdminConfig {
  const file = adminFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RelayNotConfiguredError(`this machine holds no admin relay token (no ${file}): ${FULL_ACCESS_WHY}. Run \`machine admin login\` and type the code it shows in the relay console (Tokens page, the request marked FULL ACCESS); or with a pairing code: ${FULL_ACCESS_CLICK_PATH}, then run \`machine admin login <code>\``);
    }
    throw new RelayNotConfiguredError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const corrupt = (why: string): RelayNotConfiguredError => new RelayNotConfiguredError(`${file} is corrupt or invalid (${why}): delete it and ${LOGIN_ADVICE}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw corrupt('not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o['relayUrl'] !== 'string' || o['relayUrl'].length === 0) throw corrupt('relayUrl is missing');
  if (typeof o['token'] !== 'string' || o['token'].length === 0) throw corrupt('token is missing');
  return { relayUrl: normalizeRelayUrl(o['relayUrl'], file), token: o['token'] };
}

function normalizeRelayUrl(input: string, file: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RelayNotConfiguredError(`the relay URL in ${file} is not a URL: ${LOGIN_ADVICE}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new RelayNotConfiguredError(`the relay URL in ${file} must use https (plain http is only accepted for 127.0.0.1 and localhost): the token is not sent; ${LOGIN_ADVICE}`);
  }
  return url.toString().replace(/\/+$/, '');
}

/** Text from the relay or the candidate is shown with printable ASCII only: no escape sequence reaches the page. */
const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');
// Fields in which a relay (or its web UI) might hand over a code of its own: compared, never trusted.
const RELAY_CODE_FIELDS = ['code', 'verificationCode', 'candidacyCode'];

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function review(raw: unknown, nowSeconds: number): CandidacyListView {
  const o = asObject(raw);
  const problems: string[] = [];
  const text = (key: string): string => {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0) {
      problems.push(`the relay sent no "${key}"`);
      return '';
    }
    return v;
  };
  const num = (key: string): number => {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push(`the relay sent no "${key}"`);
      return 0;
    }
    return v;
  };
  const id = text('id');
  const name = text('name');
  const hostname = typeof o['hostname'] === 'string' ? o['hostname'] : '';
  const identityPublicKey = text('identityPublicKey');
  const random = text('random');
  const observedIp = typeof o['observedIp'] === 'string' ? o['observedIp'] : '';
  const createdAt = num('createdAt');
  const expiresAt = num('expiresAt');

  if (name !== '') {
    const problem = machineNameProblem(name);
    if (problem) problems.push(`the machine name is invalid (${problem})`);
  }
  if (identityPublicKey !== '' && tryKeyId(identityPublicKey) === undefined) problems.push('identityPublicKey is not an Ed25519 public key');

  let code: string | undefined;
  if (identityPublicKey !== '' && random !== '') {
    try {
      code = candidacyCode(identityPublicKey, random);
    } catch (e) {
      problems.push(`the verification code cannot be computed from the key and random of the relay (${printable((e as Error).message)})`);
    }
  }
  for (const field of RELAY_CODE_FIELDS) {
    const given = o[field];
    if (typeof given === 'string' && code !== undefined && normalizeCode(given) !== normalizeCode(code)) {
      problems.push('the relay sent a verification code that does not match the key and random it sent: the relay is inconsistent or swapped the key; do NOT approve');
    }
  }

  let uuid: string | undefined;
  if (o['uuid'] === undefined) {
    problems.push('the candidacy carries no uuid (posted by an older `machine join`, or the relay dropped it): reject it, and ask the candidate to run `machine join --resume`');
  } else if (typeof o['uuid'] !== 'string' || !isUuid(o['uuid']) || o['uuid'] !== o['uuid'].toLowerCase()) {
    problems.push('the uuid sent by the relay is not a lower-case UUID');
  } else {
    uuid = o['uuid'];
  }
  let uuidBound: boolean | undefined;
  if (o['uuidBound'] !== undefined) {
    if (typeof o['uuidBound'] === 'boolean') uuidBound = o['uuidBound'];
    else problems.push('the relay sent an invalid "uuidBound" (not true or false): it may be an incompatible version');
  }
  let boundToCandidateToken: boolean | undefined;
  if (o['boundToCandidateToken'] !== undefined) {
    if (typeof o['boundToCandidateToken'] === 'boolean') boundToCandidateToken = o['boundToCandidateToken'];
    else problems.push('the relay sent an invalid "boundToCandidateToken" (not true or false): it may be an incompatible version');
  }
  const rebind = uuidBound === true && boundToCandidateToken !== true;
  const bindingNote = rebind && boundToCandidateToken === undefined ? 'the relay did not say whether the binding is for the token of this candidacy: read as a rebind' : undefined;
  const label = o['boundTokenLabel'];
  const boundTokenLabel = typeof label === 'string' && label.length > 0 ? printable(label) : undefined;
  if (expiresAt !== 0 && nowSeconds >= expiresAt) problems.push('this candidacy is expired: the candidate must post a new one (`machine join --resume`)');

  return {
    id: printable(id),
    name: printable(name),
    hostname: printable(hostname),
    observedIp: printable(observedIp),
    uuid,
    createdAt,
    expiresAt,
    ageSeconds: Math.max(0, nowSeconds - createdAt),
    uuidBound,
    boundTokenLabel,
    boundToCandidateToken,
    rebind,
    bindingNote,
    code,
    problems,
  };
}

async function readLimited(res: Response): Promise<string> {
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new RelayRequestError(res.status, 'the relay answer is larger than 1 MiB: refused');
  return text;
}

export async function listCandidacies(configDir: string, nowSeconds: number, doFetch: typeof fetch = globalThis.fetch): Promise<CandidacyListView[]> {
  const { relayUrl, token } = readAdminConfig(configDir);
  let res: Response;
  try {
    res = await doFetch(`${relayUrl}/api/machines/candidacies`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      // A redirect would carry the token to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // The message of a fetch failure never contains the request headers.
    throw new RelayRequestError(0, `the relay is unreachable at ${relayUrl} (${printable((e as Error).message)}): check the network and that the relay runs`);
  }
  const text = await readLimited(res);
  if (res.status === 401) {
    throw new RelayRequestError(401, `the relay refused the admin token (invalid or revoked): ${LOGIN_ADVICE}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (res.status !== 200) {
    const o = asObject(body);
    if (o['error'] === 'full_access_required') {
      throw new RelayRequestError(res.status, `the token saved by \`machine admin login\` is not a full-access token, so it cannot list candidacies (${FULL_ACCESS_WHY}). ${LOGIN_ADVICE.charAt(0).toUpperCase()}${LOGIN_ADVICE.slice(1)}`);
    }
    const why = typeof o['message'] === 'string' ? o['message'] : typeof o['error'] === 'string' ? o['error'] : 'no detail';
    throw new RelayRequestError(res.status, `the relay answered ${res.status} to the candidacy list (${printable(why)})`);
  }
  const list = asObject(body)['candidacies'];
  if (!Array.isArray(list)) throw new RelayRequestError(res.status, 'the relay answer has no "candidacies" list: it may be an incompatible version');
  return list.map((entry) => review(entry, nowSeconds));
}
